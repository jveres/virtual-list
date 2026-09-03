type ChatRole = "user" | "assistant";
export type AssistantStatus = "thinking" | "streaming" | "done" | "cancelled";

export interface ChatToolCall {
  name: string;
  status: "running" | "done" | "error";
  durationMs: number;
  input: string;
  output: string;
  open?: boolean;
}

interface ChatMessage {
  role: ChatRole;
  markdown: string;
  status?: AssistantStatus;
  toolCalls?: ChatToolCall[];
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

function buildToolCall(toolCall: ChatToolCall): HTMLElement {
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

  const output = document.createElement("p");
  output.textContent = toolCall.output;

  body.append(input, output);
  details.append(body);
  return details;
}

function buildToolCalls(message: ChatMessage): HTMLElement | null {
  if (message.role !== "assistant" || !message.toolCalls?.length) return null;

  const tools = document.createElement("div");
  tools.className = "tool-calls";
  for (const toolCall of message.toolCalls) {
    tools.appendChild(buildToolCall(toolCall));
  }
  return tools;
}

// Refreshes a row's tool-call panel in place (a call started, finished, or
// failed mid-stream), keeping the row — and the live viewer, with its cursor —
// intact.
export function syncToolCalls(row: HTMLElement, message: ChatMessage): void {
  const content = row.querySelector<HTMLElement>(".message-content") ?? row;
  const previous = content.querySelector<HTMLElement>(":scope > .tool-calls");
  const next = buildToolCalls(message);
  if (previous) {
    if (next) previous.replaceWith(next);
    else previous.remove();
    return;
  }
  if (!next) return;
  const label = content.querySelector<HTMLElement>(":scope > .role-label");
  if (label) label.after(next);
  else content.prepend(next);
}

// Builds the row chrome shared by static and live rows — `article.message` →
// `.message-content` → role label + tool calls — and returns the content host
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

  const tools = buildToolCalls(message);
  if (tools) content.appendChild(tools);

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
