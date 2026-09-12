/**
 * shared/rokuMediaStatusProvenance.d.ts — how a Roku device media status was
 * produced.
 *
 * `main:receiverDeviceMediaStatusUpdated` is NOT an ECP observation feed. Its
 * documentation used to claim it fires "whenever a MEDIA_STATUS message is
 * received", but RokuRemote emits it from seven call sites, only one of which
 * performs a fresh ECP media-player query. The rest synthesize state or
 * rebroadcast the cached one, and — critically — `command-echo` rebroadcasts
 * the play/pause intent the bridge just wrote after a keypress, which satisfies
 * every weak correlation condition (arrives after the dispatch, matches the
 * command, carries the requested state). A consumer that treats the message as
 * an observation would therefore confirm its own command.
 *
 * So every emission carries its provenance, and only `ecp-poll` may be used to
 * confirm receiver state.
 *
 * A `.d.ts`, like shared/pongReport.d.ts, because a real `.ts` outside bridge/
 * would be pulled into the bridge's tsc program, emitted, and shift its
 * inferred rootDir to the repo root (moving dist/app/src/main.js).
 */

export type RokuMediaStatusSource =
    /** A fresh /query/media-player sample. The only confirmable source. */
    | "ecp-poll"
    /** Rebroadcast of the intent a PLAY/PAUSE keypress just wrote. */
    | "command-echo"
    /** Rebroadcast after a seek relaunch wrote state/position locally. */
    | "seek-echo"
    /** Rebroadcast after a volume key changed only the volume. */
    | "volume-key-echo"
    /** Rebroadcast on a GET_STATUS request, without a new ECP query. */
    | "status-probe"
    /**
     * Rebroadcast because session media changed. Does NOT modify the player
     * state, and still performs no ECP query.
     */
    | "session-media-refresh"
    /** The HLS DVR startup synthesis that turned idle into buffering. */
    | "startup-synthetic";

/**
 * Poll metadata, present only for `ecp-poll`.
 *
 * The discriminated union is deliberate: a synthetic source cannot claim poll
 * timings, and an ECP poll cannot omit them. `pollStartedAt` is what makes a
 * sample causally usable — a sample whose poll STARTED before a command was
 * dispatched may still arrive after it, and must not confirm that command.
 */
export type RokuMediaStatusProvenance =
    | {
          source: "ecp-poll";
          pollStartedAt: number;
          pollCompletedAt: number;
          sequence: number;
      }
    | {
          source: Exclude<RokuMediaStatusSource, "ecp-poll">;
      };
