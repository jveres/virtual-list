export const MESSAGE_COPY_PATH =
  "M7 6V3.5A1.5 1.5 0 0 1 8.5 2H16a1.5 1.5 0 0 1 1.5 1.5V11a1.5 1.5 0 0 1-1.5 1.5h-2.5M4 6h7.5A1.5 1.5 0 0 1 13 7.5V16a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 16V7.5A1.5 1.5 0 0 1 4 6Z";

const feedbackTimers = new WeakMap<HTMLButtonElement, number>();

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Match the markdown viewer's fallback for restricted clipboard access.
    }
  }
  const active = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange(),
      )
    : [];
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  Object.assign(input.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "1px",
    height: "1px",
    opacity: "0",
    padding: "0",
    border: "0",
    fontSize: "16px",
  });
  document.body.append(input);
  try {
    input.focus({ preventScroll: true });
    input.select();
    input.setSelectionRange(0, text.length);
    if (!document.execCommand("copy")) throw new Error("Clipboard unavailable");
  } finally {
    input.remove();
    if (active instanceof HTMLElement && active.isConnected)
      active.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}

function resetFeedback(button: HTMLButtonElement): void {
  window.clearTimeout(feedbackTimers.get(button));
  feedbackTimers.delete(button);
  button.title = "Copy message";
  button.setAttribute("aria-label", "Copy message");
  button.removeAttribute("data-copied");
  button.querySelector("path")?.setAttribute("d", MESSAGE_COPY_PATH);
}

export function clearMessageCopyFeedback(row: HTMLElement): void {
  for (const button of row.querySelectorAll<HTMLButtonElement>(
    ".message-copy-btn",
  ))
    resetFeedback(button);
}

export async function copyMessageText(
  button: HTMLButtonElement,
  text: string,
  status: HTMLElement,
): Promise<void> {
  resetFeedback(button);
  status.textContent = "";
  try {
    await writeClipboard(text);
    if (!button.isConnected) return;
    button.title = "Copied";
    button.setAttribute("aria-label", "Copied");
    button.setAttribute("data-copied", "");
    button.querySelector("path")?.setAttribute("d", "m4 10 4 4 8-9");
    status.textContent = "Message copied to clipboard.";
  } catch {
    if (!button.isConnected) return;
    button.title = "Could not copy message";
    button.setAttribute("aria-label", "Could not copy message");
    status.textContent =
      "Could not copy the message. Select the text and copy it manually.";
  }
  window.clearTimeout(feedbackTimers.get(button));
  feedbackTimers.set(
    button,
    window.setTimeout(() => resetFeedback(button), 1500),
  );
}
