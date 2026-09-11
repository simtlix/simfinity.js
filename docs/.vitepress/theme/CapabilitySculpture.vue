<script setup>
defineProps({ node: { type: String, required: true } });
</script>

<template>
  <div class="capability-sculpture" :data-sculpture="node" aria-hidden="true">
    <svg viewBox="0 0 360 360" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
      <g class="sculpture-guides" opacity=".22">
        <path d="M180 18v25m0 274v25M18 180h25m274 0h25" />
        <circle cx="180" cy="180" r="148" stroke-dasharray="1 12" />
      </g>
      <g v-if="node === 'models'" class="sculpture-float">
        <g v-for="(y, index) in [230, 180, 130]" :key="y" class="sculpture-layer" :style="{ '--layer': index }">
          <path :d="`M92 ${y}v22c0 25 39 45 88 45s88-20 88-45v-22`" class="sculpture-face" />
          <ellipse cx="180" :cy="y" rx="88" ry="45" class="sculpture-face" />
          <ellipse cx="180" :cy="y" rx="67" ry="33" opacity=".24" stroke-dasharray="3 6" />
          <path :d="`M113 ${y + 25}c16 13 40 20 67 20`" stroke-width="2.5" class="sculpture-trace" pathLength="100" />
          <circle cx="246" :cy="y + 23" r="2.5" fill="currentColor" />
        </g>
        <path d="M180 57v38m0 193v25" opacity=".45" stroke-dasharray="2 5" />
      </g>
      <g v-else-if="node === 'query'" class="sculpture-float">
        <path d="m180 64 108 62v113l-108 62-108-62V126Z" class="sculpture-face" />
        <path d="m72 126 108 62 108-62M180 188v113" opacity=".4" />
        <g class="sculpture-layer" style="--layer: 1">
          <path d="m125 102 55-32 55 32v110l-55 32-55-32Z" class="sculpture-glass" />
          <path d="M157 134h-12v57h12m46-57h12v57h-12m-32-40 20 12-20 12" stroke-width="3" class="sculpture-trace" pathLength="100" />
        </g>
        <g class="sculpture-streams" stroke-dasharray="4 12">
          <path d="M24 133 108 181M24 180l84 48M252 181l84-48m-84 95 84-48" />
        </g>
        <circle cx="180" cy="65" r="4" fill="currentColor" />
      </g>
      <g v-else-if="node === 'mutation'" class="sculpture-float">
        <path d="m180 66 101 58v116l-101 58-101-58V124Z" class="sculpture-glass" />
        <path d="m180 42 122 70v140l-122 70-122-70V112Z" opacity=".2" stroke-dasharray="4 8" />
        <g class="sculpture-layer" style="--layer: 1">
          <path d="m194 99-76 103h57l-12 68 79-111h-59Z" class="sculpture-face sculpture-trace" stroke-width="2" pathLength="100" />
          <path d="m194 99-6 77h35" opacity=".4" />
        </g>
        <g class="sculpture-streams"><path d="M26 180h56m-22-55 36 20m183 35h55m-70 55 36 20" stroke-dasharray="4 12" /></g>
        <circle cx="79" cy="124" r="4" fill="currentColor" /><circle cx="281" cy="240" r="4" fill="currentColor" />
      </g>
      <g v-else-if="node === 'relations'" class="sculpture-float">
        <g opacity=".7"><path d="m180 180-96-62m96 62 98-62m-98 62-74 87m74-87 99 69m-99-69V68" class="sculpture-trace" pathLength="100" /></g>
        <circle cx="180" cy="180" r="37" class="sculpture-face" stroke-width="2" />
        <ellipse cx="180" cy="180" rx="18" ry="37" opacity=".4" /><ellipse cx="180" cy="180" rx="37" ry="15" opacity=".4" />
        <g v-for="(point, index) in [[84, 118], [278, 118], [106, 267], [279, 249], [180, 68]]" :key="index" class="sculpture-layer" :style="{ '--layer': index }">
          <circle :cx="point[0]" :cy="point[1]" r="19" class="sculpture-face" />
          <circle :cx="point[0]" :cy="point[1]" r="5" fill="currentColor" />
          <circle :cx="point[0]" :cy="point[1]" r="27" opacity=".22" stroke-dasharray="2 6" />
        </g>
      </g>
      <g v-else-if="node === 'mcp'" class="sculpture-float">
        <path d="m180 48 114 66v132l-114 66-114-66V114Z" class="sculpture-glass" />
        <path d="m180 48-57 165h114Zm-114 66 114 198 114-198ZM66 246l228-132M66 114l228 132" opacity=".23" />
        <g class="sculpture-layer" style="--layer: 1">
          <path d="m128 188 64-64a23 23 0 0 1 33 33l-48 48m-66-42 64-64a23 23 0 0 1 33 33l-72 72m-47-25 24 24 32-32m-32 32 32 32" stroke-width="3" class="sculpture-trace" pathLength="100" />
        </g>
        <g fill="currentColor"><circle cx="180" cy="48" r="4" /><circle cx="66" cy="114" r="4" /><circle cx="294" cy="114" r="4" /><circle cx="66" cy="246" r="4" /><circle cx="294" cy="246" r="4" /><circle cx="180" cy="312" r="4" /></g>
      </g>
      <g v-else class="sculpture-float">
        <g v-for="(y, index) in [212, 171, 130]" :key="y" class="sculpture-layer" :style="{ '--layer': index }">
          <path :d="`m180 ${y - 55} 94 55v26l-94 55-94-55v-26Z`" class="sculpture-face" />
          <path :d="`m86 ${y} 94 55 94-55m-94 55v26`" opacity=".5" />
        </g>
        <path d="m180 90-37 22v30l37 23 37-23v-30Zm0 0-37 52h74Zm-37 22 37 53 37-53" stroke-width="1.8" class="sculpture-trace" pathLength="100" />
        <g fill="currentColor"><circle cx="180" cy="90" r="4" /><circle cx="143" cy="112" r="4" /><circle cx="217" cy="112" r="4" /><circle cx="180" cy="165" r="4" /></g>
      </g>
    </svg>
  </div>
</template>
