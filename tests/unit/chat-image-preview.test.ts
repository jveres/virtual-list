// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { initMarkdownViewerSync } from "markdown-viewer";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { renderMarkdown } from "../../demos/shared/markdown.js";
import type {
  PhotoPreviewController,
  PhotoPreviewItem,
  PhotoPreviewOptions,
} from "../../demos/shared/photo-preview.js";
import {
  attachmentChip,
  disposeAttachmentChips,
} from "../../demos/streaming/attachments.js";
import { createChatImagePreview } from "../../demos/streaming/image-preview.js";
import { attachmentImagePlatform } from "../helpers/attachment-image-platform.js";

// Keep the real Markdown parser and DOM observer; replace only the animated
// viewer boundary so tests can inspect the photos and navigation it receives.
const viewer = vi.hoisted(() => ({
  create:
    vi.fn<
      (
        options: PhotoPreviewOptions<PhotoPreviewItem>,
      ) => PhotoPreviewController<PhotoPreviewItem>
    >(),
}));
vi.mock("../../demos/shared/photo-preview.js", () => ({
  createPhotoPreview: viewer.create,
}));

interface Message {
  id: number;
  markdown: string;
}

let bindings: Map<HTMLElement, PhotoPreviewItem>;
let disposers: Array<() => void>;

beforeAll(() => {
  const wasm = new URL(
    "../../comrak-wasm/pkg/comrak.wasm",
    import.meta.resolve("markdown-viewer"),
  );
  initMarkdownViewerSync({ module: readFileSync(wasm) });
});

beforeEach(() => {
  bindings = new Map();
  disposers = [];
  // The parser tolerates unavailable glyph metrics; avoid jsdom's canvas warning.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  viewer.create.mockImplementation(() => ({
    bind: (element, photo) => {
      bindings.set(element, photo);
    },
    unbind: (element) => {
      bindings.delete(element);
    },
    dispose: () => bindings.clear(),
    close: async () => {},
  }));
});

afterEach(() => {
  for (const dispose of disposers) dispose();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function message(id: number, ...sources: string[]): Message {
  return {
    id,
    markdown: sources
      .map((source, index) => `![Image ${id}.${index}](${source})`)
      .join("\n\n"),
  };
}

function rowFor(entry: Message | undefined): HTMLDivElement {
  if (!entry) throw new Error("Missing message fixture");
  const row = document.createElement("div");
  row.dataset.key = String(entry.id);
  row.innerHTML = renderMarkdown(entry.markdown);
  for (const image of row.querySelectorAll("img")) {
    // jsdom does not decode images or select responsive sources.
    Object.defineProperties(image, {
      complete: { configurable: true, value: true },
      naturalWidth: { configurable: true, value: 120 },
      naturalHeight: { configurable: true, value: 80 },
      currentSrc: {
        configurable: true,
        get: () =>
          new URL(image.getAttribute("src") ?? "", document.baseURI).href,
      },
    });
  }
  return row;
}

function imageAt(row: HTMLElement, ordinal = 0): HTMLImageElement {
  const image = row.querySelectorAll("img")[ordinal];
  if (!image) throw new Error(`Missing image ${ordinal}`);
  return image;
}

function bindRows(messages: Message[], ...rows: HTMLElement[]) {
  const viewport = document.createElement("div");
  viewport.append(...rows);
  document.body.append(viewport);
  const getMessages = vi.fn(() => messages);
  const preview = createChatImagePreview(viewport, getMessages);
  disposers.push(() => preview.dispose());
  const options = viewer.create.mock.calls.at(-1)?.[0];
  if (!options?.getAdjacentPhoto) throw new Error("Missing preview navigation");
  return {
    viewport,
    preview,
    options,
    adjacent: options.getAdjacentPhoto,
    getMessages,
  };
}

function photoFor(image: HTMLImageElement): PhotoPreviewItem {
  const photo = bindings.get(image);
  if (!photo) throw new Error("Image has no preview binding");
  return photo;
}

describe("chat image preview source identity", () => {
  it("should retain unchanged image bindings across immutable streaming updates", async () => {
    const messages = [message(1, "/first.png", "/second.png")];
    const row = rowFor(messages[0]);
    const text = document.createElement("p");
    row.append(text);
    const { adjacent } = bindRows(messages, row);
    const first = photoFor(imageAt(row));
    const second = photoFor(imageAt(row, 1));
    for (let i = 0; i < 10; i++) {
      messages[0] = {
        ...messages[0]!,
        markdown: `${messages[0]!.markdown} token`,
      };
      text.textContent = `Streaming chunk ${i}`;
      await Promise.resolve();
      // Keeping the same binding object proves no unbind/rebind happened.
      expect(photoFor(imageAt(row))).toBe(first);
      expect(photoFor(imageAt(row, 1))).toBe(second);
      expect(adjacent(first, 1)?.id).toBe(second.id);
    }
  });
  it.each([1, 12])(
    "should bound row scans with %i images during a batch of streaming text mutations",
    async (count) => {
      const entry = message(
        1,
        ...Array.from({ length: count }, (_, index) => `/image-${index}.png`),
      );
      const row = rowFor(entry);
      const image = imageAt(row);
      const text = document.createElement("p");
      row.append(text);
      const { getMessages } = bindRows([entry], row);
      expect(getMessages).toHaveBeenCalledTimes(1);
      getMessages.mockClear();
      const original = photoFor(image);
      const scans = vi.spyOn(row, "querySelectorAll");

      for (let i = 0; i < 40; i++) text.textContent = `Streaming chunk ${i}`;
      await Promise.resolve();

      expect(photoFor(image).id).toBe(original.id);
      expect(getMessages).toHaveBeenCalledTimes(1);
      // One subtree scan and one ordinal scan, independent of image/mutation count.
      expect(
        scans.mock.calls.filter(([selector]) => selector === "img"),
      ).toHaveLength(2);
    },
  );

  it("should navigate past an attachment and preserve preview identity after its display URL is released", () => {
    const platform = attachmentImagePlatform();
    const attachment = {
      name: "image.png",
      mimeType: "image/png",
      size: 3,
      dataUrl: "data:image/png;base64,YWJj",
    };
    const entry = { id: 1, markdown: "", attachments: [attachment] };
    const row = rowFor(entry);
    const chip = attachmentChip(attachment);
    row.append(chip);
    const image = imageAt(row);
    Object.defineProperties(image, {
      complete: { value: true },
      naturalWidth: { value: 40 },
      naturalHeight: { value: 40 },
      currentSrc: { get: () => image.src },
    });
    const { options, adjacent } = bindRows(
      [entry, message(2, "/next.png")],
      row,
    );
    const photo = photoFor(image);

    disposeAttachmentChips(row);
    const next = adjacent(photo, 1);

    expect(platform.blobs.size).toBe(0);
    // The data URL stays the identity; the viewer displays it through its own
    // object URL (WebKit decodes data-URL images again under a moving drag).
    expect((photo as PhotoPreviewItem & { url: string }).url).toBe(
      attachment.dataUrl,
    );
    const shown = options.previewUrl(photo, 1800);
    expect(shown).toMatch(/^blob:/);
    expect(options.previewUrl(photo, 1800)).toBe(shown);
    if (!next) throw new Error("Missing next image");
    expect(options.previewUrl(next, 1800)).toBe(
      new URL("/next.png", document.baseURI).href,
    );
    expect(adjacent(next, -1)?.id).toBe(photo.id);
  });

  it("should navigate relative sources to an unseen message while displaying the selected responsive source", async () => {
    const messages = [
      message(1, "./first.png?width=1&variant=2"),
      message(2, "../second.png"),
    ];
    const firstRow = rowFor(messages[0]);
    const first = imageAt(firstRow);
    const selected = "https://images.example.test/first@2x.png";
    first.srcset = `${selected} 2x`;
    Object.defineProperty(first, "currentSrc", { value: selected });
    const { viewport, options, adjacent } = bindRows(messages, firstRow);
    const original = photoFor(first);

    const next = adjacent(original, 1);

    expect(options.previewUrl(original, 1800)).toBe(selected);
    expect(next).not.toBeNull();
    if (!next) throw new Error("Missing unseen next image");
    expect(options.previewUrl(next, 1800)).toBe(
      new URL("../second.png", document.baseURI).href,
    );
    const secondRow = rowFor(messages[1]);
    viewport.append(secondRow);
    await Promise.resolve();
    expect(photoFor(imageAt(secondRow)).id).toBe(next.id);
    expect(adjacent(photoFor(imageAt(secondRow)), -1)?.id).toBe(original.id);
  });

  it("should keep duplicate source URLs distinct by image ordinal", () => {
    const entry = message(1, "/same.png", "/same.png");
    const row = rowFor(entry);
    const { adjacent } = bindRows([entry], row);
    const first = photoFor(imageAt(row));
    const second = photoFor(imageAt(row, 1));

    expect(second.id).not.toBe(first.id);
    expect(adjacent(first, 1)?.id).toBe(second.id);
    expect(adjacent(second, -1)?.id).toBe(first.id);
  });

  it("should resolve relative identity against a changed document base while keeping the loaded display URL", async () => {
    const base = document.createElement("base");
    base.href = "https://before.example.test/chat/";
    document.head.append(base);
    disposers.push(() => base.remove());
    const messages = [message(1, "./image.png"), message(2, "./next.png")];
    const row = rowFor(messages[0]);
    const image = imageAt(row);
    const selected = "https://before.example.test/chat/image.png";
    Object.defineProperty(image, "currentSrc", { value: selected });
    const { options, adjacent } = bindRows(messages, row);
    const original = photoFor(image);

    base.href = "https://after.example.test/archive/";
    // jsdom keeps a previously read img.src stale until baseURI refreshes its
    // lazy base-URL cache. Establish the changed document base before rebinding.
    expect(document.baseURI).toBe("https://after.example.test/archive/");
    image.alt = "Updated image label";
    await Promise.resolve();

    const updated = photoFor(image);
    expect(updated.id).not.toBe(original.id);
    expect(options.previewUrl(updated, 1800)).toBe(selected);
    const next = adjacent(updated, 1);
    if (!next) throw new Error("Missing next image after base URL change");
    expect(options.previewUrl(next, 1800)).toBe(
      "https://after.example.test/archive/next.png",
    );
    expect(adjacent(next, -1)?.id).toBe(updated.id);
  });

  it("should preserve navigation identity for an image selected by its picture parent", async () => {
    const messages = [message(1, "./fallback.png"), message(2, "./next.png")];
    const row = rowFor(messages[0]);
    const image = imageAt(row);
    const picture = document.createElement("picture");
    const source = document.createElement("source");
    const selected = "https://images.example.test/wide.webp";
    source.srcset = selected;
    image.replaceWith(picture);
    picture.append(source, image);
    Object.defineProperty(image, "currentSrc", { value: selected });
    const { options, adjacent } = bindRows(messages, row);
    const original = photoFor(image);

    const next = adjacent(original, 1);

    expect(options.previewUrl(original, 1800)).toBe(selected);
    if (!next) throw new Error("Missing next image after picture");
    expect(options.previewUrl(next, 1800)).toBe(
      new URL("./next.png", document.baseURI).href,
    );
    expect(adjacent(next, -1)?.id).toBe(original.id);

    const replacement = "https://images.example.test/narrow.webp";
    Object.defineProperty(image, "currentSrc", { value: replacement });
    source.srcset = replacement;
    image.dispatchEvent(new Event("load"));
    await Promise.resolve();

    const updated = photoFor(image);
    expect(updated.id).toBe(original.id);
    expect(options.previewUrl(updated, 1800)).toBe(replacement);
    expect(adjacent(updated, 1)?.id).toBe(next.id);
  });

  it("should invalidate navigation identities when a DOM source changes and is restored", async () => {
    const messages = [message(1, "/a.png"), message(2, "/next.png")];
    const row = rowFor(messages[0]);
    const image = imageAt(row);
    const { adjacent } = bindRows(messages, row);
    const original = photoFor(image);
    const next = adjacent(original, 1);
    if (!next) throw new Error("Missing next image");

    image.src = "/b.png";
    await Promise.resolve();
    const changed = photoFor(image);
    expect(changed.id).not.toBe(original.id);
    expect(adjacent(changed, 1)).toBeNull();

    image.src = "/a.png";
    await Promise.resolve();
    const restored = photoFor(image);
    expect(restored.id).not.toBe(changed.id);
    expect(restored.id).not.toBe(original.id);
    expect(adjacent(restored, 1)?.id).toBe(next.id);
    expect(adjacent(next, -1)?.id).toBe(restored.id);
  });

  it("should reconcile identity when an image moves between rows and a row is rekeyed", async () => {
    const messages = [1, 2, 3].map((id) => message(id, "/same.png"));
    const firstRow = rowFor(messages[0]);
    const secondRow = document.createElement("div");
    secondRow.dataset.key = "2";
    const image = imageAt(firstRow);
    const { adjacent } = bindRows(messages, firstRow, secondRow);
    const original = photoFor(image);

    secondRow.append(image);
    await Promise.resolve();
    const moved = photoFor(image);
    expect(moved.id).not.toBe(original.id);
    const third = adjacent(moved, 1);
    if (!third) throw new Error("Missing third message image");

    secondRow.dataset.key = "3";
    await Promise.resolve();
    const rekeyed = photoFor(image);
    expect(rekeyed.id).toBe(third.id);
    expect(adjacent(rekeyed, -1)?.id).toBe(moved.id);
  });

  it("should update a responsive display URL without changing the source identity", async () => {
    const entry = message(1, "/original.png");
    const row = rowFor(entry);
    const image = imageAt(row);
    const { options } = bindRows([entry], row);
    const original = photoFor(image);
    const selected = "https://images.example.test/selected.png";

    Object.defineProperty(image, "currentSrc", { value: selected });
    image.srcset = `${selected} 2x`;
    await Promise.resolve();

    const updated = photoFor(image);
    expect(updated.id).toBe(original.id);
    expect(options.previewUrl(updated, 1800)).toBe(selected);
  });

  it("should reuse currentSrc without rereading a large data URL", () => {
    const source = `data:image/png;base64,${"A".repeat(128 * 1024)}`;
    const entry = message(1, source);
    const row = rowFor(entry);
    const image = imageAt(row);
    Object.defineProperty(image, "currentSrc", { value: source });
    const srcReads = vi.spyOn(image, "src", "get");
    const attributeReads = vi.spyOn(image, "getAttribute");

    const { options } = bindRows([entry], row);

    expect(options.previewUrl(photoFor(image), 1800)).toBe(source);
    expect(srcReads).not.toHaveBeenCalled();
    expect(
      attributeReads.mock.calls.filter(([name]) => name === "src"),
    ).toEqual([]);
  });

  it("should resolve src only once when currentSrc is empty", () => {
    const entry = message(1, "/fallback.png");
    const row = rowFor(entry);
    const image = imageAt(row);
    Object.defineProperty(image, "currentSrc", { value: "" });
    const srcReads = vi.spyOn(image, "src", "get");

    const { options } = bindRows([entry], row);

    expect(options.previewUrl(photoFor(image), 1800)).toBe(
      new URL("/fallback.png", document.baseURI).href,
    );
    expect(srcReads).toHaveBeenCalledTimes(1);
  });

  it("should release detached and failed images and stop rebinding after disposal", async () => {
    const entry = message(1, "/image.png");
    const row = rowFor(entry);
    const image = imageAt(row);
    const { viewport, preview } = bindRows([entry], row);
    const original = photoFor(image);

    row.remove();
    await Promise.resolve();
    expect(bindings.has(image)).toBe(false);
    viewport.append(row);
    await Promise.resolve();
    expect(photoFor(image).id).toBe(original.id);

    image.dispatchEvent(new Event("error"));
    expect(bindings.has(image)).toBe(false);
    image.dispatchEvent(new Event("load"));
    expect(photoFor(image).id).toBe(original.id);

    preview.dispose();
    image.src = "/after-dispose.png";
    image.dispatchEvent(new Event("load"));
    await Promise.resolve();
    expect(bindings.size).toBe(0);
    expect(
      image.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      ),
    ).toBe(true);
  });
});
