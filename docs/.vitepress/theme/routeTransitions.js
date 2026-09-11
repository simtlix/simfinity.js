/* global document, window, requestAnimationFrame */
import { nextTick, watch } from 'vue';

export function installRouteTransitions(router) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let animation;
  let navigation = 0;

  // Observe completed route changes; never hold the router for an animation.
  watch(() => router.route.path, () => {
    const current = ++navigation;
    animation?.cancel();
    document.documentElement.setAttribute('data-page-changing', '');
    nextTick(() => requestAnimationFrame(() => {
      if (current !== navigation) return;
      document.documentElement.removeAttribute('data-page-changing');
      if (reduced.matches) return;
      animation = document.querySelector('#VPContent')?.animate(
        [{ opacity: .8 }, { opacity: 1 }],
        { duration: 160, easing: 'ease-out' },
      );
    }));
  }, { flush: 'sync' });
}
