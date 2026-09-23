import { renderMarkdown } from "./markdown.js";

type ChatRole = "user" | "assistant";

export function chevronIcon(direction: "left" | "right" | "down"): string {
  const rotation = { left: 180, right: 0, down: 90 }[direction];
  return `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" transform="rotate(${rotation} 8 8)" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

export type AssistantStatus = "thinking" | "streaming" | "done" | "cancelled";

export interface ChatToolCall {
  name: string;
  status: "running" | "done" | "error";
  durationMs: number;
  input: string;
  output: string;
  /** UTF-16 offset in the message markdown when the call started. Legacy calls omit it. */
  markdownOffset?: number;
  open?: boolean;
}

interface ChatMessage {
  role: ChatRole;
  markdown: string;
  status?: AssistantStatus;
}

function assistantStatus(message: ChatMessage): AssistantStatus {
  return message.status ?? "done";
}

export function setRoleLabel(label: HTMLElement, message: ChatMessage): void {
  if (message.role !== "assistant") {
    label.textContent = "You";
    return;
  }

  const status = assistantStatus(message);
  label.dataset.status = status;
  const text = "Assistant";
  if (status === "done") {
    label.textContent = text;
    return;
  }

  let dot = label.querySelector<HTMLElement>(".dot");
  if (!dot) {
    label.textContent = "";
    dot = document.createElement("span");
    dot.setAttribute("aria-hidden", "true");
    label.append(dot, text);
  }
  const className =
    status === "thinking" || status === "streaming"
      ? "dot pulse"
      : `dot ${status}`;
  if (dot.className !== className) dot.className = className;
}

export function buildToolCall(toolCall: ChatToolCall): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "tool-call";
  details.open = toolCall.open === true;
  details.addEventListener("toggle", () => {
    toolCall.open = details.open;
  });

  const summary = document.createElement("summary");
  summary.className = "tool-call-summary";

  const title = document.createElement("span");
  title.className = "tool-call-title";
  title.textContent = toolCall.name;

  const meta = document.createElement("span");
  meta.className = `tool-call-meta ${toolCall.status}`;
  // A live call has no duration yet; its panel is rebuilt when it settles.
  meta.textContent =
    toolCall.status === "running"
      ? toolCall.status
      : `${toolCall.status} - ${toolCall.durationMs}ms`;

  summary.append(title, meta);
  details.append(summary);

  // A call without payloads (a transcript written before they were kept)
  // is a summary line, not an empty panel.
  if (toolCall.input === "" && toolCall.output === "") {
    details.classList.add("bare");
    return details;
  }

  const body = document.createElement("div");
  body.className = "tool-call-body";

  const input = document.createElement("pre");
  input.className = "tool-call-code";
  input.textContent = toolCall.input;

  const output = document.createElement(
    toolCall.name === "thinking" ? "div" : "p",
  );
  if (toolCall.name === "thinking") {
    // Use the same sanitized, delegation-ready renderer as finished messages.
    // Running calls are rendered again as their output snapshots change.
    output.className = "markdown-viewer";
    const markdown = document.createElement("div");
    markdown.className = "markdown";
    markdown.innerHTML = renderMarkdown(toolCall.output);
    output.append(markdown);
  } else {
    output.textContent = toolCall.output;
  }

  body.append(input, output);
  details.append(body);
  return details;
}

// Builds the row chrome shared by static and live rows — `article.message` →
// `.message-content` → role label — and returns the content host
// the caller fills with markdown (a static `.markdown-viewer` for finished rows,
// or a live `createMarkdownViewer` mount for a streaming row).
export function buildChatRow(message: ChatMessage): {
  row: HTMLElement;
  content: HTMLElement;
} {
  const row = document.createElement("article");
  row.className = `message ${message.role}`;

  const content = document.createElement("div");
  content.className = "message-content";

  const label = document.createElement("div");
  label.className = "role-label";
  setRoleLabel(label, message);
  content.appendChild(label);

  row.appendChild(content);
  return { row, content };
}

// A section / group header row (e.g. a date separator). The same markup is
// reused by the sticky-headers overlay, so a header rendered in-flow and pinned
// at the top look identical.
export function buildSectionHeader(label: string): HTMLElement {
  const header = document.createElement("div");
  header.className = "section-header";
  const pill = document.createElement("span");
  pill.className = "section-header-pill";
  pill.textContent = label;
  header.appendChild(pill);
  return header;
}

export function buildChatItem(message: ChatMessage, html: string): HTMLElement {
  const { row, content } = buildChatRow(message);

  // markdown-viewer's stylesheet targets `.markdown-viewer > .markdown`.
  const viewer = document.createElement("div");
  viewer.className = "markdown-viewer";
  const markdown = document.createElement("div");
  markdown.className = "markdown";
  markdown.innerHTML = html;
  viewer.appendChild(markdown);
  content.appendChild(viewer);

  return row;
}
