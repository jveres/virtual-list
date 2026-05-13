export type ChatRole = "user" | "assistant";
export type AssistantStatus = "thinking" | "streaming" | "done" | "cancelled";

export interface ChatToolCall {
  name: string;
  status: "running" | "done" | "error";
  durationMs: number;
  input: string;
  output: string;
  open?: boolean;
}

export interface ChatMessage {
  role: ChatRole;
  markdown: string;
  status?: AssistantStatus;
  toolCalls?: ChatToolCall[];
}

export interface ChatItemOptions {
  indexLabel?: boolean;
}

function assistantStatus(message: ChatMessage): AssistantStatus {
  return message.role === "assistant" ? (message.status ?? "done") : "done";
}

export function setRoleLabel(
  label: HTMLElement,
  message: ChatMessage,
  index: number,
  options: ChatItemOptions = {},
): void {
  if (message.role !== "assistant") {
    label.textContent = options.indexLabel ? `User - #${index}` : "You";
    return;
  }

  const status = assistantStatus(message);
  label.dataset.status = status;
  const text = options.indexLabel ? `Assistant - #${index}` : "Assistant";
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
  dot.dataset.status = status;
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
  meta.textContent = `${toolCall.status} - ${toolCall.durationMs}ms`;

  summary.append(title, meta);

  const body = document.createElement("div");
  body.className = "tool-call-body";

  const input = document.createElement("pre");
  input.className = "tool-call-code";
  input.textContent = toolCall.input;

  const output = document.createElement("p");
  output.textContent = toolCall.output;

  body.append(input, output);
  details.append(summary, body);
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

export function buildChatItem(
  index: number,
  message: ChatMessage,
  html: string,
  options: ChatItemOptions = {},
): HTMLElement {
  const row = document.createElement("article");
  row.className = `message ${message.role}`;
  row.dataset.index = String(index);

  const content = document.createElement("div");
  content.className = "message-content";

  const label = document.createElement("div");
  label.className = "role-label";
  setRoleLabel(label, message, index, options);
  content.appendChild(label);

  const tools = buildToolCalls(message);
  if (tools) content.appendChild(tools);

  const markdown = document.createElement("div");
  markdown.className = "md";
  markdown.innerHTML = html;
  content.appendChild(markdown);

  row.appendChild(content);
  return row;
}
