<!--
  PixelMark — creative-director annotation overlay.

  Ported from world-sprawl/apps/sprawl-ui/src/lib/components/PixelMark.svelte.
  Svelte 5, zero-dep, auto-portals to <body>, no props. Mount ONCE in
  +layout.svelte. Shift+drag to mark a region; type a note; Shift+Enter (or Tab)
  copies a markdown report to the clipboard.

  THEMED to the freeside register (taste.md): the mark rectangle is CYAN
  (structural chrome), the note input is void-surface + bone text. No invented
  hex — every color is a freeside oklch token. No radii. steps() motion only.
  SSR-safe: all browser APIs guarded behind `browser` ($app/environment), so
  adapter-static prerender is unaffected (the overlay only wakes in the client).
-->
<script lang="ts">
	import { browser } from '$app/environment';

	interface Mark {
		x: number;
		y: number;
		w: number;
		h: number;
		note: string;
		selectors: string[];
		computed: string;
		appContext: string;
		componentLoc: string | null;
	}

	// --- State ---
	let shiftHeld = $state(false);
	let drawing = $state(false);
	let startX = $state(0);
	let startY = $state(0);
	let currentX = $state(0);
	let currentY = $state(0);

	// Accumulated marks
	let marks = $state<Mark[]>([]);

	// Active mark being annotated (index into marks)
	let activeIdx = $state<number | null>(null);
	let note = $state('');
	let inputEl: HTMLInputElement | undefined = $state();

	// Feedback
	let copied = $state(false);

	// Overlay element — portaled to <body> so absolute children scroll with document
	let overlayEl: HTMLDivElement | undefined = $state();

	// Track ancestor scroll context of the element under the initial mousedown.
	// If the drag starts inside a position:fixed/sticky subtree, switch to viewport coords.
	let useViewportCoords = $state(false);
	let dragScrollContext: { extraX: number; extraY: number } = { extraX: 0, extraY: 0 };

	// Derived rectangle while drawing
	const drawRect = $derived(
		drawing
			? {
					x: Math.min(startX, currentX),
					y: Math.min(startY, currentY),
					w: Math.abs(currentX - startX),
					h: Math.abs(currentY - startY)
				}
			: null
	);

	const hasMarks = $derived(marks.length > 0);

	// --- Coordinate translation ---
	// Walk DOM upward from `target`, accumulating scrollLeft/scrollTop of any
	// ancestor with overflow auto|scroll. Returns document-absolute coords.
	// If a fixed/sticky ancestor is encountered, returns useViewport=true so the
	// caller can fall back to raw viewport coords + position-fixed overlay.
	function getDocumentCoords(clientX: number, clientY: number, target: Element | null) {
		let scrollX = window.scrollX;
		let scrollY = window.scrollY;
		let extraX = 0;
		let extraY = 0;
		let useViewport = false;
		let el: Element | null = target;
		while (el && el !== document.documentElement && el !== document.body) {
			const style = getComputedStyle(el);
			if (style.position === 'fixed' || style.position === 'sticky') {
				useViewport = true;
				break;
			}
			const overflow = style.overflow + style.overflowY + style.overflowX;
			if (/(auto|scroll)/.test(overflow)) {
				extraX += (el as HTMLElement).scrollLeft;
				extraY += (el as HTMLElement).scrollTop;
			}
			el = el.parentElement;
		}
		if (useViewport) {
			return { x: clientX, y: clientY, useViewport, extraX: 0, extraY: 0 };
		}
		return { x: clientX + scrollX + extraX, y: clientY + scrollY + extraY, useViewport, extraX, extraY };
	}

	// Convert document coords back to viewport for elementsFromPoint hit-testing.
	function docToViewport(docX: number, docY: number) {
		if (useViewportCoords) return { x: docX, y: docY };
		return {
			x: docX - window.scrollX - dragScrollContext.extraX,
			y: docY - window.scrollY - dragScrollContext.extraY
		};
	}

	// --- App context from body dataset ---
	function getAppContext(): string {
		const b = document.body.dataset;
		const parts: string[] = [];
		if (b.step) parts.push(`phase: ${b.step}`);
		if (b.tier) parts.push(`tier: ${b.tier}`);
		if (b.ash) parts.push(`ash: ${b.ash}`);
		if (b.zone) parts.push(`zone: ${b.zone}`);
		return parts.join(', ');
	}

	// --- Svelte component detection (dev mode only) ---
	function formatLoc(loc: any): string | null {
		if (!loc) return null;
		if (typeof loc === 'string') return loc;
		// Svelte 5 __svelte_meta.loc is { file, line, column }
		if (loc.file) {
			const file = loc.file.replace(/^.*\/src\//, 'src/');
			return `${file}:${loc.line ?? '?'}`;
		}
		return null;
	}

	function getSvelteComponent(el: Element): string | null {
		const meta = (el as any).__svelte_meta;
		const loc = formatLoc(meta?.loc);
		if (loc) return loc;
		// Walk parents
		let parent = el.parentElement;
		while (parent && parent !== document.body) {
			const pm = (parent as any).__svelte_meta;
			const ploc = formatLoc(pm?.loc);
			if (ploc) return ploc;
			parent = parent.parentElement;
		}
		return null;
	}

	// --- Element detection ---
	// `r` is in document coords (or viewport coords when useViewportCoords=true).
	// elementsFromPoint takes viewport coords, so convert per-point.
	function gatherContext(r: { x: number; y: number; w: number; h: number }) {
		const cx = r.x + r.w / 2;
		const cy = r.y + r.h / 2;

		const docPoints = [
			[cx, cy],
			[r.x, r.y],
			[r.x + r.w, r.y],
			[r.x, r.y + r.h],
			[r.x + r.w, r.y + r.h]
		];
		const points = docPoints.map(([dx, dy]) => {
			const v = docToViewport(dx, dy);
			return [v.x, v.y];
		});

		const seen = new Set<string>();
		const selectors: string[] = [];
		let componentLoc: string | null = null;

		for (const [px, py] of points) {
			const els = document.elementsFromPoint(px, py);
			for (const el of els) {
				if ((el as HTMLElement).dataset?.pixelmark !== undefined) continue;
				if (el === document.body || el === document.documentElement) continue;

				// Try to detect Svelte component from first valid element
				if (!componentLoc) {
					componentLoc = getSvelteComponent(el);
				}

				const tag = el.tagName.toLowerCase();
				const cls = Array.from(el.classList)
					.filter((c) => !c.startsWith('s-'))
					.slice(0, 2)
					.join('.');
				const sel = cls ? `.${cls} (${tag})` : tag;

				if (!seen.has(sel)) {
					seen.add(sel);
					selectors.push(sel);
				}
				if (selectors.length >= 3) break;
			}
			if (selectors.length >= 3) break;
		}

		// Computed styles at center (elementsFromPoint takes viewport coords)
		const centerVp = docToViewport(cx, cy);
		const centerEls = document.elementsFromPoint(centerVp.x, centerVp.y);
		const targetEl = centerEls.find(
			(el) =>
				(el as HTMLElement).dataset?.pixelmark === undefined &&
				el !== document.body &&
				el !== document.documentElement
		);

		let computed = '';
		if (targetEl) {
			const cs = getComputedStyle(targetEl);
			const props = ['margin', 'padding', 'gap', 'font-size', 'color', 'background'] as const;
			computed = props.map((p) => `- ${p}: ${cs.getPropertyValue(p)}`).join('\n');
		}

		const appContext = getAppContext();

		return { selectors, computed, appContext, componentLoc };
	}

	// --- Keyboard tracking ---
	function onKeyDown(e: KeyboardEvent) {
		if (e.key === 'Shift') shiftHeld = true;

		// Guard: ignore global shortcuts when focus is in an editable element
		// (the input's own onInputKeyDown handles those + stopPropagation)
		const target = e.target as HTMLElement | null;
		if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

		// Shift+Enter → batch submit all marks
		if (e.key === 'Enter' && e.shiftKey && hasMarks && activeIdx === null) {
			e.preventDefault();
			batchSubmit();
		}

		// Escape → clear all
		if (e.key === 'Escape' && (hasMarks || activeIdx !== null)) {
			marks = [];
			activeIdx = null;
			note = '';
		}
	}

	function onKeyUp(e: KeyboardEvent) {
		if (e.key === 'Shift') {
			shiftHeld = false;
			// If drawing when Shift releases, finalize the mark (don't drop it)
			if (drawing) finalizeMark();
		}
	}

	// --- Mouse handlers ---
	function onMouseDown(e: MouseEvent) {
		if (!shiftHeld) return;
		// If annotating, commit current note first
		if (activeIdx !== null) {
			commitNote();
		}

		// Determine the real element under the click (overlay has pointer-events on
		// during shift-held; temporarily peek through it via elementsFromPoint).
		const stack = document.elementsFromPoint(e.clientX, e.clientY);
		const target = stack.find(
			(el) => (el as HTMLElement).dataset?.pixelmark === undefined
		) ?? null;

		const coords = getDocumentCoords(e.clientX, e.clientY, target);
		useViewportCoords = coords.useViewport;
		dragScrollContext = { extraX: coords.extraX, extraY: coords.extraY };

		drawing = true;
		startX = coords.x;
		startY = coords.y;
		currentX = coords.x;
		currentY = coords.y;
	}

	function onMouseMove(e: MouseEvent) {
		if (!drawing) return;
		// Reuse the scroll context resolved at mousedown so the rect tracks the
		// initial element's frame even if the cursor moves over a different ancestor.
		if (useViewportCoords) {
			currentX = e.clientX;
			currentY = e.clientY;
		} else {
			currentX = e.clientX + window.scrollX + dragScrollContext.extraX;
			currentY = e.clientY + window.scrollY + dragScrollContext.extraY;
		}
	}

	function onMouseUp() {
		if (!drawing) return;
		finalizeMark();
	}

	/** Shared mark creation — called from mouseUp and Shift-release-during-draw */
	function finalizeMark() {
		drawing = false;

		const w = Math.abs(currentX - startX);
		const h = Math.abs(currentY - startY);

		if (w < 4 || h < 4) return;

		const r = {
			x: Math.min(startX, currentX),
			y: Math.min(startY, currentY),
			w,
			h
		};

		const { selectors, computed, appContext, componentLoc } = gatherContext(r);

		const newMark: Mark = { ...r, note: '', selectors, computed, appContext, componentLoc };
		marks = [...marks, newMark];
		activeIdx = marks.length - 1;
		note = '';

		requestAnimationFrame(() => {
			inputEl?.focus();
		});
	}

	// --- Note management ---
	function commitNote() {
		if (activeIdx !== null && activeIdx < marks.length) {
			marks[activeIdx].note = note.trim();
			marks = [...marks]; // trigger reactivity
		}
		activeIdx = null;
		note = '';
	}

	function onInputKeyDown(e: KeyboardEvent) {
		if (e.key === 'Enter' && e.shiftKey) {
			e.preventDefault();
			// Shift+Enter = commit note + submit all (batch shortcut works from input too)
			commitNote();
			batchSubmit();
			e.stopPropagation();
			return;
		}
		if (e.key === 'Enter') {
			e.preventDefault();
			// Commit note, stay in multi-mark mode — Shift+drag for next mark
			commitNote();
			e.stopPropagation();
			return;
		}
		if (e.key === 'Tab') {
			e.preventDefault();
			// Tab = commit + submit all immediately (fastest path for single marks)
			commitNote();
			batchSubmit();
			e.stopPropagation();
			return;
		}
		if (e.key === 'Escape') {
			e.preventDefault();
			// Remove this mark entirely
			if (activeIdx !== null) {
				marks = marks.filter((_, i) => i !== activeIdx);
			}
			activeIdx = null;
			note = '';
		}
		e.stopPropagation();
	}

	// --- Batch submit ---
	async function batchSubmit() {
		if (marks.length === 0) return;

		// Shared app context (same for all marks in a batch)
		const sharedContext = marks[0]?.appContext || getAppContext();

		const sections = marks.map((m, i) => {
			const header = `### Mark ${i + 1}`;
			const region = `**Region**: (${m.x}, ${m.y}) → (${m.x + m.w}, ${m.y + m.h}) [${m.w}×${m.h}]`;
			const noteStr = m.note ? `**Note**: ${m.note}` : `**Note**: (no note)`;
			const comp_loc = m.componentLoc ? `**Component**: \`${m.componentLoc}\`` : '';
			const sels = m.selectors.length
				? `**Nearest elements**:\n${m.selectors.map((s) => `- \`${s}\``).join('\n')}`
				: '';
			const comp = m.computed ? `**Computed at center**:\n${m.computed}` : '';
			return [header, region, noteStr, comp_loc, sels, comp].filter(Boolean).join('\n');
		});

		const contextLine = sharedContext ? `**App state**: ${sharedContext}\n\n` : '';
		const md = `## PixelMark — ${marks.length} mark${marks.length > 1 ? 's' : ''}\n\n${contextLine}${sections.join('\n\n---\n\n')}`;

		try {
			await navigator.clipboard.writeText(md);
		} catch {
			// Clipboard may fail in non-secure contexts
		}

		copied = true;
		marks = [];
		activeIdx = null;
		note = '';

		setTimeout(() => {
			copied = false;
		}, 500);
	}

	// Reset draw/key state on window blur — prevents stuck states
	function onWindowBlur() {
		if (drawing) drawing = false;
		shiftHeld = false;
	}

	// --- Global listeners ---
	// mousemove/mouseup on window (not overlay) so drags that leave the
	// viewport still finalize correctly instead of leaving drawing stuck.
	$effect(() => {
		if (!browser) return;
		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('keyup', onKeyUp);
		window.addEventListener('mousemove', onMouseMove);
		window.addEventListener('mouseup', onMouseUp);
		window.addEventListener('blur', onWindowBlur);
		return () => {
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('keyup', onKeyUp);
			window.removeEventListener('mousemove', onMouseMove);
			window.removeEventListener('mouseup', onMouseUp);
			window.removeEventListener('blur', onWindowBlur);
		};
	});

	// Portal overlay to <body> so position:absolute children scroll with the document.
	// Without this, the overlay sits inside whatever ancestor the consumer placed
	// it in — and absolute children would resolve against that ancestor's frame,
	// not the document.
	$effect(() => {
		if (!browser || !overlayEl) return;
		const original = overlayEl.parentNode;
		const originalNext = overlayEl.nextSibling;
		document.body.appendChild(overlayEl);
		return () => {
			if (original) original.insertBefore(overlayEl!, originalNext);
		};
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={overlayEl}
	class="pixelmark-overlay"
	class:pixelmark-active={shiftHeld || hasMarks || copied}
	class:pixelmark-viewport-mode={useViewportCoords}
	data-pixelmark
	onmousedown={onMouseDown}
>
	<!-- Drawing rectangle with live dimensions -->
	{#if drawRect}
		<div
			class="pixelmark-rect pixelmark-drawing"
			data-pixelmark
			style="left:{drawRect.x}px;top:{drawRect.y}px;width:{drawRect.w}px;height:{drawRect.h}px"
		>
			<span class="pixelmark-dims" data-pixelmark>{drawRect.w}x{drawRect.h}</span>
		</div>
	{/if}

	<!-- Committed marks -->
	{#each marks as mark, i}
		<div
			class="pixelmark-rect"
			class:pixelmark-ghost={activeIdx !== i}
			class:pixelmark-active-mark={activeIdx === i}
			data-pixelmark
			style="left:{mark.x}px;top:{mark.y}px;width:{mark.w}px;height:{mark.h}px"
		>
			<span class="pixelmark-badge" data-pixelmark>{i + 1}</span>
		</div>
	{/each}

	<!-- Note input for active mark -->
	{#if activeIdx !== null && marks[activeIdx]}
		{@const m = marks[activeIdx]}
		<div
			class="pixelmark-popover"
			data-pixelmark
			style="left:{m.x}px;top:{Math.max(0, m.y - 34)}px"
		>
			<input
				bind:this={inputEl}
				bind:value={note}
				onkeydown={onInputKeyDown}
				class="pixelmark-input"
				data-pixelmark
				placeholder="note (optional, Enter to commit)"
				spellcheck="false"
				autocomplete="off"
			/>
		</div>
	{/if}

	<!-- Status bar — hotkey legend per state, inline COPIED -->
	{#if copied}
		<div class="pixelmark-status" data-pixelmark>
			<span class="pixelmark-copied-inline">COPIED</span>
		</div>
	{:else if hasMarks && activeIdx === null}
		<div class="pixelmark-status" data-pixelmark>
			<span class="pixelmark-count">{marks.length}</span>
			<span class="pixelmark-hint">Shift+Drag more · Shift+Enter copy · Esc clear</span>
		</div>
	{:else if hasMarks && activeIdx !== null}
		<div class="pixelmark-status" data-pixelmark>
			<span class="pixelmark-count">{marks.length}</span>
			<span class="pixelmark-hint">Enter commit · Tab copy now · Esc drop</span>
		</div>
	{:else if shiftHeld && !drawing}
		<div class="pixelmark-status" data-pixelmark>
			<span class="pixelmark-hint">drag to mark</span>
		</div>
	{/if}
</div>

<style>
	/* Default: portaled to <body>, absolute — children use document coords and
	   scroll with the page naturally. Covers viewport at minimum, extends to body
	   height for long pages. */
	.pixelmark-overlay {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		min-height: 100vh;
		z-index: 99999;
		pointer-events: none;
	}

	/* When the active drag began inside a position:fixed/sticky subtree, switch
	   to viewport coords + fixed overlay so the rect tracks the viewport-pinned
	   element rather than the page. */
	.pixelmark-overlay.pixelmark-viewport-mode {
		position: fixed;
		inset: 0;
		width: auto;
		min-height: 0;
	}

	.pixelmark-overlay.pixelmark-active {
		pointer-events: auto;
		cursor: crosshair;
	}

	/* Active drawing rectangle — CYAN (freeside structural chrome). No radii. */
	.pixelmark-rect {
		position: absolute;
		border: 1px solid var(--color-cyan-base);
		background: oklch(0.85 0.15 195 / 0.08);
		pointer-events: none;
	}

	/* Ghost — committed mark, visible enough to track your batch */
	.pixelmark-ghost {
		border-color: var(--color-cyan-dim);
		background: oklch(0.85 0.15 195 / 0.06);
	}

	/* Active mark being annotated */
	.pixelmark-active-mark {
		border-color: var(--color-cyan-base);
		background: oklch(0.85 0.15 195 / 0.08);
	}

	/* Number badge — cyan field, void text */
	.pixelmark-badge {
		position: absolute;
		top: -1px;
		left: -1px;
		font-family: var(--font-mono);
		font-size: var(--text-2xs);
		color: var(--color-void-base);
		background: var(--color-cyan-base);
		padding: 0 0.25rem;
		line-height: 1.4;
		pointer-events: none;
	}

	/* Note input popover */
	.pixelmark-popover {
		position: absolute;
		pointer-events: auto;
	}

	/* Note input — void-surface field, bone text, cyan border. No radii. */
	.pixelmark-input {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		color: var(--color-bone-base);
		background: var(--color-void-surface);
		border: 1px solid var(--color-cyan-dim);
		padding: 0.25rem 0.5rem;
		outline: none;
		min-width: 240px;
		border-radius: 0;
	}

	.pixelmark-input::placeholder {
		color: var(--color-bone-ghost);
	}

	/* Status bar — bottom-right, mark count + hint */
	.pixelmark-status {
		position: fixed;
		bottom: calc(env(safe-area-inset-bottom, 0px) + 4.5rem);
		right: 1rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		pointer-events: none;
	}

	.pixelmark-count {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		color: var(--color-void-base);
		background: var(--color-cyan-base);
		padding: 0.125rem 0.375rem;
		line-height: 1.4;
	}

	.pixelmark-hint {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--color-cyan-dim);
		letter-spacing: 0.04em;
	}

	/* Live dimensions — bottom-right corner of drawing rect */
	.pixelmark-dims {
		position: absolute;
		bottom: -1px;
		right: -1px;
		font-family: var(--font-mono);
		font-size: var(--text-2xs);
		color: var(--color-void-base);
		background: var(--color-cyan-base);
		padding: 0 0.25rem;
		line-height: 1.4;
		pointer-events: none;
	}

	/* Inline COPIED — replaces status bar, same position. steps() flash. */
	.pixelmark-copied-inline {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		color: var(--color-cyan-base);
		letter-spacing: 0.1em;
		animation: pixelmark-flash 500ms steps(1) forwards;
	}

	@keyframes pixelmark-flash {
		0%, 60% { opacity: 1; }
		100% { opacity: 0; }
	}
</style>
