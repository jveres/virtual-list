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
  column: number;
  active: boolean;
  descendantCount: number;
  hiddenCount: number;
  role: "user" | "assistant";
  label: string;
  image: boolean;
  hasImages: boolean;
  imageCount: number;
  fileCount: number;
}

/** Short, plain-text labels only; message markup never enters the panel DOM. */
export function messageSummary(markdown: string): string {
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

/** Active messages form the spine; alternatives share their sibling's row.
 * Inactive descendants stay folded until that branch is selected. */
export function conversationEntries(
  tree: ReadonlyMap<number, ConversationNode>,
): TreeEntry[] {
  const sizes = new Map<number, number>();
  const pending = [0];
  const order: number[] = [];
  const seen = new Set<number>();
  while (pending.length) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    pending.push(...(tree.get(id)?.childrenIds ?? []));
  }
  for (const id of order.reverse()) {
    sizes.set(
      id,
      1 +
        (tree.get(id)?.childrenIds ?? []).reduce(
          (sum, child) => sum + (sizes.get(child) ?? 0),
          0,
        ),
    );
  }
  const entries: TreeEntry[] = [];
  let parentId = 0;
  let row = 0;
  let parentColumn = 0;
  const visited = new Set<number>();
  while (!visited.has(parentId)) {
    visited.add(parentId);
    const parent = tree.get(parentId);
    if (!parent) break;
    const activeId = parent.childrenIds[parent.selectedChildIndex];
    if (activeId === undefined) break;
    parent.childrenIds.forEach((id, versionIndex) => {
      const message = tree.get(id)?.message;
      if (!message) return;
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
        column: parentColumn + versionIndex,
        active: id === activeId,
        descendantCount: (sizes.get(id) ?? 1) - 1,
        hiddenCount: id === activeId ? 0 : (sizes.get(id) ?? 1) - 1,
        role: message.role,
        ...content,
      });
    });
    parentColumn += parent.selectedChildIndex;
    row++;
    parentId = activeId;
  }
  return entries;
}
