import type { ChatToolCall } from "./chat-ui.js";

export interface OrderedMessage {
  markdown: string;
  toolCalls?: ChatToolCall[];
}

type MessagePart =
  | { kind: "text"; key: string; text: string }
  | { kind: "tool"; key: string; call: ChatToolCall };

/** Stable slots retain text viewers when another tool starts or finishes. */
export function messageParts(message: OrderedMessage): MessagePart[] {
  const parts: MessagePart[] = [];
  let offset = 0;
  for (const [index, call] of (message.toolCalls ?? []).entries()) {
    const next = Math.max(
      offset,
      Math.min(message.markdown.length, call.markdownOffset ?? 0),
    );
    parts.push({
      kind: "text",
      key: `text-${index}`,
      text: message.markdown.slice(offset, next),
    });
    parts.push({ kind: "tool", key: `tool-${index}`, call });
    offset = next;
  }
  parts.push({
    kind: "text",
    key: `text-${message.toolCalls?.length ?? 0}`,
    text: message.markdown.slice(offset),
  });
  return parts;
}

/** Replacing a progressive image must move later tool boundaries with it. */
export function replaceMessageMarkdown(
  message: OrderedMessage,
  previous: string,
  next: string,
): boolean {
  const start = message.markdown.indexOf(previous);
  if (start < 0) return false;
  const end = start + previous.length;
  message.markdown =
    message.markdown.slice(0, start) + next + message.markdown.slice(end);
  message.toolCalls = message.toolCalls?.map((call) => {
    if (call.markdownOffset === undefined || call.markdownOffset <= start)
      return call;
    return {
      ...call,
      markdownOffset:
        call.markdownOffset >= end
          ? call.markdownOffset + next.length - previous.length
          : start + next.length,
    };
  });
  return true;
}
