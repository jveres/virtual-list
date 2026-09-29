// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

class CopyWorker {
  static instances: CopyWorker[] = [];
  static failPost = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  requests: { id: number; url: string; maxEdge: number }[] = [];
  terminated = false;
  constructor() {
    CopyWorker.instances.push(this);
  }
  postMessage(request: { id: number; url: string; maxEdge: number }): void {
    if (CopyWorker.failPost) throw new Error("Worker is unavailable");
    this.requests.push(request);
  }
  terminate(): void {
    this.terminated = true;
  }
  respond(index: number, blob: Blob | null): void {
    this.onmessage?.(
      new MessageEvent("message", {
        data: { id: this.requests[index]?.id, blob },
      }),
    );
  }
}

const activeObjectUrls = new Map<string, number>();
let blobSequence = 0;

beforeEach(() => {
  vi.resetModules();
  CopyWorker.instances = [];
  CopyWorker.failPost = false;
  activeObjectUrls.clear();
  blobSequence = 0;
  vi.stubGlobal("Worker", CopyWorker);
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.stubGlobal("createImageBitmap", vi.fn());
  vi.stubGlobal("CSS", { supports: () => true });
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn((blob: Blob) => {
        const suffix = blobSequence++;
        const url = `blob:display-copy${suffix ? `-${suffix}` : ""}`;
        activeObjectUrls.set(url, blob.size);
        return url;
      });
      static revokeObjectURL = vi.fn((url: string) => {
        activeObjectUrls.delete(url);
      });
    },
  );
  // This global is constructed with `new Image()` by the browser integration.
  // biome-ignore lint/complexity/useArrowFunction: arrows are not constructors.
  vi.stubGlobal("Image", function () {
    const image = document.createElement("img");
    image.decode = async () => {};
    return image;
  });
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function original(source = "data:image/png;base64,large"): HTMLImageElement {
  const image = document.createElement("img");
  image.src = source;
  Object.defineProperties(image, {
    naturalWidth: { value: 4000 },
    naturalHeight: { value: 3000 },
    currentSrc: { get: () => image.src },
  });
  return image;
}

function activeWorker(): CopyWorker {
  const worker = CopyWorker.instances[0];
  if (!worker) throw new Error("No copy worker");
  return worker;
}

it("should share the finished copy and preserve the original preview source", async () => {
  const { useDisplayCopy, readyDisplayCopy, displaySource } = await import(
    "../../demos/streaming/display-copies.js"
  );
  const image = original();
  const source = image.src;
  useDisplayCopy(image, source);
  useDisplayCopy(image, source);
  const worker = activeWorker();
  expect(worker.requests).toHaveLength(1);

  worker.respond(0, new Blob(["copy"]));

  await vi.waitFor(() => expect(image.src).toBe("blob:display-copy"));
  expect(readyDisplayCopy(source)).toBe(image.src);
  expect(displaySource(image, image.src)).toBe(source);
  expect([image.width, image.height]).toEqual([4000, 3000]);
});

it.each(["error", "messageerror"] as const)(
  "should release a failed worker on %s and leave originals usable",
  async (kind) => {
    const { useDisplayCopy, readyDisplayCopy } = await import(
      "../../demos/streaming/display-copies.js"
    );
    const images = [original(), original("data:image/png;base64,other")];
    const sources = images.map((image) => image.src);
    for (const image of images) useDisplayCopy(image, image.src);
    const worker = activeWorker();

    if (kind === "error")
      worker.onerror?.(new ErrorEvent("error", { cancelable: true }));
    else worker.onmessageerror?.(new MessageEvent("messageerror"));

    expect(worker.terminated).toBe(true);
    expect(worker.onmessage).toBeNull();
    for (let index = 0; index < images.length; index++) {
      worker.respond(index, new Blob(["late response"]));
      const image = images[index];
      if (image) useDisplayCopy(image, image.src);
    }
    await Promise.resolve();
    expect(images.map((image) => image.src)).toEqual(sources);
    expect(sources.map(readyDisplayCopy)).toEqual([undefined, undefined]);
    expect(CopyWorker.instances).toHaveLength(1);
    expect(worker.requests).toHaveLength(2);
  },
);

it("should fall back to originals when posting to the worker throws", async () => {
  const { useDisplayCopy } = await import(
    "../../demos/streaming/display-copies.js"
  );
  const image = original();
  const source = image.src;
  CopyWorker.failPost = true;

  useDisplayCopy(image, source);

  expect(activeWorker().terminated).toBe(true);
  await Promise.resolve();
  expect(image.src).toBe(source);
});

it("should allow a failed individual conversion to be retried", async () => {
  const { useDisplayCopy } = await import(
    "../../demos/streaming/display-copies.js"
  );
  const image = original();
  useDisplayCopy(image, image.src);
  const worker = activeWorker();

  worker.respond(0, null);
  await Promise.resolve();
  useDisplayCopy(image, image.src);

  expect(worker.requests).toHaveLength(2);
  worker.respond(1, new Blob(["retry"]));
  await vi.waitFor(() => expect(image.src).toBe("blob:display-copy"));
});

it("should reuse a copy when a retained row leaves and reenters the window", async () => {
  const { useDisplayCopy, adoptDisplayCopies, displaySource } = await import(
    "../../demos/streaming/display-copies.js"
  );
  const image = original();
  const source = image.src;
  useDisplayCopy(image, source);
  activeWorker().respond(0, new Blob(["copy"]));
  await vi.waitFor(() => expect(image.src).toBe("blob:display-copy"));
  const row = document.createElement("article");
  row.append(image);
  document.body.append(row);

  row.remove();
  adoptDisplayCopies(row);
  document.body.append(row);
  const rebuilt = original(source);
  row.replaceChildren(rebuilt);
  adoptDisplayCopies(row);

  expect(rebuilt.src).toBe("blob:display-copy");
  expect(displaySource(rebuilt, rebuilt.src)).toBe(source);
  expect(activeWorker().requests).toHaveLength(1);
  expect(activeObjectUrls.size).toBe(1);
  row.remove();
});

it("should release each replaced conversation's copies and allow a fresh worker", async () => {
  const { useDisplayCopy, readyDisplayCopy, resetDisplayCopies } = await import(
    "../../demos/streaming/display-copies.js"
  );
  const copy = new Blob([new Uint8Array(256 * 1024)]);

  for (let conversation = 0; conversation < 3; conversation++) {
    const images = [original(), original("data:image/png;base64,second")];
    for (const image of images) useDisplayCopy(image, image.src);
    const worker = CopyWorker.instances.at(-1);
    if (!worker) throw new Error("No copy worker");
    worker.respond(0, copy);
    worker.respond(1, copy);
    await vi.waitFor(() => {
      expect(images.every((image) => image.src.startsWith("blob:"))).toBe(true);
    });
    expect([...activeObjectUrls.values()]).toEqual([copy.size, copy.size]);

    resetDisplayCopies();
    resetDisplayCopies();

    expect(activeObjectUrls.size).toBe(0);
    expect(readyDisplayCopy("data:image/png;base64,large")).toBeUndefined();
    expect(worker.terminated).toBe(true);
  }
  expect(CopyWorker.instances).toHaveLength(3);
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(6);
});

it.each([false, true])(
  "should reject a stale conversion after reset when its response was delivered: %s",
  async (delivered) => {
    const { useDisplayCopy, readyDisplayCopy, resetDisplayCopies } =
      await import("../../demos/streaming/display-copies.js");
    const image = original();
    const source = image.src;
    useDisplayCopy(image, source);
    const worker = activeWorker();
    const lateResponse = worker.onmessage;
    if (delivered) worker.respond(0, new Blob(["old copy"]));

    resetDisplayCopies();
    const replacement = original(source);
    useDisplayCopy(replacement, source);
    lateResponse?.(
      new MessageEvent("message", {
        data: { id: worker.requests[0]?.id, blob: new Blob(["late copy"]) },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(image.src).toBe(source);
    expect(readyDisplayCopy(source)).toBeUndefined();
    expect(activeObjectUrls.size).toBe(0);
    const nextWorker = CopyWorker.instances[1];
    if (!nextWorker) throw new Error("No replacement copy worker");
    useDisplayCopy(replacement, source);
    expect(nextWorker.requests).toHaveLength(1);
    nextWorker.respond(0, new Blob(["current copy"]));
    await vi.waitFor(() => expect(replacement.src).toBe("blob:display-copy"));
    expect(image.src).toBe(source);
    expect(activeObjectUrls.size).toBe(1);
  },
);

it("should cancel a stale decode without swapping its image after reset", async () => {
  const { useDisplayCopy, resetDisplayCopies } = await import(
    "../../demos/streaming/display-copies.js"
  );
  let finishDecode = () => {};
  const decoded = new Promise<void>((resolve) => {
    finishDecode = resolve;
  });
  const probe = document.createElement("img");
  probe.decode = () => decoded;
  // biome-ignore lint/complexity/useArrowFunction: Image is called with new.
  vi.stubGlobal("Image", function () {
    return probe;
  });
  const image = original();
  const source = image.src;
  useDisplayCopy(image, source);
  activeWorker().respond(0, new Blob(["copy"]));
  await vi.waitFor(() => expect(probe.src).toBe("blob:display-copy"));

  resetDisplayCopies();
  finishDecode();
  await decoded;

  expect(probe.hasAttribute("src")).toBe(false);
  expect(image.src).toBe(source);
  expect(activeObjectUrls.size).toBe(0);
});
