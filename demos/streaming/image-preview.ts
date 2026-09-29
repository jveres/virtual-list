import { renderMarkdown } from "../shared/markdown.js";
import {
  createPhotoPreview,
  type PhotoPreviewItem,
} from "../shared/photo-preview.js";
import {
  attachmentImageSource,
  type ChatAttachment,
  imageObjectUrl,
} from "./attachments.js";
import {
  displaySource,
  readyDisplayCopy,
  useDisplayCopy,
} from "./display-copies.js";

/** Object URLs kept for recently viewed data-URL images. */
const DISPLAY_URL_LIMIT = 8;

interface ImageMessage {
  id: number;
  markdown: string;
  attachments?: ChatAttachment[];
}

interface ChatImage extends PhotoPreviewItem {
  url: string;
  label: string;
  /** Logical Markdown source, distinct from a responsive/display-copy URL. */
  source?: string;
  messageId?: number;
  ordinal?: number;
}

interface RowImages {
  message: ImageMessage | undefined;
  ordinals: Map<HTMLImageElement, number>;
}

/** A message's displayable image URLs in reading order: Markdown, then attachments. */
export function messageImageSources(
  message: Pick<ImageMessage, "markdown" | "attachments">,
): { url: string; label: string; ordinal: number }[] {
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
  // The ordinal counts every rendered image, matching mounted row order.
  return entries.flatMap((entry, ordinal) => {
    let url: URL;
    try {
      url = new URL(entry.url, document.baseURI);
    } catch {
      return [];
    }
    return ["https:", "http:", "blob:", "data:"].includes(url.protocol)
      ? [{ url: url.href, label: entry.label, ordinal }]
      : [];
  });
}

/** Adapt mounted chat images to the gallery viewer without changing Markdown. */
export function createChatImagePreview(
  viewport: HTMLElement,
  getMessages?: () => readonly ImageMessage[],
): {
  dispose(): void;
} {
  // The viewer shows data-URL images through object URLs: WebKit decodes a
  // data-URL image again in every frame of a dismiss drag (a 2 MB PNG costs
  // ~40 ms per frame). The data URL stays the photo's identity.
  const displayUrls = new Map<string, string>();
  const displayUrl = (url: string): string => {
    const cached = displayUrls.get(url);
    if (cached) {
      displayUrls.delete(url);
      displayUrls.set(url, cached);
      return cached;
    }
    const objectUrl = url.startsWith("data:") ? imageObjectUrl(url) : null;
    if (!objectUrl) return url;
    displayUrls.set(url, objectUrl);
    for (const [key, old] of displayUrls) {
      if (displayUrls.size <= DISPLAY_URL_LIMIT) break;
      URL.revokeObjectURL(old);
      displayUrls.delete(key);
    }
    return objectUrl;
  };
  const preview = createPhotoPreview<ChatImage>({
    closeFocusTarget: viewport,
    viewport,
    // Open from the copy the row already shows; the original fades in over it.
    thumbnailUrl: (photo) =>
      readyDisplayCopy(photo.url) ?? displayUrl(photo.url),
    previewUrl: (photo) => displayUrl(photo.url),
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
        if (index < 0) return adjacentMountedPhoto(photo, direction);
        const current = messages[index];
        if (!current) return adjacentMountedPhoto(photo, direction);
        const images = messageImages(current);
        const imageIndex = images.findIndex((image) => image.id === photo.id);
        if (imageIndex < 0) return adjacentMountedPhoto(photo, direction);
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
      return adjacentMountedPhoto(photo, direction);
    },
  });
  const photos = new WeakMap<HTMLImageElement, ChatImage>();
  const bound = new Set<HTMLImageElement>();
  let nextId = 1;
  // Binding already-rendered DOM must not parse Markdown on the scroll path.
  // Share identities with the lazy navigation index so an image first found
  // offscreen still closes onto the correct thumbnail when it later mounts.
  const identities = new WeakMap<
    ImageMessage,
    Map<number, { url: string; id: number }>
  >();
  const cache = new WeakMap<
    ImageMessage,
    {
      markdown: string;
      attachments: ChatAttachment[] | undefined;
      images: ChatImage[];
    }
  >();

  function adjacentMountedPhoto(
    photo: ChatImage,
    direction: -1 | 1,
  ): ChatImage | null {
    const ordered = Array.from(
      viewport.querySelectorAll<HTMLImageElement>("img"),
    ).flatMap((image) => {
      const entry = photos.get(image);
      return entry ? [entry] : [];
    });
    const index = ordered.findIndex((entry) => entry.id === photo.id);
    return index < 0 ? null : (ordered[index + direction] ?? null);
  }

  function imageId(
    message: ImageMessage,
    ordinal: number,
    url: string,
    boundPhoto?: ChatImage,
  ): number {
    let entries = identities.get(message);
    if (!entries) {
      entries = new Map();
      identities.set(message, entries);
    }
    const previous = entries.get(ordinal);
    if (previous?.url === url) return previous.id;
    // Immutable message updates keep unchanged image bindings. A changed
    // logical source or ordinal still receives a new navigation identity.
    const id =
      previous === undefined &&
      boundPhoto?.messageId === message.id &&
      boundPhoto.ordinal === ordinal &&
      boundPhoto.source === url
        ? boundPhoto.id
        : nextId++;
    entries.set(ordinal, { url, id });
    // DOM edits can replace an image and then restore it without changing the
    // stored Markdown. A cached navigation index must use the new binding ID.
    cache.delete(message);
    return id;
  }

  // Called only by explicit preview navigation, never by image binding.
  function messageImages(message: ImageMessage): ChatImage[] {
    const cached = cache.get(message);
    if (
      cached?.markdown === message.markdown &&
      cached.attachments === message.attachments
    )
      return cached.images;
    const images = messageImageSources(message).map(
      ({ url, label, ordinal }) => ({
        id: imageId(message, ordinal, url),
        url,
        label,
        messageId: message.id,
        ordinal,
        width: 0,
        height: 0,
        aspectRatio: 1,
      }),
    );
    cache.set(message, {
      markdown: message.markdown,
      attachments: message.attachments,
      images,
    });
    return images;
  }

  function bindAll(images: Iterable<HTMLImageElement>): void {
    // A mutation delivery sees one final DOM order. Resolve each row once,
    // including when many images share a large, still-streaming reply.
    const rows = new Map<HTMLElement, RowImages>();
    let messages: readonly ImageMessage[] | undefined;
    const rowImages = (row: HTMLElement): RowImages => {
      let entry = rows.get(row);
      if (!entry) {
        messages ??= getMessages?.() ?? [];
        entry = {
          message: messages.find((item) => String(item.id) === row.dataset.key),
          ordinals: new Map(
            Array.from(
              row.querySelectorAll<HTMLImageElement>("img"),
              (image, index) => [image, index],
            ),
          ),
        };
        rows.set(row, entry);
      }
      return entry;
    };
    for (const image of images) bind(image, rowImages);
  }

  function bind(
    image: HTMLImageElement,
    rowImages: (row: HTMLElement) => RowImages,
  ): void {
    if (
      !viewport.contains(image) ||
      !image.complete ||
      image.naturalWidth === 0 ||
      image.naturalHeight === 0
    ) {
      unbind(image);
      return;
    }
    const selectedUrl = image.currentSrc;
    const url = displaySource(
      image,
      attachmentImageSource(image, selectedUrl || image.src),
    );
    useDisplayCopy(image, url);
    const previous = photos.get(image);
    const row = image.closest<HTMLElement>("[data-key]");
    const entries = row ? rowImages(row) : undefined;
    const message = entries?.message;
    const ordinal = entries?.ordinals.get(image) ?? -1;
    const source =
      !selectedUrl ||
      (url.startsWith("data:") &&
        !image.hasAttribute("srcset") &&
        image.parentElement?.tagName !== "PICTURE")
        ? url
        : image.src;
    const photo: ChatImage = {
      // Navigation checks this identity against sanitized message content.
      // A live DOM image ahead of the model cannot match another image's ID.
      // Ordinary data images already expose their source in currentSrc.
      // Reading src (even via getAttribute) again is costly for large data URLs.
      // Keep logical src resolution for responsive and base-relative images.
      ...(message && ordinal >= 0
        ? {
            id: imageId(message, ordinal, source, previous),
            messageId: message.id,
            ordinal,
            source,
          }
        : { id: previous?.id ?? nextId++ }),
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
    // Reconcile affected rows against final DOM order, not every mounted image:
    // unrelated virtual rows must not repeatedly read large data-URL strings.
    const affected = new Set<HTMLImageElement>();
    const roots = new Set<Node>();
    const collect = (node: Node): void => {
      if (!(node instanceof Element)) return;
      if (node instanceof HTMLImageElement) affected.add(node);
      for (const image of node.querySelectorAll<HTMLImageElement>("img"))
        affected.add(image);
    };
    for (const record of records) {
      if (record.type === "childList" || record.attributeName === "data-key") {
        if (record.target instanceof Element) {
          const row = record.target.closest("[data-key], .attachment-chip");
          if (row) roots.add(row);
        }
        if (record.attributeName === "data-key") roots.add(record.target);
        for (const node of record.addedNodes) roots.add(node);
        for (const node of record.removedNodes) roots.add(node);
      } else if (record.target instanceof HTMLImageElement) {
        affected.add(record.target);
      }
    }
    // A renderer can mutate the same row many times in one delivery. Its
    // final subtree is unchanged while we inspect the records; scan it once.
    for (const root of roots) collect(root);
    bindAll(affected);
  });
  observer.observe(viewport, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "alt", "data-key"],
  });
  const onLoad = (event: Event) => {
    if (event.target instanceof HTMLImageElement) bindAll([event.target]);
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
  bindAll(viewport.querySelectorAll<HTMLImageElement>("img"));

  return {
    dispose() {
      observer.disconnect();
      viewport.removeEventListener("load", onLoad, true);
      viewport.removeEventListener("error", onError, true);
      viewport.removeEventListener("click", onClick, true);
      for (const image of bound) preview.unbind(image);
      bound.clear();
      preview.dispose();
      for (const url of displayUrls.values()) URL.revokeObjectURL(url);
      displayUrls.clear();
    },
  };
}
