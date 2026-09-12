<script setup>
import { onMounted, onUnmounted, ref, useId } from 'vue';

defineProps({
  light: { type: Boolean, default: false },
});

const element = ref(null);
const entered = ref(false);
const identifier = useId();
const crossingMask = `connection-crossing-${identifier}`;
const signalHalo = `connection-halo-${identifier}`;
const trajectory = 'M170 112C139 79 117 52 86 55C36 60 27 142 72 164C108 182 141 140 170 112C201 82 230 53 260 68C305 90 298 156 259 165C228 172 199 141 170 112Z';
let observer;

onMounted(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
    entered.value = true;
    return;
  }
  observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    entered.value = true;
    observer.disconnect();
  }, { threshold: .2 });
  observer.observe(element.value);
});

onUnmounted(() => observer?.disconnect());
</script>

<template>
  <div ref="element" class="connection-loop" :class="{ 'is-visible': entered }" :data-light="light" aria-hidden="true">
    <svg viewBox="0 0 340 220" fill="none" focusable="false">
      <defs>
        <mask :id="crossingMask" maskUnits="userSpaceOnUse" x="0" y="0" width="340" height="220">
          <path d="M0 0h340v220H0Z" fill="white"/>
          <circle cx="170" cy="112" r="6.2" fill="black"/>
        </mask>
        <radialGradient :id="signalHalo">
          <stop stop-color="var(--loop-halo)" stop-opacity=".5"/>
          <stop offset=".22" stop-color="var(--loop-halo)" stop-opacity=".24"/>
          <stop offset=".55" stop-color="var(--loop-halo)" stop-opacity=".06"/>
          <stop offset="1" stop-color="var(--loop-halo)" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <g transform="rotate(-8 170 110)">
        <g :mask="`url(#${crossingMask})`">
          <path :d="trajectory" class="drawn-line loop-contour contour-outer" pathLength="100" transform="translate(-6.8 -4.4) scale(1.04)"/>
          <path :d="trajectory" class="drawn-line loop-contour contour-inner" pathLength="100" transform="translate(6.8 4.4) scale(.96)"/>
          <path :d="trajectory" class="drawn-line loop-track" pathLength="100"/>
          <path d="M170 112C201 82 230 53 260 68C305 90 298 156 259 165C228 172 199 141 170 112" class="drawn-line loop-blue-track" pathLength="100"/>
        </g>
        <path d="M162.2 119.6C164.8 117 167.4 114.5 170 112C172.6 109.5 175.2 107 177.8 104.6" class="drawn-line loop-bridge" pathLength="100"/>
        <g class="travelling-signal" :style="{ offsetPath: `path('${trajectory}')` }">
          <circle r="7.5" :fill="`url(#${signalHalo})`"/>
        </g>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.connection-loop {
  --loop-amber: #cfa458;
  --loop-blue: #7896e8;
  --loop-halo: #f3c46a;
  width: 100%;
  max-width: 340px;
  pointer-events: none;
}
.connection-loop[data-light="true"] {
  --loop-amber: #936619;
  --loop-blue: #4d6bbb;
  --loop-halo: #b58a38;
}
svg { display: block; width: 100%; height: auto; overflow: visible; }
path { stroke-linecap: round; stroke-linejoin: round; }
.loop-contour { stroke-width: .8; }
.contour-outer { stroke: var(--loop-amber); opacity: .24; }
.contour-inner { stroke: var(--loop-blue); opacity: .19; }
.loop-track { stroke: var(--loop-amber); stroke-width: 1.1; opacity: .75; }
.loop-blue-track { stroke: var(--loop-blue); stroke-width: 1.1; opacity: .85; }
.loop-bridge { stroke: var(--loop-amber); stroke-width: 1.1; opacity: .85; }
.drawn-line { stroke-dasharray: 100; stroke-dashoffset: 100; }
.is-visible .drawn-line { animation: draw-connection 2.2s cubic-bezier(.3, .6, .3, 1) both; }
.is-visible .contour-outer { animation-delay: .18s; }
.is-visible .contour-inner { animation-delay: .36s; }
.is-visible .loop-blue-track { animation-duration: 1.2s; animation-delay: 1.05s; }
.is-visible .loop-bridge { animation-duration: .28s; animation-delay: 1s; }
.travelling-signal { offset-distance: 0%; offset-rotate: 0deg; opacity: 0; filter: blur(.6px); }
.is-visible .travelling-signal { animation: visit-connection 18s linear 2.8s infinite; }
@keyframes draw-connection { to { stroke-dashoffset: 0; } }
@keyframes visit-connection {
  0% { offset-distance: 0%; opacity: 0; }
  1.2% { opacity: .8; }
  13.5% { opacity: .8; }
  15%, 100% { offset-distance: 100%; opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .drawn-line, .is-visible .drawn-line { animation: none; stroke-dashoffset: 0; }
  .travelling-signal, .is-visible .travelling-signal { animation: none; display: none; }
}
</style>
