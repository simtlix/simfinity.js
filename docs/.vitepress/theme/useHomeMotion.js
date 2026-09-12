/* global window */
import { onMounted, onUnmounted } from 'vue';

// The page keeps native scrolling; decorative layers only move a few pixels.
export function useHomeMotion(root) {
  let dispose = () => {};

  onMounted(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const desktop = window.matchMedia('(min-width: 801px)');
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
    let stop = () => {};

    function setup() {
      stop();
      const page = root.value;
      if (!page || reducedMotion.matches) return;

      let frame = 0;
      let pointer = null;
      let heroPointer = null;
      const hero = page.querySelector('.sim-hero');
      let illuminated = null;
      const layers = [...page.querySelectorAll('[data-parallax]')];
      const reveal = 'IntersectionObserver' in window ? new window.IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-visible');
          reveal.unobserve(entry.target);
        }
      }, { threshold: .12, rootMargin: '0px 0px -24px 0px' }) : null;

      if (reveal) {
        page.classList.add('motion-ready');
        page.querySelectorAll('.reveal, [data-line-reveal]').forEach(element => reveal.observe(element));
      }

      function paint() {
        frame = 0;
        const height = window.innerHeight;
        for (const layer of layers) {
          const rect = layer.getBoundingClientRect();
          if (rect.bottom < -80 || rect.top > height + 80) continue;
          // Subtract the previous translation so it cannot feed back into itself.
          const previous = parseFloat(layer.style.getPropertyValue('--parallax-y')) || 0;
          const progress = Math.max(-1, Math.min(1, (height / 2 - (rect.top - previous + rect.height / 2)) / (height / 2 + rect.height / 2)));
          const offset = desktop.matches ? progress * Number(layer.dataset.parallax) : 0;
          layer.style.setProperty('--parallax-y', `${offset.toFixed(2)}px`);
        }
        if (hero && heroPointer) {
          const rect = hero.getBoundingClientRect();
          const x = (heroPointer.x - rect.left) / rect.width - .5;
          const y = (heroPointer.y - rect.top) / rect.height - .5;
          hero.style.setProperty('--hero-pointer-x', `${(x * 16).toFixed(2)}px`);
          hero.style.setProperty('--hero-pointer-y', `${(y * 12).toFixed(2)}px`);
          hero.style.setProperty('--hero-tilt-x', `${(-y * 10).toFixed(2)}deg`);
          hero.style.setProperty('--hero-tilt-y', `${(x * 12).toFixed(2)}deg`);
        }
        if (pointer && illuminated) {
          const rect = illuminated.getBoundingClientRect();
          illuminated.style.setProperty('--pointer-x', `${(pointer.x - rect.left).toFixed(1)}px`);
          illuminated.style.setProperty('--pointer-y', `${(pointer.y - rect.top).toFixed(1)}px`);
        }
      }

      function schedule() {
        if (!frame) frame = window.requestAnimationFrame(paint);
      }

      function clearPointer() {
        illuminated?.removeAttribute('data-engaged');
        illuminated = null;
        pointer = null;
      }

      function followPointer(event) {
        if (!finePointer.matches || event.pointerType === 'touch') return;
        heroPointer = event.target.closest('.sim-hero') ? { x: event.clientX, y: event.clientY } : null;
        if (heroPointer) schedule();
        const surface = event.target.closest('[data-spotlight]');
        if (surface !== illuminated) {
          clearPointer();
          illuminated = surface;
          illuminated?.setAttribute('data-engaged', '');
        }
        if (!illuminated) return;
        pointer = { x: event.clientX, y: event.clientY };
        schedule();
      }

      window.addEventListener('scroll', schedule, { passive: true });
      window.addEventListener('resize', schedule, { passive: true });
      page.addEventListener('pointermove', followPointer, { passive: true });
      page.addEventListener('pointerleave', clearPointer);
      schedule();

      stop = () => {
        reveal?.disconnect();
        window.cancelAnimationFrame(frame);
        window.removeEventListener('scroll', schedule);
        window.removeEventListener('resize', schedule);
        page.removeEventListener('pointermove', followPointer);
        page.removeEventListener('pointerleave', clearPointer);
        clearPointer();
        page.classList.remove('motion-ready');
        ['--hero-pointer-x', '--hero-pointer-y', '--hero-tilt-x', '--hero-tilt-y'].forEach(property => hero?.style.removeProperty(property));
        layers.forEach(layer => layer.style.removeProperty('--parallax-y'));
      };
    }

    setup();
    reducedMotion.addEventListener('change', setup);
    dispose = () => {
      stop();
      reducedMotion.removeEventListener('change', setup);
    };
  });

  onUnmounted(() => dispose());
}
