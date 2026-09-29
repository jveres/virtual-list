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

beforeEach(() => {
  vi.resetModules();
  CopyWorker.instances = [];
  CopyWorker.failPost = false;
  vi.stubGlobal("Worker", CopyWorker);
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.stubGlobal("createImageBitmap", vi.fn());
  vi.stubGlobal("CSS", { supports: () => true });
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:display-copy");
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

afterEach(() => vi.unstubAllGlobals());

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
