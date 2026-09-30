import type { AssistantStatus } from "../shared/chat-ui.js";
import type { ChatAttachment } from "./attachments.js";

export interface ConversationNode {
  message: {
    id: number;
    role: "user" | "assistant";
    markdown: string;
    status?: AssistantStatus;
    attachments?: readonly ChatAttachment[];
  } | null;
  parentId: number;
  childrenIds: readonly number[];
  selectedChildIndex: number;
}

export interface TreeEntry {
  id: number;
  parentId: number;
  row: number;
  /** The only reply to a prompt shares its prompt's row as one turn. */
  attached: boolean;
  active: boolean;
  role: "user" | "assistant";
  label: string;
  image: boolean;
  hasImages: boolean;
  imageCount: number;
  fileCount: number;
}

/** Short, plain-text labels only; message markup never enters the panel DOM. */
function messageSummary(markdown: string): string {
  const text =
    markdown
      .slice(0, 2000)
      .replace(/```[^\n]*[\s\S]*?(?:```|$)/g, " ")
      // Data URLs can extend far beyond the summary budget. Treat the cut
      // URL as an image too, without scanning or showing its encoded payload.
      .replace(
        /!\[([^\]]*)\]\([^)]*(?:\)|$)/g,
        (_image, alt: string) => alt.trim() || "Image",
      )
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .split("\n")
      .map((line) =>
        line
          .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+)/, "")
          .replace(/[*_`~]/g, "")
          .trim(),
      )
      .find(Boolean) ?? "";
  return text || "Untitled message";
}

function messageContent(
  markdown: string,
  attachments: readonly ChatAttachment[] = [],
): Pick<
  TreeEntry,
  "label" | "image" | "hasImages" | "imageCount" | "fileCount"
> {
  let cursor = 0;
  let firstAlt = "";
  let imageCount = attachments.filter((attachment) =>
    attachment.mimeType.startsWith("image/"),
  ).length;
  const fileCount = attachments.length - imageCount;
  let hasText = fileCount > 0;
  let text = "";
  const collect = (end: number): void => {
    const part = markdown.slice(cursor, end).trim();
    if (!part) return;
    hasText = true;
    if (text.length < 2000)
      text += `${text ? "\n" : ""}${part.slice(0, 2000 - text.length)}`;
  };
  // Skip image payloads before choosing a text summary. A caption after a
  // long data URL still makes this a mixed response, not an image-only node.
  for (const match of markdown.matchAll(/!\[([^\]]*)\]\([^)]*(?:\)|$)/g)) {
    collect(match.index);
    imageCount++;
    if (!firstAlt) firstAlt = match[1]?.trim() || "Image";
    cursor = match.index + match[0].length;
  }
  collect(markdown.length);
  return {
    label:
      text || firstAlt
        ? messageSummary(text || firstAlt)
        : attachments[0]?.name.trim().slice(0, 2000) || "Untitled message",
    image: imageCount > 0 && !hasText,
    hasImages: imageCount > 0,
    imageCount,
    fileCount,
  };
}

/** Every message in depth-first order; a row is a turn depth. A prompt and
 * its only reply form one turn; regenerated replies keep rows of their own.
 * The selected path is active; alternatives and descendants stay visible. */
export function conversationEntries(
  tree: ReadonlyMap<number, ConversationNode>,
): TreeEntry[] {
  const selected = new Set<number>();
  let selectedId: number | undefined = 0;
  while (selectedId !== undefined && !selected.has(selectedId)) {
    selected.add(selectedId);
    const node = tree.get(selectedId);
    selectedId = node?.childrenIds[node.selectedChildIndex];
  }
  const entries: TreeEntry[] = [];
  const seen = new Set<number>([0]);
  const pending: {
    id: number;
    parentId: number;
    row: number;
    attached: boolean;
  }[] = [];
  const queueChildren = (parentId: number, row: number): void => {
    const parent = tree.get(parentId);
    const children = parent?.childrenIds ?? [];
    const only = children.length === 1 ? children[0] : undefined;
    const attached =
      parent?.message?.role === "user" &&
      only !== undefined &&
      tree.get(only)?.message?.role === "assistant";
    for (let index = children.length - 1; index >= 0; index--) {
      const id = children[index];
      if (id !== undefined)
        pending.push({ id, parentId, row: attached ? row - 1 : row, attached });
    }
  };
  queueChildren(0, 0);
  for (let item = pending.pop(); item; item = pending.pop()) {
    const { id, parentId, row, attached } = item;
    if (seen.has(id)) continue;
    seen.add(id);
    const message = tree.get(id)?.message;
    if (!message) continue;
    const content = messageContent(message.markdown, message.attachments);
    if (
      message.role === "assistant" &&
      (message.status === "thinking" || message.status === "streaming") &&
      content.label === "Untitled message"
    )
      content.label = "Response in progress…";
    entries.push({
      id,
      parentId,
      row,
      attached,
      active: selected.has(id),
      role: message.role,
      ...content,
    });
    queueChildren(id, row + 1);
  }
  return entries;
}
