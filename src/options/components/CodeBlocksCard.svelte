<script lang="ts">
	import type { Writable } from 'svelte/store';
	import type { CodeAnonymizationMode, Settings } from '../../shared/message-types';
	import CardHeading from '../../popup/components/CardHeading.svelte';
	import Toggle from '../../popup/components/Toggle.svelte';

	let {
		settings,
		setValue,
		setCodeAnonymization,
	}: {
		settings: Writable<Settings | null>;
		setValue: (value: boolean) => Promise<void>;
		setCodeAnonymization: (value: CodeAnonymizationMode) => Promise<void>;
	} = $props();

	let value = $derived($settings?.skipCodeBlocks ?? false);
	let codeMode = $derived($settings?.codeAnonymization ?? 'secrets');
	let codeSecrets = $derived(codeMode !== 'off');
	let renameIdentifiers = $derived(codeMode === 'full');
</script>

<article class="card" id="code-blocks-section">
	<CardHeading title="Code blocks" hint="Secrets in code and code-region handling" />
	<div class="row">
		<div class="info">
			<span class="row-label">Detect secrets in code</span>
			<p class="hint">
				Flags API keys and tokens (AWS, GitHub, OpenAI, Stripe, Slack, Google, JWT),
				private key blocks, credentials in assignments and connection strings,
				internal hostnames such as <code>db.acme.internal</code>, and usernames in
				home-directory paths.
			</p>
		</div>
		<Toggle size="sm" checked={codeSecrets} label="Detect secrets in code" onchange={(checked) => setCodeAnonymization(checked ? 'secrets' : 'off')} />
	</div>
	<div class="row">
		<div class="info">
			<span class="row-label">Rename code identifiers</span>
			<p class="hint">
				Renames the classes, functions, variables, fields and parameters that pasted
				code declares, the same way everywhere: <code>alma</code> becomes
				<code>var1</code> and <code>alma.nev</code> becomes <code>var1.field2</code>.
				Imported and library names stay. Names in which Local AI finds personal data
				keep a typed placeholder instead (<code>getPERSON_1Invoice</code>). Copying
				code back from a reply restores the original names. Turning this on also
				turns on secret detection.
			</p>
		</div>
		<Toggle
			size="sm"
			checked={renameIdentifiers}
			label="Rename code identifiers"
			onchange={(checked) => setCodeAnonymization(checked ? 'full' : 'secrets')}
		/>
	</div>
	<div class="row">
		<div class="info">
			<span class="row-label">Skip code blocks</span>
			<p class="hint">
				When on, detections inside fenced markdown blocks and
				<code>&lt;code&gt;</code>/<code>&lt;pre&gt;</code> regions move to a
				collapsed disclosure in the overlay instead of appearing at the top level.
				Inline backticks are always scanned.
			</p>
		</div>
		<Toggle size="sm" checked={value} label="Skip code blocks" onchange={(checked) => setValue(checked)} />
	</div>
</article>

<style>
	.card { margin-bottom: 12px; overflow: hidden; border: var(--border-hairline); border-radius: var(--radius-lg); background: var(--color-card); }
	.row + .row { border-top: var(--border-hairline); }
	.row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 14px; }
	.info { flex: 1; }
	.row-label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 4px; }
	.hint { margin: 0; color: var(--color-muted); font-size: 12px; line-height: 1.5; }
	.hint code {
		padding: 1px 5px;
		border-radius: 3px;
		background: var(--color-surface);
		color: var(--color-ink);
		font-family: var(--font-mono);
		font-size: 11px;
	}
</style>
