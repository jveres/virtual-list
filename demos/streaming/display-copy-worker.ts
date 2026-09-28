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
  try {
    const source = await (await fetch(url)).blob();
    const bitmap = await createImageBitmap(source);
    const scale = maxEdge / Math.max(bitmap.width, bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2D context");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    // PNG keeps transparency; photos re-encode as JPEG.
    const blob = await canvas.convertToBlob(
      source.type === "image/png"
        ? { type: "image/png" }
        : { type: "image/jpeg", quality: 0.9 },
    );
    self.postMessage({ id, blob });
  } catch {
    self.postMessage({ id, blob: null });
  }
}
