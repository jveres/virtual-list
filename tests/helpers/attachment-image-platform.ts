import { vi } from "vitest";

/** jsdom lacks Blob URLs and the browser's native base64-to-bytes API. */
export function attachmentImagePlatform() {
  const blobs = new Map<string, Blob>();
  const revoked: string[] = [];
  let nextId = 0;
  const NativeBytes = Uint8Array;
  class BrowserBytes extends NativeBytes {
    static fromBase64(text: string): Uint8Array<ArrayBuffer> {
      return new NativeBytes(Buffer.from(text, "base64"));
    }
  }
  class BrowserURL extends URL {
    static createObjectURL(blob: Blob): string {
      const url = `blob:https://example.test/attachment-${nextId++}`;
      blobs.set(url, blob);
      return url;
    }
    static revokeObjectURL(url: string): void {
      revoked.push(url);
      blobs.delete(url);
    }
  }
  vi.stubGlobal("Uint8Array", BrowserBytes);
  vi.stubGlobal("URL", BrowserURL);
  return { blobs, revoked, decoder: BrowserBytes, urls: BrowserURL };
}
