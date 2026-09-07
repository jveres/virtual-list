import {
  createPhotoPreview,
  type PhotoPreviewItem,
} from "../shared/photo-preview.js";

interface ChatImage extends PhotoPreviewItem {
  url: string;
  label: string;
}

/** Adapt mounted chat images to the gallery viewer without changing Markdown. */
export function createChatImagePreview(viewport: HTMLElement): {
  dispose(): void;
} {
  const preview = createPhotoPreview<ChatImage>({
    viewport,
    thumbnailUrl: (photo) => photo.url,
    previewUrl: (photo) => photo.url,
    detailsText: (photo) => photo.label,
    nativeImageMenu: true,
    roundedCorners: false,
  });
  const photos = new WeakMap<HTMLImageElement, ChatImage>();
  const bound = new Set<HTMLImageElement>();
  let nextId = 1;

  function bind(image: HTMLImageElement): void {
    if (
      !viewport.contains(image) ||
      !image.complete ||
      image.naturalWidth === 0 ||
      image.naturalHeight === 0
    )
      return;
    const url = image.currentSrc || image.src;
    const previous = photos.get(image);
    if (bound.has(image) && previous?.url === url) return;
    preview.unbind(image);
    const photo: ChatImage = {
      id: previous?.id ?? nextId++,
      url,
      label:
        image.alt ||
        image.closest(".attachment-chip")?.querySelector(".attachment-name")
          ?.textContent ||
        "Chat image",
      width: image.naturalWidth,
      height: image.naturalHeight,
      aspectRatio: image.naturalHeight / image.naturalWidth,
    };
    photos.set(image, photo);
    bound.add(image);
    preview.bind(image, photo);
    image.setAttribute("aria-label", `Preview ${photo.label}`);
  }

  function imagesIn(node: Node): HTMLImageElement[] {
    if (!(node instanceof Element)) return [];
    return [
      ...(node instanceof HTMLImageElement ? [node] : []),
      ...node.querySelectorAll<HTMLImageElement>("img"),
    ];
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (
        record.type === "attributes" &&
        record.target instanceof HTMLImageElement
      )
        bind(record.target);
      for (const node of record.addedNodes)
        for (const image of imagesIn(node)) bind(image);
      for (const node of record.removedNodes) {
        for (const image of imagesIn(node)) {
          // A retained row can move between slots in this same delivery.
          if (viewport.contains(image)) continue;
          preview.unbind(image);
          bound.delete(image);
        }
      }
    }
  });
  observer.observe(viewport, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src", "srcset"],
  });
  const onLoad = (event: Event) => {
    if (event.target instanceof HTMLImageElement) bind(event.target);
  };
  const onClick = (event: MouseEvent) => {
    // Linked Markdown images open the preview rather than navigating away.
    if (event.target instanceof HTMLImageElement && bound.has(event.target))
      event.preventDefault();
  };
  viewport.addEventListener("load", onLoad, true);
  viewport.addEventListener("click", onClick, true);
  for (const image of viewport.querySelectorAll<HTMLImageElement>("img"))
    bind(image);

  return {
    dispose() {
      observer.disconnect();
      viewport.removeEventListener("load", onLoad, true);
      viewport.removeEventListener("click", onClick, true);
      for (const image of bound) preview.unbind(image);
      bound.clear();
      preview.dispose();
    },
  };
}
