/** Reflected attributes can emit mutations even when assigned the same value. */
export function setAttributeIfChanged(
  element: HTMLElement,
  name: string,
  value: string,
): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}
export function setHiddenIfChanged(
  element: HTMLElement,
  hidden: boolean,
): void {
  if (element.hidden !== hidden) element.hidden = hidden;
}
