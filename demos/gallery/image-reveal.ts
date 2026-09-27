/** Initial viewport arrivals are immediate; later scroll entrances fade after decoding. */
export function createImageReveal(viewport: HTMLElement) {
  let hasScrolled = false;
  const onScroll = () => {
    hasScrolled = true;
  };
  viewport.addEventListener("scroll", onScroll, { passive: true });
  const watched = new Map<
    HTMLImageElement,
    { visible: boolean; fade: boolean; version: number; ready: () => void }
  >();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const image = entry.target as HTMLImageElement;
        const state = watched.get(image);
        if (!state) continue;
        const visible = entry.isIntersecting && entry.intersectionRatio > 0;
        if (state.visible === visible) continue;
        state.visible = visible;
        state.version++;
        if (visible) {
          state.fade = hasScrolled;
          state.ready();
        } else image.classList.remove("revealed", "fade-in");
      }
    },
    { root: viewport, threshold: [0, 0.01] },
  );

  function remove(image: HTMLImageElement): void {
    const state = watched.get(image);
    if (!state) return;
    watched.delete(image);
    observer.unobserve(image);
    image.removeEventListener("load", state.ready);
    image.classList.remove("revealed", "fade-in");
  }

  return {
    add(image: HTMLImageElement): void {
      if (watched.has(image)) return;
      const state = {
        visible: false,
        fade: false,
        version: 0,
        ready: () => {
          if (!state.visible || !image.complete || image.naturalWidth === 0)
            return;
          const version = ++state.version;
          const src = image.currentSrc || image.src;
          void image.decode().then(
            () => {
              if (
                watched.get(image) === state &&
                state.visible &&
                state.version === version &&
                (image.currentSrc || image.src) === src
              ) {
                image.classList.toggle("fade-in", state.fade);
                image.classList.add("revealed");
              }
            },
            () => {}, // A replaced/unmounted source must not reveal stale pixels.
          );
        },
      };
      watched.set(image, state);
      image.addEventListener("load", state.ready);
      observer.observe(image);
    },
    remove,
    dispose(): void {
      viewport.removeEventListener("scroll", onScroll);
      for (const image of watched.keys()) remove(image);
      observer.disconnect();
    },
  };
}
