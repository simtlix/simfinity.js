<script setup>
import { onMounted, onUnmounted, ref, useId } from 'vue';

const logo = ref(null);
const blueTrack = ref(null);
const amberTrack = ref(null);
const playing = ref(false);
const wordmark = 'simfinity.js';
const identifier = `brand-${useId()}`;
const blueShape = 'M42.63 17.16C44.4 15.7 45.93 14.88 46.96 14.62C47.99 14.37 48.47 14.48 49.13 14.9C49.78 15.32 50.57 16.28 51.19 17.69C51.8 19.1 52.23 20.9 52.34 22.66C52.46 24.41 52.26 26.09 51.85 27.29C51.43 28.49 50.9 29.13 50.26 29.49C49.61 29.85 48.61 30.02 46.98 29.64C45.36 29.26 43.23 28.31 40.84 26.93C38.45 25.55 35.81 23.75 33.08 21.89C30.36 20.04 27.55 18.13 24.81 16.55L22.49 20.56C25.01 22.03 27.72 23.89 30.42 25.76C33.12 27.64 35.82 29.52 38.4 31.07C40.97 32.62 43.42 33.83 45.78 34.45C48.15 35.07 50.54 35.06 52.56 34.07C54.59 33.08 56.01 31.21 56.82 29.14C57.62 27.06 57.9 24.73 57.8 22.37C57.71 20.02 57.23 17.65 56.36 15.52C55.49 13.39 54.21 11.46 52.32 10.16C50.43 8.87 47.91 8.45 45.59 9.02C43.27 9.58 41.1 10.92 38.95 12.7Z';
const amberShape = 'M24.89 16.6C21.94 14.89 19.07 13.55 16.31 12.98C13.56 12.4 10.81 12.67 8.64 14.05C6.48 15.44 5.09 17.76 4.4 20.33C3.7 22.9 3.64 25.77 4.09 28.53C4.55 31.29 5.51 33.94 7.09 36.06C8.66 38.18 11.01 39.75 13.68 40.03C16.35 40.3 19.08 39.35 21.64 37.75C24.2 36.14 26.7 33.86 29.15 31.32C31.61 28.78 34.02 25.99 36.31 23.46C38.6 20.93 40.78 18.68 42.68 17.12L39.01 12.65C36.7 14.56 34.38 17.02 32.05 19.63C29.71 22.25 27.37 25.02 25.09 27.44C22.82 29.85 20.61 31.88 18.69 33.14C16.78 34.39 15.26 34.83 14.16 34.76C13.06 34.69 12.12 34.2 11.15 32.97C10.17 31.74 9.34 29.8 8.94 27.68C8.54 25.56 8.57 23.3 9.01 21.54C9.45 19.78 10.24 18.6 11.18 17.97C12.12 17.35 13.42 17.1 15.38 17.5C17.34 17.9 19.85 19.01 22.56 20.6Z';
const blueTrajectory = 'M40.8 14.9C42.13 13.8 43.39 12.99 44.58 12.43C46.42 11.57 48.11 11.41 49.56 11.94C51.01 12.46 52.23 13.68 53.15 15.32C54.07 16.97 54.69 19.05 54.96 21.18C55.22 23.31 55.12 25.48 54.62 27.3C54.13 29.12 53.24 30.59 51.96 31.46C50.68 32.32 49 32.57 47 32.18C45 31.79 42.67 30.76 40.12 29.29C37.57 27.83 34.81 25.93 32 24C29.19 22.07 26.33 20.1 23.6 18.53';
const amberTrajectory = 'M23.6 18.53C20.87 16.95 18.28 15.77 16 15.27C13.71 14.77 11.73 14.96 10.18 15.85C8.64 16.74 7.52 18.32 6.88 20.34C6.24 22.35 6.08 24.77 6.37 27.15C6.66 29.52 7.41 31.84 8.51 33.63C9.62 35.43 11.09 36.7 12.8 37.19C14.52 37.68 16.49 37.38 18.58 36.34C20.68 35.3 22.91 33.53 25.17 31.34C27.44 29.15 29.74 26.56 32 24C34.26 21.44 36.48 18.94 38.6 16.9C39.35 16.17 40.09 15.5 40.8 14.9';
let link;
let reducedMotion;

function finish() {
  playing.value = false;
}

function play(event) {
  if (playing.value || reducedMotion.matches || event.pointerType === 'touch') return;
  playing.value = true;
}

onMounted(() => {
  const blueLength = blueTrack.value.getTotalLength();
  const amberLength = amberTrack.value.getTotalLength();
  logo.value.style.setProperty('--blue-length', `${blueLength}px`);
  logo.value.style.setProperty('--amber-length', `${amberLength}px`);
  logo.value.style.setProperty('--loop-length', `${blueLength + amberLength}px`);
  reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  reducedMotion.addEventListener('change', finish);
  link = logo.value.closest('a');
  link.addEventListener('pointerenter', play);
  link.addEventListener('focus', play);
});

onUnmounted(() => {
  link?.removeEventListener('pointerenter', play);
  link?.removeEventListener('focus', play);
  reducedMotion?.removeEventListener('change', finish);
});
</script>

<template>
  <span class="animated-brand" :class="{ 'is-playing': playing }">
    <svg ref="logo" class="logo animated-logo" viewBox="0 4 64 40" fill="none" aria-hidden="true" focusable="false">
      <defs>
        <path :id="`${identifier}-blue`" :d="blueShape"/>
        <path :id="`${identifier}-amber`" :d="amberShape"/>
        <clipPath :id="`${identifier}-blue-clip`"><use :href="`#${identifier}-blue`"/></clipPath>
        <clipPath :id="`${identifier}-amber-clip`"><use :href="`#${identifier}-amber`"/></clipPath>
        <mask :id="`${identifier}-crossing`" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="48">
          <path fill="white" d="M0 0h64v48H0z"/>
          <path fill="black" d="M28.47 33.29C29.91 31.87 31.32 30.36 32.71 28.83C34.09 27.3 35.44 25.76 36.75 24.31C38.07 22.86 39.33 21.49 40.53 20.3L35.18 14.96C33.83 16.31 32.49 17.78 31.15 19.29C29.81 20.8 28.47 22.35 27.14 23.84C25.82 25.34 24.51 26.77 23.25 28.05Z"/>
        </mask>
      </defs>
      <g :mask="`url(#${identifier}-crossing)`">
        <use :href="`#${identifier}-blue`" fill="#577BFF"/>
        <g class="color-flow" :clip-path="`url(#${identifier}-blue-clip)`">
          <path ref="blueTrack" class="color-track blue-track" :d="blueTrajectory"/>
        </g>
      </g>
      <use :href="`#${identifier}-amber`" fill="#EDAE16"/>
      <g class="color-flow" :clip-path="`url(#${identifier}-amber-clip)`">
        <use :href="`#${identifier}-amber`" fill="#577BFF"/>
        <path ref="amberTrack" class="color-track" :d="amberTrajectory" @animationend="finish"/>
      </g>
    </svg>
    <span class="brand-accessible-name">{{ wordmark }}</span>
    <span class="brand-wordmark" aria-hidden="true">
      <span v-for="(letter, index) in wordmark" :key="index" class="brand-letter" :style="{ '--letter-index': index }">{{ letter }}</span>
    </span>
  </span>
</template>

<style scoped>
.animated-brand {
  --brand-motion-duration: 720ms;
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  white-space: nowrap;
}
.animated-logo { flex-shrink: 0; transform-origin: center; }
.brand-wordmark { display: inline-flex; }
.brand-letter { display: inline-block; }
.brand-accessible-name {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
.color-flow { opacity: 0; }
.color-track {
  --start-offset: 0px;
  stroke: #EDAE16;
  stroke-width: 14;
  stroke-dasharray: var(--amber-length) var(--blue-length);
  stroke-dashoffset: var(--start-offset);
}
.blue-track { --start-offset: var(--amber-length); }
.is-playing .animated-logo { animation: brand-mark-wave 480ms cubic-bezier(.22, .61, .36, 1); }
.is-playing .color-flow { opacity: 1; }
.is-playing .color-track { animation: brand-color-lap var(--brand-motion-duration) cubic-bezier(.33, 0, .35, 1); }
.is-playing .brand-letter {
  animation: brand-letter-wave 360ms cubic-bezier(.37, 0, .63, 1) both;
  animation-delay: calc(64ms + var(--letter-index) * 24ms);
}
@keyframes brand-mark-wave {
  0%, 100% { transform: translateY(0) scale(1) rotate(0deg); }
  28% { transform: translateY(-3px) scale(1.1) rotate(-5deg); }
  62% { transform: translateY(-.8px) scale(1.04) rotate(1.5deg); }
}
@keyframes brand-letter-wave {
  0%, 100% { transform: translateY(0); }
  34% { transform: translateY(-4px); }
}
@keyframes brand-color-lap {
  to { stroke-dashoffset: calc(var(--start-offset) - var(--loop-length)); }
}
@media (prefers-reduced-motion: reduce) {
  .is-playing .animated-logo,
  .is-playing .color-track,
  .is-playing .brand-letter { animation: none; }
  .is-playing .color-flow { opacity: 0; }
}
</style>
