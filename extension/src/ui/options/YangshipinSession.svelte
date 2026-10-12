<script lang="ts">
    import { onMount } from "svelte";

    const _ = browser.i18n.getMessage;

    let diagnostics: Record<string, number> | undefined = undefined;
    let status = "";

    async function refreshDiagnostics() {
        try {
            const res = await browser.runtime.sendMessage({
                subject: "yangshipin:diagnostics"
            });
            diagnostics = res?.diagnostics;
        } catch {
            diagnostics = undefined;
        }
    }

    async function send(subject: string) {
        try {
            await browser.runtime.sendMessage({ subject });
            status = _("optionsYangshipinActionDone");
        } catch {
            status = "";
        }
        await refreshDiagnostics();
    }

    onMount(() => {
        void refreshDiagnostics();
    });
</script>

<div class="option">
    <div class="option__label">{_("optionsYangshipinClearSession")}</div>
    <div class="option__control">
        <div class="option__description">
            {_("optionsYangshipinClearSessionDescription")}
        </div>
        <div class="yangshipin-session__actions">
            <button
                type="button"
                on:click={() => send("yangshipin:clearSession")}
            >
                {_("optionsYangshipinClearSession")}
            </button>
            <button
                type="button"
                on:click={() => send("yangshipin:rerunBaseline")}
            >
                {_("optionsYangshipinRerunBaseline")}
            </button>
            {#if status}
                <span class="yangshipin-session__status">{status}</span>
            {/if}
        </div>
        <div class="option__description">
            {_("optionsYangshipinRerunBaselineDescription")}
        </div>
        <div class="option__description">
            {_("optionsYangshipinKnownLimits")}
        </div>
    </div>
</div>

{#if diagnostics}
    <div class="option">
        <div class="option__label">
            {_("optionsYangshipinDiagnosticsTitle")}
        </div>
        <div class="option__control">
            <table class="yangshipin-session__diagnostics">
                {#each Object.entries(diagnostics) as [name, count] (name)}
                    <tr>
                        <td>{name}</td>
                        <td>{count}</td>
                    </tr>
                {/each}
            </table>
        </div>
    </div>
{/if}

<style>
    .yangshipin-session__actions {
        display: flex;
        align-items: center;
        gap: 0.5em;
        padding: 0.25em 0;
    }

    .yangshipin-session__status {
        opacity: 0.7;
    }

    .yangshipin-session__diagnostics {
        font-size: 0.9em;
        border-collapse: collapse;
    }

    .yangshipin-session__diagnostics td {
        padding: 0 0.75em 0 0;
        text-align: left;
    }
</style>
