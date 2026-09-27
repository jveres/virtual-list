/** Initial viewport arrivals are immediate; later scroll entrances fade after decoding. */
export function createImageReveal(viewport: HTMLElement) {
  let hasScrolled = false;
  const onScroll = () => {
    hasScrolled = true;
  };
  viewport.addEventListener("scroll", onScroll, { passive: true });
  const watched = new Map<
    HTMLImageElement,
    { visible: boolean; fade: boolean; ready: () => void }
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
        decodedSource: "",
        decodingSource: "",
        ready: () => {
          if (!image.complete || image.naturalWidth === 0) return;
          const src = image.currentSrc || image.src;
          const reveal = () => {
            if (!state.visible) return;
            image.classList.toggle("fade-in", state.fade);
            image.classList.add("revealed");
          };
          if (state.decodedSource === src) {
            reveal();
            return;
          }
          if (state.decodingSource === src) return;
          // Decode once while mounted in overscan, before the viewport entrance.
          state.decodingSource = src;
          void image.decode().then(
            () => {
              if (
                watched.get(image) === state &&
                (image.currentSrc || image.src) === src
              ) {
                state.decodedSource = src;
                state.decodingSource = "";
                reveal();
              }
            },
            () => {
              if (state.decodingSource === src) state.decodingSource = "";
            }, // A replaced/unmounted source must not reveal stale pixels.
          );
        },
      };
      watched.set(image, state);
      image.addEventListener("load", state.ready);
      observer.observe(image);
      state.ready();
    },
    remove,
    dispose(): void {
      viewport.removeEventListener("scroll", onScroll);
      for (const image of watched.keys()) remove(image);
      observer.disconnect();
    },
  };
}
