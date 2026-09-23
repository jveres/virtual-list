import { setAttributeIfChanged, setHiddenIfChanged } from "./dom";
import {
  mountMeasuredText,
  prepareMeasuredText,
  syncMeasuredText,
  type TextBounds,
  unmountMeasuredText,
} from "./measured-text";

/** The feed's measured-text collapse pattern, capped at five chat text lines. */
export function prepareUserMessageCollapse(
  row: HTMLElement,
  id: number,
  initiallyExpanded: boolean,
  remember: (expanded: boolean) => void,
  width: number,
  probeContainer: HTMLElement = document.body,
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
  button.innerHTML =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" transform="rotate(90 8 8)" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const footer = document.createElement("div");
  footer.className = "user-message-footer";
  footer.append(button);
  const versions = body.parentElement?.querySelector(":scope > .version-nav");
  if (versions) footer.append(versions);
  body.parentElement?.append(footer);
  let expanded = initiallyExpanded;
  const apply = (bounds: TextBounds): void => {
    const editing = row.classList.contains("is-editing");
    const limit = Number.parseFloat(getComputedStyle(content).lineHeight) * 5;
    const overflows = bounds.height > limit + 1;
    const height = `${limit}px`;
    if (body.style.getPropertyValue("--user-message-limit") !== height)
      body.style.setProperty("--user-message-limit", height);
    body.classList.toggle("is-collapsed", overflows && !expanded && !editing);
    setHiddenIfChanged(button, !overflows || editing);
    const label = expanded ? "Collapse message" : "Expand message";
    setAttributeIfChanged(button, "aria-expanded", String(expanded));
    setAttributeIfChanged(button, "aria-label", label);
    setAttributeIfChanged(button, "title", label);
  };
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    expanded = !expanded;
    remember(expanded);
    syncMeasuredText(row);
  });
  // Keyboard navigation must not focus links or copy controls behind the fade.
  body.addEventListener("focusin", () => {
    if (!body.classList.contains("is-collapsed")) return;
    expanded = true;
    remember(true);
    syncMeasuredText(row);
  });

  // Decide before the virtual list measures the row,
  // without briefly showing a full-height bubble or a toggle on short text.
  prepareMeasuredText(row, content, apply, width, probeContainer);
}

export {
  mountMeasuredText as mountUserMessageCollapse,
  syncMeasuredText as syncUserMessageCollapse,
  unmountMeasuredText as unmountUserMessageCollapse,
};
