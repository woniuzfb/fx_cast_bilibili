// @ts-check

import crypto from "node:crypto";
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
const manifestJson = JSON.parse(
    fs.readFileSync(`${srcPath}/manifest.json`, { encoding: "utf-8" })
);
const BRIDGE_VERSION = manifestJson.version;
const EXTENSION_ID = manifestJson.browser_specific_settings?.gecko?.id;

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

const AMO_API_PREFIX = "https://addons.mozilla.org/api/v4";
const RECOVERY_POLL_INTERVAL_MS = 30_000;
const RECOVERY_TIMEOUT_MS = 10 * 60_000;

/**
 * Thrown when the version exists at AMO but recovery cannot produce a
 * signed file right now (still processing, or awaiting manual review).
 * Carries a user-actionable message; unlike network errors this is not
 * worth silently swallowing in favor of the original signing error.
 */
class SigningRecoveryError extends Error {}

/**
 * HS256 JWT for the AMO API, mirroring what sign-addon's amo-client sends
 * ({iss, iat, exp} signed with the API secret as the HMAC key).
 *
 * @param {string} apiKey
 * @param {string} apiSecret
 * @returns {string}
 */
function createAmoAuthToken(apiKey, apiSecret) {
    const encodePart = value =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encodePart({ alg: "HS256", typ: "JWT" });
    const now = Math.floor(Date.now() / 1000);
    const payload = encodePart({ iss: apiKey, iat: now, exp: now + 300 });
    const signature = crypto
        .createHmac("sha256", apiSecret)
        .update(`${header}.${payload}`)
        .digest("base64url");
    return `${header}.${payload}.${signature}`;
}

/**
 * GET the AMO version status — the same URL web-ext PUTs the upload to
 * and then polls. 404 means the version was never created (the failure
 * happened before/during upload), so there is nothing to recover.
 *
 * @param {{ apiKey: string, apiSecret: string, version: string }} args
 * @returns {Promise<{ status: number, body: object }>}
 */
async function fetchAmoVersionStatus({ apiKey, apiSecret, version }) {
    const versionUrl =
        `${AMO_API_PREFIX}/addons/${encodeURIComponent(EXTENSION_ID ?? "")}` +
        `/versions/${encodeURIComponent(version)}/`;
    const res = await fetch(versionUrl, {
        headers: {
            Authorization: `JWT ${createAmoAuthToken(apiKey, apiSecret)}`,
            Accept: "application/json"
        }
    });
    return { status: res.status, body: res.ok ? await res.json() : {} };
}

/**
 * Download the signed files AMO lists for the version into downloadDir.
 * Mirrors sign-addon's downloadSignedFiles: only files flagged `signed`
 * are fetched, named after the download URL's basename.
 *
 * @param {{ apiKey: string, apiSecret: string }} args
 * @param {Array<{ signed: boolean, download_url: string }>} files
 * @param {string} downloadDir
 * @returns {Promise<{ downloadedFiles: string[] }>}
 */
async function downloadAmoSignedFiles({ apiKey, apiSecret }, files, downloadDir) {
    const signedFiles = files.filter(file => file.signed);
    if (signedFiles.length === 0) {
        throw new Error(
            "AMO processed the version but returned no signed files"
        );
    }

    const downloadedFiles = [];
    for (const file of signedFiles) {
        const fileUrl = file.download_url.startsWith("http")
            ? file.download_url
            : `https://addons.mozilla.org${file.download_url}`;
        const res = await fetch(fileUrl, {
            headers: {
                Authorization: `JWT ${createAmoAuthToken(apiKey, apiSecret)}`
            }
        });
        if (!res.ok) {
            throw new Error(
                `Downloading ${fileUrl} failed with status ${res.status}`
            );
        }
        const fileName = path.join(
            downloadDir,
            path.basename(new URL(fileUrl).pathname)
        );
        fs.writeFileSync(fileName, Buffer.from(await res.arrayBuffer()));
        downloadedFiles.push(fileName);
    }
    return { downloadedFiles };
}

/**
 * Recover a signed xpi from a version that was already uploaded to AMO.
 *
 * This handles the failure mode where the upload succeeded but the
 * process died before downloading the signed file (e.g. network drop
 * while waiting for approval). Every later signing attempt for the same
 * version is rejected by AMO with "Version already exists", so the only
 * way forward is to fetch the already-signed file from the API.
 *
 * @param {{ apiKey: string, apiSecret: string, version: string, downloadDir: string }} args
 * @returns {Promise<{ downloadedFiles: string[] } | null>} null when the
 * version does not exist at AMO (nothing to recover)
 */
async function recoverSignedXpiFromAmo({ apiKey, apiSecret, version, downloadDir }) {
    const deadline = Date.now() + RECOVERY_TIMEOUT_MS;

    for (let attempt = 0; ; attempt++) {
        if (attempt > 0) {
            await new Promise(resolve =>
                setTimeout(resolve, RECOVERY_POLL_INTERVAL_MS)
            );
        }

        const { status, body } = await fetchAmoVersionStatus({
            apiKey,
            apiSecret,
            version
        });

        if (status === 404) {
            return null;
        }
        if (status !== 200) {
            throw new Error(`AMO version API returned status ${status}`);
        }

        if (body.valid === false) {
            console.warn(
                "Version failed AMO validation:",
                body.validation_url ?? "(no validation URL returned)"
            );
            return null;
        }

        // Mirrors sign-addon's waitForSignedAddon readiness check.
        const ready =
            body.valid &&
            body.active &&
            body.reviewed &&
            Array.isArray(body.files) &&
            body.files.length > 0;

        if (ready) {
            return await downloadAmoSignedFiles(
                { apiKey, apiSecret },
                body.files,
                downloadDir
            );
        }

        if (body.valid === true && body.automated_signing === false) {
            throw new SigningRecoveryError(
                `Version ${version} was submitted to AMO but requires ` +
                    `manual review, so it cannot be signed automatically. ` +
                    `Check https://addons.mozilla.org/developers/ for the ` +
                    `review status.`
            );
        }

        if (Date.now() >= deadline) {
            throw new SigningRecoveryError(
                `Version ${version} was submitted to AMO but is still ` +
                    `being processed after ` +
                    `${RECOVERY_TIMEOUT_MS / 60_000} minutes. The version ` +
                    `number is consumed at AMO: once processing finishes, ` +
                    `re-run this job (re-push the tag) and the signed file ` +
                    `will be downloaded instead of re-signed.`
            );
        }

        console.info(
            `Version ${version} exists at AMO but is not ready yet; ` +
                `re-checking in ${RECOVERY_POLL_INTERVAL_MS / 1000}s...`
        );
    }
}

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
 * @param {{ apiKey: string, apiSecret: string, version: string, downloadDir: string }} recovery
 */
async function signWithRetry(options, recovery) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await webExt.cmd.sign(options, {
                // Prevent auto-exit
                shouldExitProgram: false
            });
        } catch (err) {
            const delay = SIGN_RETRY_DELAYS_MS[attempt];
            if (delay === undefined || !isTransientSigningError(err)) {
                // Permanent failure, or transient retries exhausted. A
                // previous attempt may have already uploaded the version
                // to AMO before dying (e.g. a network drop while waiting
                // for approval) — every re-upload is then rejected with
                // "Version already exists". Try to recover by fetching
                // the signed file straight from the AMO API.
                console.warn(
                    "Signing failed; checking AMO for an existing version...",
                    {
                        error: err instanceof Error ? err.message : String(err)
                    }
                );
                try {
                    const recovered = await recoverSignedXpiFromAmo(recovery);
                    if (recovered) {
                        console.info(
                            "Recovered the signed xpi from AMO instead of re-signing"
                        );
                        return recovered;
                    }
                } catch (recoveryError) {
                    if (recoveryError instanceof SigningRecoveryError) {
                        throw recoveryError;
                    }
                    console.error(
                        "AMO recovery check failed:",
                        recoveryError instanceof Error
                            ? recoveryError.message
                            : String(recoveryError)
                    );
                }
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

            signWithRetry(
                {
                    apiKey,
                    apiSecret,
                    sourceDir: unpackedPath,
                    artifactsDir: signedPath,
                    // Self-distributed add-on, not listed on AMO
                    channel: "unlisted",
                    overwriteDest: true
                },
                {
                    apiKey,
                    apiSecret,
                    version: BRIDGE_VERSION,
                    downloadDir: signedPath
                }
            )
                .then(
                    /** @param {{ downloadedFiles: string[] }} result */
                    result => {
                        // downloadedFiles entries are absolute paths
                        for (const file of result.downloadedFiles ?? []) {
                            console.info(`Signed extension: ${file}`);
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
