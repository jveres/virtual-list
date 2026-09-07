import { renderMarkdown } from "../shared/markdown.js";
import {
  createPhotoPreview,
  type PhotoPreviewItem,
} from "../shared/photo-preview.js";
import type { ChatAttachment } from "./attachments.js";

interface ImageMessage {
  id: number;
  markdown: string;
  attachments?: ChatAttachment[];
}

interface ChatImage extends PhotoPreviewItem {
  url: string;
  label: string;
  messageId?: number;
  ordinal?: number;
}

/** Adapt mounted chat images to the gallery viewer without changing Markdown. */
export function createChatImagePreview(
  viewport: HTMLElement,
  getMessages?: () => readonly ImageMessage[],
): {
  dispose(): void;
} {
  const preview = createPhotoPreview<ChatImage>({
    viewport,
    thumbnailUrl: (photo) => photo.url,
    previewUrl: (photo) => photo.url,
    detailsText: (photo) => photo.label,
    nativeImageMenu: "preview-on-ios",
    roundedCorners: false,
    getAdjacentPhoto: (photo, direction) => {
      if (
        getMessages &&
        photo.messageId !== undefined &&
        photo.ordinal !== undefined
      ) {
        const messages = getMessages();
        const index = messages.findIndex(
          (message) => message.id === photo.messageId,
        );
        if (index < 0) return null;
        const current = messages[index];
        if (!current) return null;
        const images = messageImages(current);
        const imageIndex = images.findIndex((image) => image.id === photo.id);
        if (imageIndex < 0) return null;
        const sibling = images[imageIndex + direction];
        if (sibling) return sibling;
        for (
          let i = index + direction;
          i >= 0 && i < messages.length;
          i += direction
        ) {
          const message = messages[i];
          if (!message) continue;
          const neighbors = messageImages(message);
          const neighbor = direction === 1 ? neighbors[0] : neighbors.at(-1);
          if (neighbor) return neighbor;
        }
        return null;
      }
      const ordered = Array.from(
        viewport.querySelectorAll<HTMLImageElement>("img"),
      ).flatMap((image) => {
        const entry = photos.get(image);
        return entry ? [entry] : [];
      });
      const index = ordered.findIndex((entry) => entry.id === photo.id);
      return index < 0 ? null : (ordered[index + direction] ?? null);
    },
  });
  const photos = new WeakMap<HTMLImageElement, ChatImage>();
  const bound = new Set<HTMLImageElement>();
  let nextId = 1;
  const cache = new WeakMap<
    ImageMessage,
    {
      markdown: string;
      attachments: ChatAttachment[] | undefined;
      images: ChatImage[];
    }
  >();

  function messageImages(message: ImageMessage): ChatImage[] {
    const cached = cache.get(message);
    if (
      cached?.markdown === message.markdown &&
      cached.attachments === message.attachments
    )
      return cached.images;
    const template = document.createElement("template");
    template.innerHTML = renderMarkdown(message.markdown);
    const entries = Array.from(template.content.querySelectorAll("img")).map(
      (image) => ({
        url: image.getAttribute("src") ?? "",
        label: image.alt || "Chat image",
      }),
    );
    for (const attachment of message.attachments ?? []) {
      if (attachment.mimeType.startsWith("image/"))
        entries.push({ url: attachment.dataUrl, label: attachment.name });
    }
    const images = entries.flatMap((entry, ordinal) => {
      let url: URL;
      try {
        url = new URL(entry.url, document.baseURI);
      } catch {
        return [];
      }
      if (!["https:", "http:", "blob:", "data:"].includes(url.protocol))
        return [];
      const old = cached?.images.find((image) => image.ordinal === ordinal);
      return [
        {
          id: old?.url === url.href ? old.id : nextId++,
          url: url.href,
          label: entry.label,
          messageId: message.id,
          ordinal,
          width: 0,
          height: 0,
          aspectRatio: 1,
        },
      ];
    });
    cache.set(message, {
      markdown: message.markdown,
      attachments: message.attachments,
      images,
    });
    return images;
  }

  function bind(image: HTMLImageElement): void {
    if (
      !viewport.contains(image) ||
      !image.complete ||
      image.naturalWidth === 0 ||
      image.naturalHeight === 0
    ) {
      unbind(image);
      return;
    }
    const url = image.currentSrc || image.src;
    const previous = photos.get(image);
    const row = image.closest<HTMLElement>("[data-key]");
    const message = getMessages?.().find(
      (entry) => String(entry.id) === row?.dataset.key,
    );
    const ordinal = row
      ? Array.from(row.querySelectorAll("img")).indexOf(image)
      : -1;
    const candidate = message
      ? messageImages(message).find((photo) => photo.ordinal === ordinal)
      : undefined;
    // A live Markdown renderer can expose a new image before its model catches
    // up. Preview it locally, but never attach another image's navigation ID.
    const entry = candidate?.url === image.src ? candidate : undefined;
    const photo: ChatImage = {
      ...entry,
      id: entry?.id ?? previous?.id ?? nextId++,
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
    if (
      bound.has(image) &&
      previous?.id === photo.id &&
      previous.url === photo.url &&
      previous.label === photo.label &&
      previous.width === photo.width &&
      previous.height === photo.height
    )
      return;
    preview.unbind(image);
    photos.set(image, photo);
    bound.add(image);
    preview.bind(image, photo);
    image.setAttribute("aria-label", `Preview ${photo.label}`);
  }

  function unbind(image: HTMLImageElement): void {
    preview.unbind(image);
    bound.delete(image);
    photos.delete(image);
  }

  const observer = new MutationObserver((records) => {
    // Editing or moving one image changes the ordinal of surviving siblings.
    // Reconcile against final DOM order, after all records in this delivery.
    if (
      records.some(
        (record) =>
          record.type === "childList" || record.attributeName === "data-key",
      )
    ) {
      for (const image of bound) if (!viewport.contains(image)) unbind(image);
      for (const image of viewport.querySelectorAll<HTMLImageElement>("img"))
        bind(image);
      return;
    }
    for (const record of records) {
      if (
        record.type === "attributes" &&
        record.target instanceof HTMLImageElement
      )
        bind(record.target);
    }
  });
  observer.observe(viewport, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "alt", "data-key"],
  });
  const onLoad = (event: Event) => {
    if (event.target instanceof HTMLImageElement) bind(event.target);
  };
  const onError = (event: Event) => {
    if (event.target instanceof HTMLImageElement) unbind(event.target);
  };
  const onClick = (event: MouseEvent) => {
    // Linked Markdown images open the preview rather than navigating away.
    if (event.target instanceof HTMLImageElement && bound.has(event.target))
      event.preventDefault();
  };
  viewport.addEventListener("load", onLoad, true);
  viewport.addEventListener("error", onError, true);
  viewport.addEventListener("click", onClick, true);
  for (const image of viewport.querySelectorAll<HTMLImageElement>("img"))
    bind(image);

  return {
    dispose() {
      observer.disconnect();
      viewport.removeEventListener("load", onLoad, true);
      viewport.removeEventListener("error", onError, true);
      viewport.removeEventListener("click", onClick, true);
      for (const image of bound) preview.unbind(image);
      bound.clear();
      preview.dispose();
    },
  };
}
