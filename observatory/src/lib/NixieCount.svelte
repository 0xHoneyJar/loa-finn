<script lang="ts">
  import { onMount } from 'svelte';

  const FRAME_MS = 83;

  let {
    target,
    duration = 2000,
    format = (n: number) => n.toLocaleString(),
  }: {
    target: number;
    duration?: number;
    format?: (n: number) => string;
  } = $props();

  let display = $state('0');
  let settled = $state(false);

  onMount(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reducedMotion) {
      display = format(target);
      settled = true;
      return;
    }

    const targetStr = format(target);
    const totalFrames = Math.floor(duration / FRAME_MS);
    let startTime = 0;
    let lastFrame = -1;
    let rafId = 0;

    function tick(timestamp: number) {
      if (!startTime) startTime = timestamp;
      const elapsed = timestamp - startTime;
      const frame = Math.floor(elapsed / FRAME_MS);

      if (frame >= totalFrames) {
        display = targetStr;
        settled = true;
        return;
      }

      // Gate: only update when frame index advances (83ms phosphor persistence)
      if (frame === lastFrame) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      lastFrame = frame;

      const p = frame / totalFrames;
      const settledDigits = Math.floor(p * targetStr.length);
      let result = '';

      for (let i = 0; i < targetStr.length; i++) {
        const char = targetStr[i];
        if (i < settledDigits) {
          result += char;
        } else if (char >= '0' && char <= '9') {
          result += String(Math.floor(Math.random() * 10));
        } else {
          result += char;
        }
      }

      display = result;
      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  });
</script>

<span class="nixie-count" class:nixie-settled={settled}>
  {display}
</span>

<style>
  .nixie-count {
    font-variant-numeric: tabular-nums;
  }
</style>
