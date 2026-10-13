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
            const res = await browser.runtime.sendMessage({ subject });
            // §11.4: the reset only answers ok once its state is confirmed on
            // disk; a `false` means it was applied in memory but not persisted,
            // which must not be shown as success (a restart would restore the
            // old session).
            status =
                res && res.ok === false
                    ? _("optionsYangshipinResetNotPersisted")
                    : _("optionsYangshipinActionDone");
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
    <div class="option__label">{_("optionsYangshipinResetSession")}</div>
    <div class="option__control">
        <div class="option__description">
            {_("optionsYangshipinResetSessionDescription")}
        </div>
        <div class="yangshipin-session__actions">
            <button
                type="button"
                on:click={() => send("yangshipin:resetSession")}
            >
                {_("optionsYangshipinResetSession")}
            </button>
            {#if status}
                <span class="yangshipin-session__status">{status}</span>
            {/if}
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
