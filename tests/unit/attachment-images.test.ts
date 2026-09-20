// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachmentChip,
  attachmentImageSource,
  type ChatAttachment,
  disposeAttachmentChips,
} from "../../demos/streaming/attachments.js";
import { attachmentImagePlatform } from "../helpers/attachment-image-platform.js";

const attachment: ChatAttachment = {
  name: "image.png",
  mimeType: "image/png",
  size: 3,
  dataUrl: "data:image/png;base64,YWJj",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function imageIn(chip: HTMLElement): HTMLImageElement {
  const image = chip.querySelector("img");
  if (!image) throw new Error("Attachment thumbnail missing");
  return image;
}

describe("attachment thumbnail display URLs", () => {
  it("should display identical bytes without changing the stored attachment", async () => {
    const platform = attachmentImagePlatform();
    const original = { ...attachment };

    const chip = attachmentChip(attachment);
    const image = imageIn(chip);
    const blob = platform.blobs.get(image.src);
    if (!blob) throw new Error("Thumbnail has no owned Blob");
    const contents = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });

    expect(contents).toBe(attachment.dataUrl);
    expect(blob.type).toBe(attachment.mimeType);
    expect(image.width).toBe(40);
    expect(image.height).toBe(40);
    expect(attachment).toEqual(original);
    expect(attachmentImageSource(image, image.src)).toBe(original.dataUrl);
    disposeAttachmentChips(chip);
    expect(platform.blobs.size).toBe(0);
  });

  it("should release each chip once without invalidating another chip or an unowned image", () => {
    const platform = attachmentImagePlatform();
    const first = attachmentChip(attachment);
    const second = attachmentChip(attachment);
    const firstUrl = imageIn(first).src;
    const secondUrl = imageIn(second).src;
    const row = document.createElement("div");
    const unowned = document.createElement("img");
    unowned.src = "blob:https://example.test/unowned";
    row.append(first, unowned);

    disposeAttachmentChips(row);
    disposeAttachmentChips(row);

    expect(platform.revoked).toEqual([firstUrl]);
    expect(platform.blobs.has(secondUrl)).toBe(true);
    expect(attachmentImageSource(imageIn(first), firstUrl)).toBe(firstUrl);
    disposeAttachmentChips(second);
    expect(platform.blobs.size).toBe(0);
  });

  it("should not associate a changed DOM source with the original attachment", () => {
    attachmentImagePlatform();
    const chip = attachmentChip(attachment);
    const image = imageIn(chip);
    image.src = "https://example.test/replacement.png";

    expect(attachmentImageSource(image, image.src)).toBe(image.src);
    disposeAttachmentChips(chip);
  });

  it("should revoke a Blob URL if assigning it fails and then use the original source", () => {
    const platform = attachmentImagePlatform();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "src",
    )?.set;
    if (!setter) throw new Error("Missing image source setter");
    vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation(
      function (this: HTMLImageElement, value: string) {
        if (value.startsWith("blob:")) throw new Error("Blob source rejected");
        setter.call(this, value);
      },
    );

    const chip = attachmentChip(attachment);

    expect(imageIn(chip).src).toBe(attachment.dataUrl);
    expect(platform.blobs.size).toBe(0);
    expect(platform.revoked).toHaveLength(1);
    disposeAttachmentChips(chip);
    expect(platform.revoked).toHaveLength(1);
  });

  it("should not convert a source whose MIME prefix does not match the attachment", () => {
    const platform = attachmentImagePlatform();
    const chip = attachmentChip({ ...attachment, mimeType: "image/webp" });

    expect(imageIn(chip).src).toBe(attachment.dataUrl);
    expect(platform.blobs.size).toBe(0);
    disposeAttachmentChips(chip);
  });

  it.each(["decoder", "blob-url", "missing-api"] as const)(
    "should retain the data URL if the %s optimization is unavailable",
    (failure) => {
      const platform = attachmentImagePlatform();
      if (failure === "missing-api") {
        vi.stubGlobal("Uint8Array", Object.getPrototypeOf(platform.decoder));
      } else {
        const fail = () => {
          throw new Error("Unavailable");
        };
        if (failure === "decoder")
          vi.spyOn(platform.decoder, "fromBase64").mockImplementation(fail);
        else
          vi.spyOn(platform.urls, "createObjectURL").mockImplementation(fail);
      }

      const chip = attachmentChip(attachment);

      expect(imageIn(chip).src).toBe(attachment.dataUrl);
      disposeAttachmentChips(chip);
      expect(platform.blobs.size).toBe(0);
      expect(platform.revoked).toEqual([]);
    },
  );
});
