import { buildToolCall, type ChatToolCall } from "../shared/chat-ui.js";
import {
  createMarkdownViewer,
  type MarkdownViewerHandle,
  renderMarkdown,
} from "../shared/markdown.js";
import { messageParts, type OrderedMessage } from "../shared/message-order.js";
import { setHiddenIfChanged } from "../shared/utils.js";

export type TrailMode = "off" | "short" | "long";

export type CursorMode = "bar" | "idle" | "none";
type TextSlot = {
  kind: "text";
  host: HTMLElement;
  handle: MarkdownViewerHandle;
};
type ToolSlot = {
  kind: "tool";
  host: HTMLElement;
  details: HTMLDetailsElement;
  call: ChatToolCall;
};
export interface MessageContentHandle {
  update(message: OrderedMessage, text: string, isStreaming: boolean): void;
  setCursor(cursor: CursorMode): void;
  setTrail(mode: TrailMode): void;
  setMounted(mounted: boolean): void;
  destroy(): void;
}

export function appendStaticMessageContent(
  host: HTMLElement,
  message: OrderedMessage,
): void {
  const parts = messageParts(message);
  for (const [index, part] of parts.entries()) {
    if (part.kind === "tool") {
      const tools = document.createElement("div");
      tools.className = "tool-calls";
      tools.append(buildToolCall(part.call));
      host.append(tools);
    } else if (part.text.trim()) {
      const viewer = document.createElement("div");
      viewer.className = "markdown-viewer";
      if (index < parts.length - 1)
        viewer.classList.add("message-text-intermediate");
      const markdown = document.createElement("div");
      markdown.className = "markdown";
      markdown.innerHTML = renderMarkdown(part.text);
      viewer.append(markdown);
      host.append(viewer);
    }
  }
}

/** Only the trailing text segment streams; earlier segments and tools stay put. */
export function createMessageContent(
  host: HTMLElement,
  initialCursor: CursorMode,
  initialTrail: TrailMode = "off",
  freshStream = false,
): MessageContentHandle {
  const slots = new Map<string, TextSlot | ToolSlot>();
  let cursor = initialCursor;
  let trailMode = initialTrail;
  let mounted = false;
  // Text arriving now is new: a viewer created with it would count it as
  // already shown, and the streaming trail would skip it. That holds for
  // the first build of a row whose stream just started, and for any text
  // segment that starts while the row is live, such as after a tool call.
  let newText = freshStream;
  function trailOption() {
    return mounted && trailMode !== "off"
      ? { durationMs: trailMode === "long" ? 1200 : 600 }
      : false;
  }
  return {
    update(message, text, isStreaming) {
      const parts = messageParts({ ...message, markdown: text });
      const keys = new Set(parts.map((part) => part.key));
      for (const [key, slot] of slots) {
        if (keys.has(key)) continue;
        if (slot.kind === "text") slot.handle.destroy();
        slot.host.remove();
        slots.delete(key);
      }
      for (const [index, part] of parts.entries()) {
        const streaming = isStreaming && index === parts.length - 1;
        let slot = slots.get(part.key);
        if (!slot) {
          const wrapper = document.createElement("div");
          host.append(wrapper);
          if (part.kind === "tool") {
            wrapper.className = "tool-calls";
            const details = buildToolCall(part.call);
            wrapper.append(details);
            slot = { kind: "tool", host: wrapper, details, call: part.call };
          } else {
            // The viewer owns copy handlers; avoid duplicate viewport handling.
            wrapper.addEventListener("click", (event) =>
              event.stopPropagation(),
            );
            slot = {
              kind: "text",
              host: wrapper,
              handle: createMarkdownViewer(wrapper, {
                text: streaming && newText ? "" : part.text,
                isStreaming: streaming,
                streamingTrail: trailOption(),
                preserveStreamingHeight: true,
                cursor,
                unfocusedCursorStyle: "block",
                focusOnStreamingStart: false,
              }),
            };
          }
          slots.set(part.key, slot);
        }
        if (part.kind === "text" && slot.kind === "text") {
          const intermediate = index < parts.length - 1;
          if (
            slot.host.classList.contains("message-text-intermediate") !==
            intermediate
          ) {
            slot.host.classList.toggle(
              "message-text-intermediate",
              intermediate,
            );
          }
          setHiddenIfChanged(slot.host, !part.text.trim() && !streaming);
          slot.handle.update({
            text: part.text,
            isStreaming: streaming,
          });
        } else if (
          part.kind === "tool" &&
          slot.kind === "tool" &&
          slot.call !== part.call
        ) {
          part.call.open = slot.details.open;
          const details = buildToolCall(part.call);
          slot.details.replaceWith(details);
          slot.details = details;
          slot.call = part.call;
        }
      }
      newText = true;
    },
    setCursor(next) {
      cursor = next;
      for (const slot of slots.values())
        if (slot.kind === "text") slot.handle.update({ cursor });
    },
    setTrail(next) {
      if (next === trailMode) return;
      trailMode = next;
      for (const slot of slots.values()) {
        if (slot.kind !== "text") continue;
        slot.handle.update({ streamingTrail: trailOption() });
      }
    },
    setMounted(next) {
      if (mounted === next) return;
      mounted = next;
      for (const slot of slots.values())
        if (slot.kind === "text" && trailMode !== "off")
          slot.handle.update({ streamingTrail: trailOption() });
    },
    destroy() {
      for (const slot of slots.values())
        if (slot.kind === "text") slot.handle.destroy();
      slots.clear();
    },
  };
}
