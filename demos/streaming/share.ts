export function createTranscriptFile(markdown: string): File {
  return new File(
    [markdown],
    `chat-${new Date().toISOString().slice(0, 10)}.md`,
    {
      type: "text/markdown;charset=utf-8",
    },
  );
}

export function supportsChatSharing(): boolean {
  return (
    globalThis.isSecureContext === true &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function"
  );
}

/** Call directly from a click: no async preparation may consume activation. */
export async function shareChatFile(
  file: File,
): Promise<"shared" | "cancelled" | "unsupported"> {
  if (!supportsChatSharing()) return "unsupported";
  let candidate = file;
  if (!navigator.canShare({ files: [candidate] })) {
    // Some Safari/OS versions accept plain text but not Markdown's MIME type.
    // Wrapping the Blob preserves every byte, including attachment metadata.
    candidate = new File([file], file.name.replace(/\.md$/i, ".txt"), {
      type: "text/plain",
    });
    if (!navigator.canShare({ files: [candidate] })) return "unsupported";
  }
  try {
    await navigator.share({ files: [candidate] });
    return "shared";
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      return "cancelled";
    throw error;
  }
}
