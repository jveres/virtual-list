import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTranscriptFile,
  shareChatFile,
  supportsChatSharing,
} from "../../demos/streaming/share";

beforeEach(() => vi.stubGlobal("isSecureContext", true));
afterEach(() => vi.unstubAllGlobals());

function sharing(canShare: (data: ShareData) => boolean = () => true) {
  const share = vi
    .fn<(data: ShareData) => Promise<void>>()
    .mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { canShare, share });
  return share;
}

describe("chat file sharing", () => {
  it("should invoke sharing synchronously with the original Markdown file", async () => {
    const share = sharing();
    const file = createTranscriptFile("**User**\n\nHello");

    const result = shareChatFile(file);

    expect(share).toHaveBeenCalledWith({ files: [file] });
    await expect(result).resolves.toBe("shared");
  });

  it("should preserve transcript bytes when plain text is the only supported file type", async () => {
    const share = sharing((data) => data.files?.[0]?.type === "text/plain");
    const file = createTranscriptFile(
      "日本語\n<!-- attachments stay intact -->",
    );

    await expect(shareChatFile(file)).resolves.toBe("shared");
    const shared = share.mock.calls[0]?.[0].files?.[0];

    expect(shared?.name).toBe(file.name.replace(/\.md$/, ".txt"));
    expect(await shared?.text()).toBe(await file.text());
  });

  it("should leave unsupported files to the download control", async () => {
    const share = sharing(() => false);
    await expect(shareChatFile(createTranscriptFile("Chat"))).resolves.toBe(
      "unsupported",
    );
    expect(share).not.toHaveBeenCalled();
  });

  it("should treat cancellation as a quiet outcome", async () => {
    const share = sharing();
    share.mockRejectedValue(new DOMException("Cancelled", "AbortError"));
    await expect(shareChatFile(createTranscriptFile("Chat"))).resolves.toBe(
      "cancelled",
    );
  });

  it("should surface sharing failures for a useful fallback message", async () => {
    const share = sharing();
    share.mockRejectedValue(
      new DOMException("Permission denied", "NotAllowedError"),
    );
    await expect(shareChatFile(createTranscriptFile("Chat"))).rejects.toThrow(
      "Permission denied",
    );
  });

  it("should require a secure context and both file-sharing APIs", () => {
    sharing();
    expect(supportsChatSharing()).toBe(true);
    vi.stubGlobal("isSecureContext", false);
    expect(supportsChatSharing()).toBe(false);
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", { share: () => Promise.resolve() });
    expect(supportsChatSharing()).toBe(false);
  });
});
