<script lang="ts">
	import type { Writable } from 'svelte/store';
	import type { Settings } from '../../shared/message-types';
	import CardHeading from '../../popup/components/CardHeading.svelte';
	import Toggle from '../../popup/components/Toggle.svelte';

	let {
		settings,
		setValue,
	}: {
		settings: Writable<Settings | null>;
		setValue: (value: boolean) => Promise<boolean>;
	} = $props();

	let value = $derived($settings?.searchProtectionEnabled ?? false);
	let declined = $state(false);
	// The toggle flips itself on click; redraw it from the setting when the
	// permission prompt is declined so it does not show "on".
	let toggleKey = $state(0);

	async function change(checked: boolean): Promise<void> {
		declined = !(await setValue(checked));
		if (declined) toggleKey += 1;
	}
</script>

<article class="card" id="search-protection-section">
	<CardHeading title="Web search" hint="Bing, Google, DuckDuckGo, Ecosia, Brave, Startpage" />
	<div class="row">
		<div class="info">
			<span class="row-label">Protect web searches</span>
			<p class="hint">
				Checks what you paste into a search engine's search box, and holds each search
				until its query has been checked. Personal data you approve is replaced with
				placeholders such as <code>[PERSON_1]</code> before the search is sent.
				Turning this on asks the browser for access to these search sites.
			</p>
			<p class="hint">
				Not covered: searches typed into the browser's address bar, which never reach
				the page, and the suggestions a search engine requests while you type. Turn off
				search suggestions in the engine's settings for the strongest protection.
			</p>
			{#if declined}
				<p class="hint warn">Access to the search sites was not granted, so protection stays off.</p>
			{/if}
		</div>
		{#key toggleKey}
			<Toggle size="sm" checked={value} label="Protect web searches" onchange={(checked) => void change(checked)} />
		{/key}
	</div>
</article>

<style>
	.card { margin-bottom: 12px; overflow: hidden; border: var(--border-hairline); border-radius: var(--radius-lg); background: var(--color-card); }
	.row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 14px; }
	.info { flex: 1; }
	.row-label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 4px; }
	.hint { margin: 0 0 6px; color: var(--color-muted); font-size: 12px; line-height: 1.5; }
	.hint:last-child { margin-bottom: 0; }
	.warn { color: var(--color-danger, #b42318); }
	.hint code {
		padding: 1px 5px;
		border-radius: 3px;
		background: var(--color-surface);
		color: var(--color-ink);
		font-family: var(--font-mono);
		font-size: 11px;
	}
</style>
