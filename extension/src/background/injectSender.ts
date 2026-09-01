import logger from "../lib/logger";

/**
 * Inject a bundled sender script file into a tab, tolerating the transient
 * "Unable to load script: moz-extension://.../cast/senders/*.js" failure.
 *
 * Background:
 *   `scripting.executeScript({ files: [...] })` rejects with that message when
 *   the target frame is momentarily not injectable even though the file exists
 *   and a `func` probe just succeeded — most commonly right after a long-idle
 *   tab is restored from the back/forward cache (bfcache) or while the frame is
 *   mid-navigation. The immediately preceding `func`-based probe can succeed
 *   while the very next file injection fails, because file injection touches a
 *   different code path (loading a script resource into the frame) than an
 *   inline function.
 *
 *   Symptom for the user: the sender never initializes, so it never calls
 *   requestSession and the popup hangs on "Preparing receiver selector...".
 *
 * Fix: retry the file injection a couple of times with a short backoff. A tab
 * that just came out of bfcache/navigation becomes injectable within a few
 * hundred ms, so one or two retries recover it without a visible stall. On
 * final failure the ORIGINAL error is rethrown (and logged in full) so the
 * real cause is never masked by a generic message.
 */
export async function injectSenderFile(
    tabId: number,
    file: string,
    opts: { retries?: number; backoffMs?: number } = {}
): Promise<browser.scripting.InjectionResult[]> {
    const retries = opts.retries ?? 3;
    const backoffMs = opts.backoffMs ?? 150;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await browser.scripting.executeScript({
                target: { tabId },
                files: [file]
            });
        } catch (err) {
            lastError = err;
            const message = err instanceof Error ? err.message : String(err);
            // Only the transient "Unable to load script" failure is worth
            // retrying. Other errors fail the same way every time, so stop
            // immediately rather than backing off pointlessly.
            const isTransient = /unable to load script/i.test(message);
            logger.info("sender file injection attempt failed", {
                tabId,
                file,
                attempt,
                retries,
                isTransient,
                message
            });
            if (!isTransient) break;
            if (attempt < retries) {
                // Linear backoff (150ms, 300ms, 450ms): a bfcache/navigation
                // frame settles well within these bounds.
                await new Promise(resolve =>
                    setTimeout(resolve, backoffMs * (attempt + 1))
                );
                continue;
            }
        }
    }
    logger.error("sender file injection failed after retries", {
        tabId,
        file,
        error:
            lastError instanceof Error
                ? lastError.stack ?? lastError.message
                : String(lastError)
    });
    throw lastError;
}
