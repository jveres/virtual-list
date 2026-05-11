export type ChatRole = "user" | "assistant";
export type AssistantStatus = "thinking" | "streaming" | "done" | "cancelled";

export interface ChatMessage {
  role: ChatRole;
  markdown: string;
  status?: AssistantStatus;
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

  const markdown = document.createElement("div");
  markdown.className = "md";
  markdown.innerHTML = html;
  content.appendChild(markdown);

  row.appendChild(content);
  return row;
}
