import { chevronIcon } from "../shared/chat-ui.js";
import { setHiddenIfChanged } from "../shared/utils.js";

type TextLayout = {
  content: HTMLElement;
  update: () => void;
  observer?: ResizeObserver;
  frame?: number;
};

const layouts = new WeakMap<HTMLElement, TextLayout>();

/** The feed's measured-text collapse pattern, capped at five chat text lines. */
export function prepareUserMessageCollapse(
  row: HTMLElement,
  id: number,
  initiallyExpanded: boolean,
  remember: (expanded: boolean) => void,
  width: number,
): void {
  const body = row.querySelector<HTMLElement>(
    ".message-content > .markdown-viewer",
  );
  const content = body?.querySelector<HTMLElement>(".markdown");
  if (!body || !content) return;
  body.classList.add("user-message-body");
  body.id = `user-message-text-${id}`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "user-message-toggle";
  button.setAttribute("aria-controls", body.id);
  button.innerHTML = chevronIcon("down");
  const footer = document.createElement("div");
  footer.className = "user-message-footer";
  footer.append(button);
  const versions = body.parentElement?.querySelector(":scope > .version-nav");
  if (versions) footer.append(versions);
  body.parentElement?.append(footer);
  let expanded = initiallyExpanded;
  const update = (): void => {
    if (!content.isConnected) return;
    const editing = row.classList.contains("is-editing");
    const limit = Number.parseFloat(getComputedStyle(content).lineHeight) * 5;
    const overflows = content.getBoundingClientRect().height > limit + 1;
    const height = `${limit}px`;
    if (body.style.getPropertyValue("--user-message-limit") !== height)
      body.style.setProperty("--user-message-limit", height);
    body.classList.toggle("is-collapsed", overflows && !expanded && !editing);
    setHiddenIfChanged(button, !overflows || editing);
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute(
      "aria-label",
      expanded ? "Collapse message" : "Expand message",
    );
    button.title = expanded ? "Collapse message" : "Expand message";
  };
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    expanded = !expanded;
    remember(expanded);
    update();
  });
  // Keyboard navigation must not focus links or copy controls behind the fade.
  body.addEventListener("focusin", () => {
    if (!body.classList.contains("is-collapsed")) return;
    expanded = true;
    remember(true);
    update();
  });

  // Match feed premeasurement: decide before the virtual list measures the row,
  // without briefly showing a full-height bubble or a toggle on short text.
  const probe = document.createElement("div");
  Object.assign(probe.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: `${width}px`,
    visibility: "hidden",
    pointerEvents: "none",
  });
  probe.append(row);
  document.body.append(probe);
  try {
    update();
  } finally {
    row.remove();
    probe.remove();
  }
  layouts.set(row, { content, update });
}

export function syncUserMessageCollapse(row: HTMLElement): void {
  layouts.get(row)?.update();
}

export function mountUserMessageCollapse(row: HTMLElement): void {
  const layout = layouts.get(row);
  if (!layout) return;
  layout.update();
  layout.observer?.disconnect();
  // As in the feed, defer ancestor-size writes out of ResizeObserver delivery.
  layout.observer = new ResizeObserver(() => {
    if (layout.frame !== undefined) return;
    layout.frame = requestAnimationFrame(() => {
      layout.frame = undefined;
      layout.update();
    });
  });
  layout.observer.observe(layout.content);
}

export function unmountUserMessageCollapse(row: HTMLElement): void {
  const layout = layouts.get(row);
  if (!layout) return;
  layout.observer?.disconnect();
  layout.observer = undefined;
  if (layout.frame !== undefined) cancelAnimationFrame(layout.frame);
  layout.frame = undefined;
}
