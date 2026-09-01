/**
 * Flatten `scripting.executeScript` results for logging.
 *
 * `executeScript({files:[...]})` resolves with an InjectionResult[] even when a
 * script fails to load/evaluate in the page — the real reason is tucked into
 * each result's `error` field, and the browser console prints nested arrays
 * collapsed as `Array [ {…} ]`, hiding it. Return a SINGLE flat object whose
 * values are primitives (a count plus one compact string per result) so the
 * whole trail — frameId, whether a result was produced, and the error
 * message — renders inline in the console preview.
 */
export function flattenInjectionResults(
    results: unknown
): Record<string, unknown> {
    if (!Array.isArray(results)) {
        return { note: "not an array", raw: String(results) };
    }
    const entries = results.map((entry, index) => {
        const r = (entry ?? {}) as Record<string, unknown>;
        const err = r.error as
            | { message?: string; name?: string; stack?: string }
            | string
            | undefined
            | null;
        const parts = [
            `frameId=${r.frameId}`,
            r.result !== undefined && r.result !== null
                ? "hasResult=true"
                : "hasResult=false"
        ];
        if (err !== undefined && err !== null) {
            parts.push(
                `error=${
                    typeof err === "string" ? err : err.message ?? String(err)
                }`
            );
        }
        return `#${index} ${parts.join(" ")}`;
    });
    return {
        count: results.length,
        results: entries.join(" | ")
    };
}
