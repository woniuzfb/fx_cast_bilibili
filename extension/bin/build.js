// @ts-check

import fs from "fs-extra";
import path from "path";
import url from "url";

import esbuild from "esbuild";
import sveltePlugin from "esbuild-svelte";
import sveltePreprocess from "svelte-preprocess";
import yargs from "yargs";
import webExt from "web-ext";

import copyFilesPlugin from "./lib/copyFilesPlugin.js";

const BRIDGE_NAME = "fx_cast_bilibili_bridge";

const MIRRORING_APP_ID = "19A6F4AE";

const argv = yargs()
    .help()
    .version(false)
    .option("watch", {
        describe: "Rebuild on changes",
        type: "boolean"
    })
    .option("package", {
        describe: "Package with web-ext",
        type: "boolean",
        conflicts: "watch"
    })
    .option("sign", {
        describe:
            "Package and sign with web-ext (requires WEB_EXT_API_KEY / WEB_EXT_API_SECRET env vars)",
        type: "boolean",
        conflicts: ["watch", "package"]
    })
    .option("mode", {
        describe: "Set build mode",
        choices: ["development", "production"],
        default: "development"
    })
    .parseSync(process.argv);

// If packaging or signing, use production mode
if (argv.package || argv.sign) {
    argv.mode = "production";
}

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Paths
const rootPath = path.join(__dirname, "../");
const srcPath = path.join(rootPath, "src");

// Single source of truth for the version: the extension manifest
// (kept in sync with bridge/config.json's applicationVersion).
const BRIDGE_VERSION = JSON.parse(
    fs.readFileSync(`${srcPath}/manifest.json`, { encoding: "utf-8" })
).version;

const distPath = path.join(rootPath, "../dist/extension/");
const unpackedPath = path.join(distPath, "unpacked");

const outPath = argv.package || argv.sign ? unpackedPath : distPath;

/** @type esbuild.BuildOptions */
const buildOpts = {
    bundle: true,
    target: "firefox109",
    logLevel: "info",
    sourcemap: "inline",

    outdir: outPath,
    outbase: srcPath,

    entryPoints: [
        // Main
        path.join(srcPath, "background/background.ts"),
        // Cast
        path.join(srcPath, "cast/content.ts"),
        path.join(srcPath, "cast/contentInitial.ts"),
        path.join(srcPath, "cast/contentBridge.ts"),
        // Media senders
        path.join(srcPath, "cast/senders/media.ts"),
        path.join(srcPath, "cast/senders/bilibili.ts"),
        // Mirroring sender
        path.join(srcPath, "/cast/senders/mirroring.ts"),
        // UI
        path.join(srcPath, "ui/popup/index.ts"),
        path.join(srcPath, "ui/mirroring/index.ts"),
        path.join(srcPath, "ui/options/index.ts")
    ],
    define: {
        BRIDGE_NAME: `"${BRIDGE_NAME}"`,
        BRIDGE_VERSION: `"${BRIDGE_VERSION}"`,
        MIRRORING_APP_ID: `"${MIRRORING_APP_ID}"`
    },
    plugins: [
        // @ts-ignore
        sveltePlugin({
            // @ts-ignore
            preprocess: sveltePreprocess()
        }),

        // Copy static files
        copyFilesPlugin({
            src: srcPath,
            dest: outPath,
            excludePattern: /^(manifest\.json|.*\.(ts|js|svelte))$/
        }),

        // Write manifest after each build
        {
            name: "write-manifest",
            setup(build) {
                build.onEnd(result => {
                    if (result.errors.length) {
                        console.error("Build error!");
                        return;
                    }

                    const manifest = JSON.parse(
                        fs.readFileSync(`${srcPath}/manifest.json`, {
                            encoding: "utf-8"
                        })
                    );

                    // In development, allow eval for source maps
                    if (argv.mode !== "production") {
                        manifest.content_security_policy = {
                            extension_pages:
                                "script-src 'self' 'unsafe-eval'; object-src 'self'"
                        };
                    }

                    fs.writeFileSync(
                        `${outPath}/manifest.json`,
                        JSON.stringify(manifest)
                    );
                });
            }
        }
    ]
};

// Set production options
if (argv.mode === "production") {
    buildOpts.minify = true;
    buildOpts.sourcemap = false;
}

// Clean
fs.removeSync(distPath);

const SIGN_RETRY_DELAYS_MS = [30_000, 90_000, 180_000];

/**
 * AMO signing failures come in two flavors: transient server/network
 * trouble (HTTP 429/5xx, connection resets) worth a backed-off retry,
 * and permanent rejections (auth, validation, ID ownership, version
 * conflicts) where retrying would only spam AMO — and for a submitted
 * version can never succeed ("Version already exists"). web-ext wraps
 * every error in WebExtError, so classify by message.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isTransientSigningError(err) {
    const message = err instanceof Error ? err.message : String(err);

    // Node network-layer errors are always worth retrying.
    if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE/.test(message)) {
        return true;
    }

    // AMO embeds "status: <code>" in its error messages.
    const statusMatch = message.match(/status: (\d{3})/);
    if (statusMatch) {
        const status = Number(statusMatch[1]);
        return status === 429 || status >= 500;
    }

    return /too many requests/i.test(message);
}

/**
 * @param {import("web-ext").SignOptions} options
 */
async function signWithRetry(options) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await webExt.cmd.sign(options, {
                // Prevent auto-exit
                shouldExitProgram: false
            });
        } catch (err) {
            const delay = SIGN_RETRY_DELAYS_MS[attempt];
            if (delay === undefined || !isTransientSigningError(err)) {
                throw err;
            }

            console.warn(
                `Signing failed with a transient error; retrying in ${
                    delay / 1000
                }s`,
                {
                    attempt: attempt + 1,
                    error: err instanceof Error ? err.message : String(err)
                }
            );
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

if (argv.watch) {
    const ctx = await esbuild.context(buildOpts);
    await ctx.watch();
    console.info("Watching for changes...");
} else {
    esbuild.build(buildOpts).then(() => {
        if (argv.sign) {
            const signedPath = path.join(distPath, "signed");
            fs.ensureDirSync(signedPath);

            // webExt.cmd.sign is the programmatic API and, unlike the CLI
            // (--api-key/--api-secret), does not read these env vars itself.
            const apiKey = process.env.WEB_EXT_API_KEY;
            const apiSecret = process.env.WEB_EXT_API_SECRET;
            if (!apiKey || !apiSecret) {
                console.error(
                    "Signing requires WEB_EXT_API_KEY and WEB_EXT_API_SECRET env vars"
                );
                fs.remove(unpackedPath);
                process.exitCode = 1;
                return;
            }

            signWithRetry({
                apiKey,
                apiSecret,
                sourceDir: unpackedPath,
                artifactsDir: signedPath,
                // Self-distributed add-on, not listed on AMO
                channel: "unlisted",
                overwriteDest: true
            })
                .then(
                    /** @param {{ downloadedFiles: string[] }} result */
                    result => {
                        for (const file of result.downloadedFiles ?? []) {
                            console.info(
                                `Signed extension: ${path.join(signedPath, file)}`
                            );
                        }

                        // Only need the signed extension archive
                        fs.remove(unpackedPath);
                    }
                )
                .catch(err => {
                    console.error("Signing failed!", err);
                    fs.remove(unpackedPath);
                    process.exitCode = 1;
                });

            return;
        }

        if (argv.package) {
            webExt.cmd
                .build(
                    {
                        /**
                         * Webpack output at sourceDir is built into an extension
                         * archive at artifactsDir.
                         */
                        sourceDir: unpackedPath,
                        artifactsDir: distPath,
                        overwriteDest: true
                    },
                    {
                        // Prevent auto-exit
                        shouldExitProgram: false
                    }
                )
                .then(
                    /** @param {{ extensionPath: string }} result */
                    result => {
                        const outputName = path.basename(result.extensionPath);

                        // Rename output extension to XPI
                        fs.moveSync(
                            path.join(distPath, outputName),
                            path.join(
                                distPath,
                                outputName.replace("zip", "xpi")
                            )
                        );

                        // Only need the built extension archive
                        fs.remove(unpackedPath);
                    }
                );
        }
    });
}
