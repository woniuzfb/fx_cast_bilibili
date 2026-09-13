#!/usr/bin/env node
"use strict";

/**
 * Installs a native-messaging manifest for the harness.
 *
 * Why this is needed at all, and why it is user-level:
 *
 *   - The repo's dev build (`npm run build:bridge`) already emits a manifest at
 *     dist/bridge/<name>.json pointing at its launcher script, but Firefox does
 *     not read manifests from there.
 *   - The machine this repo is developed on also has a SYSTEM manifest
 *     (/Library/Application Support/Mozilla/NativeMessagingHosts/) owned by
 *     root, pointing at an installed standalone binary built from an older
 *     commit. Replacing it needs admin rights, and testing the harness against
 *     a stale host would be meaningless anyway.
 *   - Mozilla also reads a per-user directory, which needs no privileges, so
 *     the harness installs there. The manifest points at the WRAPPER, not at the
 *     host, because the wrapper is what makes both connections observable.
 *
 * Whether a user-level manifest actually takes precedence over the system one
 * is not assumed here: `runFirefox.js` proves it by checking whether the wrapper
 * was spawned at all, and reports which of the two Firefox used when it can.
 *
 * The wrapper's trace directory is NOT part of the manifest: Firefox passes its
 * own environment to native hosts, so runFirefox.js exports FX_HARNESS_DIR when
 * it launches the browser (see hostWrapper.js for the fallback).
 *
 * Usage:
 *   node test/integration/installManifest.js [--name <host name>] [--remove]
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const repoRoot = path.resolve(__dirname, "../..");
const bridgeConfig = require(path.join(repoRoot, "dist/bridge/config.json"));
const defaultName = bridgeConfig.applicationName;

/** The per-user directory Mozilla reads, by platform. */
function userManifestDir() {
    if (process.platform === "darwin") {
        return path.join(
            os.homedir(),
            "Library/Application Support/Mozilla/NativeMessagingHosts"
        );
    }
    if (process.platform === "linux") {
        return path.join(os.homedir(), ".mozilla/native-messaging-hosts");
    }
    throw new Error(
        `installManifest: unsupported platform ${process.platform} (Windows uses the registry)`
    );
}

/** The system-wide directory, used only to report a precedence conflict. */
function systemManifestDir() {
    if (process.platform === "darwin") {
        return "/Library/Application Support/Mozilla/NativeMessagingHosts";
    }
    if (process.platform === "linux") {
        return "/usr/lib/mozilla/native-messaging-hosts";
    }
    return undefined;
}

function parseArgs(argv) {
    const args = { name: defaultName, remove: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--remove") args.remove = true;
        else if (arg === "--name") args.name = argv[++i];
        else throw new Error(`installManifest: unknown argument ${arg}`);
    }
    return args;
}

function manifestFor(name) {
    return {
        name,
        description: "fx_cast integration harness wrapper",
        type: "stdio",
        allowed_extensions: [bridgeConfig.extensionId],
        path: path.join(__dirname, "hostWrapper.js")
    };
}

function install({ name }) {
    const manifestDir = userManifestDir();
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, `${name}.json`);
    const wanted = JSON.stringify(manifestFor(name), null, 4);
    // Idempotent on purpose: the directory lives outside the working tree, and
    // a run that only needs to READ what is already installed should not have
    // to write there at all.
    let unchanged = false;
    if (fs.existsSync(manifestPath)) {
        unchanged = fs.readFileSync(manifestPath, "utf8") === wanted;
        if (unchanged) {
            const systemDir = systemManifestDir();
            const systemPath = systemDir
                ? path.join(systemDir, `${name}.json`)
                : undefined;
            return { manifestPath, unchanged, conflict: undefined, systemPath };
        }
    }
    fs.writeFileSync(manifestPath, wanted);

    // Report a conflicting system manifest, since that is the one failure this
    // design cannot rule out from the outside.
    const systemDir = systemManifestDir();
    const systemPath = systemDir
        ? path.join(systemDir, `${name}.json`)
        : undefined;
    let conflict;
    if (systemPath && fs.existsSync(systemPath)) {
        try {
            const systemManifest = JSON.parse(fs.readFileSync(systemPath, "utf8"));
            conflict = { path: systemPath, target: systemManifest.path };
        } catch (err) {
            conflict = { path: systemPath, error: String(err) };
        }
    }
    return { manifestPath, conflict };
}

function remove({ name }) {
    const manifestPath = path.join(userManifestDir(), `${name}.json`);
    if (!fs.existsSync(manifestPath)) return [];
    fs.rmSync(manifestPath);
    return [manifestPath];
}

if (require.main === module) {
    const args = parseArgs(process.argv.slice(2));
    if (args.remove) {
        console.log("removed:", remove(args));
    } else {
        const { manifestPath, conflict } = install(args);
        console.log("installed:", manifestPath);
        if (conflict) {
            console.log("WARNING: a system manifest with the same name exists:");
            console.log("        ", JSON.stringify(conflict));
            console.log(
                "         If the wrapper never spawns, the system one is winning;"
            );
            console.log(
                "         the harness then needs a distinct host name (see README)."
            );
        }
    }
}

module.exports = {
    install,
    remove,
    userManifestDir,
    systemManifestDir,
    defaultName
};
