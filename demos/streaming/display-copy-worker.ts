/// <reference lib="webworker" />
// Decodes and downsizes one data-URL image at a time, off the main thread.

interface CopyRequest {
  id: number;
  url: string;
  maxEdge: number;
}

let queue = Promise.resolve();

self.onmessage = ({ data }: MessageEvent<CopyRequest>) => {
  queue = queue.then(() => copy(data));
};

async function copy({ id, url, maxEdge }: CopyRequest): Promise<void> {
  let bitmap: ImageBitmap | undefined;
  let canvas: OffscreenCanvas | undefined;
  try {
    const source = await (await fetch(url)).blob();
    bitmap = await createImageBitmap(source);
    // Copies only shrink; a small image keeps its own size.
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2D context");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    bitmap = undefined;
    // PNG keeps transparency; photos re-encode as JPEG.
    const blob = await canvas.convertToBlob(
      source.type === "image/png"
        ? { type: "image/png" }
        : { type: "image/jpeg", quality: 0.9 },
    );
    self.postMessage({ id, blob });
  } catch {
    self.postMessage({ id, blob: null });
  } finally {
    bitmap?.close();
    // The encoded blob owns its bytes; release the temporary pixel backing
    // without waiting for the worker's next garbage collection.
    if (canvas) canvas.width = canvas.height = 1;
  }
}
