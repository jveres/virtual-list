// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachmentChip,
  type ChatAttachment,
} from "../../demos/streaming/attachments";

function attachment(
  mimeType = "text/plain",
  name = "notes.txt",
): ChatAttachment {
  return {
    name,
    mimeType,
    size: 5,
    dataUrl: `data:${mimeType};base64,aGVsbG8=`,
  };
}

function openButton(chip: HTMLElement): HTMLButtonElement {
  const button = chip.querySelector("button");
  if (!button) throw new Error("Missing attachment open button");
  return button;
}

describe("opening file attachments", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("URL", {
      createObjectURL: vi
        .fn<(blob: Blob) => string>()
        .mockReturnValue("blob:attachment"),
      revokeObjectURL: vi.fn<(url: string) => void>(),
    });
    vi.spyOn(window, "open").mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    ["text/plain", "notes.txt"],
    ["text/markdown", "aad.md"],
    ["application/pdf", "report.pdf"],
    ["application/json", "data.json"],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "report.docx",
    ],
  ])(
    "should open %s with its original bytes and MIME type",
    async (mimeType, name) => {
      const chip = attachmentChip(attachment(mimeType, name));
      const button = openButton(chip);
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(button.type).toBe("button");
      expect(button.getAttribute("aria-label")).toBe(
        `Open ${name} in a new tab`,
      );

      button.click();

      expect(window.open).toHaveBeenCalledExactlyOnceWith(
        "blob:attachment",
        "_blank",
        "noopener,noreferrer",
      );
      const file = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0];
      if (!(file instanceof File)) throw new Error("Expected attachment file");
      expect(file.name).toBe(name);
      expect(file.type).toBe(mimeType);
      expect(file.size).toBe(5);
      const bytes = await new Promise<string | ArrayBuffer | null>(
        (resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        },
      );
      expect(bytes).toBe(attachment(mimeType, name).dataUrl);
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(
        "blob:attachment",
      );
    },
  );

  it.each([
    ["text/html", "page.html"],
    ["application/xml", "document.xml"],
  ])("should open %s as inert source text", (mimeType, name) => {
    const chip = attachmentChip(attachment(mimeType, name));

    openButton(chip).click();

    const file = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0];
    if (!(file instanceof File)) throw new Error("Expected attachment file");
    expect(file.type).toBe("text/plain");
    expect(file.size).toBe(5);
  });

  it.each([
    { dataUrl: "javascript:alert(1)" },
    { dataUrl: "data:text/plain;base64,@@@@@@@=" },
    { mimeType: "text/html" },
    { size: 4 },
  ])("should refuse invalid attachment metadata %#", (invalid) => {
    const chip = attachmentChip({ ...attachment(), ...invalid });

    openButton(chip).click();

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it("should preserve image previews without a file-open button", () => {
    const photo = attachment("image/png", "photo.png");

    const chip = attachmentChip(photo);

    expect(chip.querySelector("img")?.getAttribute("src")).toBe(photo.dataUrl);
    expect(chip.querySelector("button")).toBeNull();
  });

  it("should keep pending attachment removal separate from opening", () => {
    const chip = attachmentChip(attachment());
    const remove = document.createElement("button");
    remove.type = "button";
    chip.append(remove);

    remove.click();

    expect(window.open).not.toHaveBeenCalled();
    expect(chip.querySelector("button button")).toBeNull();
  });
});
