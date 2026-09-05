/**
 * Roku device discovery via SSDP.
 *
 * Roku devices announce and answer M-SEARCH on the `roku:ecp` search target
 * over UDP port 1900. Unlike the QuickCast reference (a Chrome MV3 extension
 * that cannot send UDP multicast and therefore sweeps subnets), the bridge
 * owns real sockets, so the standard SSDP discovery is used here:
 *
 *   - An M-SEARCH for `roku:ecp` is re-sent periodically; each unicast
 *     response carries a `LOCATION: http://<ip>:8060/` header.
 *   - `ssdp:alive` NOTIFY datagrams advertise new devices; `ssdp:byebye`
 *     announces departures.
 *   - Known devices are additionally health-checked with a cheap
 *     /query/device-info poll; a device that stops answering is dropped
 *     (covers ungraceful departures that never send byebye).
 */
import { EventEmitter } from "events";
import dgram from "dgram";
import os from "os";
import type { NetworkInterfaceInfoIPv4 } from "node:os";

import type { ReceiverDevice } from "../../messagingTypes";

import { queryDeviceInfo, ROKU_PORT } from "./ecp";

const SSDP_MULTICAST_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;

const SEARCH_INTERVAL_MS = 20000;
/** Re-issue the M-SEARCH every interval; devices failing this many
 * consecutive health probes are considered gone. */
const HEALTH_PROBE_INTERVAL_MS = 15000;
const HEALTH_PROBE_MAX_FAILURES = 3;

const MSEARCH_TEMPLATE = [
    "M-SEARCH * HTTP/1.1",
    `HOST: ${SSDP_MULTICAST_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    "MX: 3",
    "ST: %{st}",
    "",
    ""
].join("\r\n");

const SEARCH_TARGETS = ["roku:ecp", "ssdp:all"];

/** Location header -> host. */
function parseLocationHost(location: string): string | undefined {
    try {
        return new URL(location).hostname;
    } catch {
        return undefined;
    }
}

interface KnownDevice {
    device: ReceiverDevice;
    failedProbes: number;
}

export default class RokuDeviceBrowser extends EventEmitter<{
    deviceUp: [device: ReceiverDevice];
    deviceDown: [deviceId: string];
}> {
    private socket?: dgram.Socket;
    private hasMulticastBind = false;
    private devices = new Map<string, KnownDevice>();
    private searchTimer?: NodeJS.Timeout;
    private healthTimer?: NodeJS.Timeout;
    private stopped = false;
    private inFlightProbes = new Set<string>();

    start() {
        this.stopped = false;
        this.openSocket();
        this.search();
        this.searchTimer = setInterval(() => this.search(), SEARCH_INTERVAL_MS);
        this.healthTimer = setInterval(
            () => void this.healthCheck(),
            HEALTH_PROBE_INTERVAL_MS
        );
    }

    stop() {
        this.stopped = true;
        if (this.searchTimer) clearInterval(this.searchTimer);
        if (this.healthTimer) clearInterval(this.healthTimer);
        this.searchTimer = undefined;
        this.healthTimer = undefined;
        this.socket?.close();
        this.socket = undefined;
        this.devices.clear();
    }

    private openSocket() {
        const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

        socket.on("error", () => {
            // Multicast membership/bind failures are non-fatal: unicast
            // M-SEARCH responses still arrive on the bound (ephemeral) port.
        });

        socket.on("message", (buffer, rinfo) => {
            this.onDatagram(buffer.toString("utf8"), rinfo.address);
        });

        socket.bind(() => {
            if (this.stopped) {
                socket.close();
                return;
            }

            try {
                // Listen for NOTIFY alive/byebye datagrams. Requires binding
                // port 1900 to actually receive the multicast stream; when
                // another SSDP daemon owns the port the membership add is
                // harmless but notifications won't arrive — discovery then
                // relies solely on M-SEARCH responses.
                socket.addMembership(
                    SSDP_MULTICAST_ADDRESS,
                    pickMulticastInterface()
                );
                this.hasMulticastBind = true;
            } catch {
                this.hasMulticastBind = false;
            }
        });

        this.socket = socket;
    }

    /** Sends M-SEARCH on every active interface so multi-homed hosts
     * (VPN, docked NICs) still reach their local subnet. */
    private search() {
        const socket = this.socket;
        if (!socket || this.stopped) return;

        for (const st of SEARCH_TARGETS) {
            const packet = Buffer.from(MSEARCH_TEMPLATE.replace("%{st}", st));
            const addresses = [SSDP_MULTICAST_ADDRESS];
            if (!this.hasMulticastBind) {
                // Without a multicast-bound socket, also probe each
                // interface's subnet broadcast address as a fallback path
                // (some routers drop multicast between wired/wireless
                // bridges but pass directed broadcast).
                for (const address of Object.values(os.networkInterfaces())) {
                    for (const entry of address ?? []) {
                        // `broadcast` exists on IPv4 entries at runtime but
                        // is missing from the node types.
                        const broadcast = (
                            entry as NetworkInterfaceInfoIPv4 & {
                                broadcast?: string;
                            }
                        ).broadcast;
                        if (
                            entry.family === "IPv4" &&
                            !entry.internal &&
                            broadcast
                        ) {
                            addresses.push(broadcast);
                        }
                    }
                }
            }

            for (const address of addresses) {
                socket.send(
                    packet,
                    0,
                    packet.length,
                    SSDP_PORT,
                    address,
                    () => {
                        // Fire-and-forget; responses arrive on "message".
                    }
                );
            }
        }
    }

    private onDatagram(message: string, sourceAddress: string) {
        // Only SSDP datagrams for Roku targets are relevant.
        if (
            !/^(HTTP\/1\.\d 200 OK|M-SEARCH \* HTTP)/im.test(message) &&
            !/NOTIFY \* HTTP/i.test(message)
        ) {
            return;
        }
        if (!/roku/i.test(message)) return;

        const isBye = /ssdp:byebye/i.test(message);
        const location = /^LOCATION:\s*(.+)\r?$/im.exec(message)?.[1]?.trim();
        const host = location
            ? parseLocationHost(location)
            : // Some devices omit LOCATION on byes; fall back to the packet's
              // source address.
              sourceAddress;

        if (!host) return;

        if (isBye) {
            this.dropByHost(host);
            return;
        }

        void this.probe(host);
    }

    /** Queries /query/device-info and emits deviceUp when a Roku answers. */
    private async probe(host: string) {
        if (this.inFlightProbes.has(host)) return;
        this.inFlightProbes.add(host);

        try {
            const info = await queryDeviceInfo(host);
            if (this.stopped) return;

            const deviceId = `roku-${info.serialNumber ?? host}`;
            const existing = this.devices.get(deviceId);

            const device: ReceiverDevice = {
                id: deviceId,
                friendlyName: info.friendlyName,
                modelName: info.modelName,
                capabilities: 1 | 4, // VIDEO_OUT | AUDIO_OUT
                host,
                port: ROKU_PORT,
                deviceType: "roku"
            };

            this.devices.set(deviceId, {
                device,
                failedProbes: 0
            });

            if (!existing) {
                this.emit("deviceUp", device);
            } else if (existing.device.host !== host) {
                // Device moved to a new address: treat as down+up so the
                // extension updates its stored host/port.
                this.emit("deviceDown", deviceId);
                this.emit("deviceUp", device);
            }
        } catch {
            // Not a Roku (or temporarily unreachable). Nothing to emit.
        } finally {
            this.inFlightProbes.delete(host);
        }
    }

    private dropByHost(host: string) {
        for (const [deviceId, known] of this.devices) {
            if (known.device.host === host) {
                this.devices.delete(deviceId);
                this.emit("deviceDown", deviceId);
            }
        }
    }

    /** Drops devices that stopped answering device-info probes. */
    private async healthCheck() {
        for (const [deviceId, known] of [...this.devices]) {
            const host = known.device.host;
            if (this.inFlightProbes.has(host)) continue;
            this.inFlightProbes.add(host);

            try {
                await queryDeviceInfo(host, 4000);
                if (this.stopped) return;
                known.failedProbes = 0;
            } catch {
                if (this.stopped) return;
                known.failedProbes++;
                if (known.failedProbes >= HEALTH_PROBE_MAX_FAILURES) {
                    this.devices.delete(deviceId);
                    this.emit("deviceDown", deviceId);
                }
            } finally {
                this.inFlightProbes.delete(host);
            }
        }
    }
}

/** Best-effort multicast interface pick: prefer the default route's
 * interface so addMembership doesn't throw on multi-homed hosts. */
function pickMulticastInterface(): string | undefined {
    let fallback: string | undefined;
    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const entry of addresses ?? []) {
            if (entry.family !== "IPv4" || entry.internal) continue;
            if (entry.mac === "00:00:00:00:00:00") continue;
            if (!fallback) fallback = entry.address;
        }
    }
    return fallback;
}
