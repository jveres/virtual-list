/*
 * Adapted from ../loom/src/dom/scroll-fade.ts (plain DOM, no Loom runtime).
 * MIT License — Copyright (c) 2026 Janos Veres
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import "./scroll-fade.css";

/** Loom's edge detection and inverse-mask geometry, extended to both axes.
 * The target owns only native listeners/observers; stop releases all of them. */
export function scrollFade(element: HTMLElement): () => void {
  const properties = [
    "--scroll-fade-top",
    "--scroll-fade-bottom",
    "--scroll-fade-left",
    "--scroll-fade-right",
    "--scroll-fade-gutter-x",
    "--scroll-fade-gutter-y",
  ];
  const previous = properties.map((property) =>
    element.style.getPropertyValue(property),
  );
  const hadClass = element.classList.contains("scroll-fade");
  const values = properties.map(() => -1);
  const epsilon = 4;
  let maxX = 0;
  let maxY = 0;
  element.classList.add("scroll-fade");

  function setValue(index: number, value: number): void {
    const property = properties[index];
    if (property && value !== values[index]) {
      element.style.setProperty(property, `${value}px`);
      values[index] = value;
    }
  }

  function sync(): void {
    const top = element.scrollTop;
    const left = element.scrollLeft;
    const edges = [
      top > epsilon,
      maxY - top > epsilon,
      left > epsilon,
      maxX - left > epsilon,
    ];
    edges.forEach((edge, index) => {
      setValue(index, edge ? 14 : 0);
    });
  }

  function measure(): void {
    maxX = Math.max(0, element.scrollWidth - element.clientWidth);
    maxY = Math.max(0, element.scrollHeight - element.clientHeight);
    // Overlay scrollbars reserve no gutter. Exempting a nominal strip would
    // make faded content reappear in that strip at the bottom/right edge.
    const style = getComputedStyle(element);
    const borderX =
      (Number.parseFloat(style.borderLeftWidth) || 0) +
      (Number.parseFloat(style.borderRightWidth) || 0);
    const borderY =
      (Number.parseFloat(style.borderTopWidth) || 0) +
      (Number.parseFloat(style.borderBottomWidth) || 0);
    setValue(
      4,
      Math.max(0, element.offsetHeight - element.clientHeight - borderY),
    );
    setValue(
      5,
      Math.max(0, element.offsetWidth - element.clientWidth - borderX),
    );
    sync();
  }

  // Cache extents on layout/content changes; scroll events read offsets only.
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  for (const child of element.children) observer.observe(child);
  const mutations = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.removedNodes)
        if (node instanceof Element) observer.unobserve(node);
      for (const node of record.addedNodes)
        if (node instanceof Element) observer.observe(node);
    }
    measure();
  });
  mutations.observe(element, { childList: true });
  element.addEventListener("scroll", sync, { passive: true });
  measure();
  return () => {
    element.removeEventListener("scroll", sync);
    observer.disconnect();
    mutations.disconnect();
    if (!hadClass) element.classList.remove("scroll-fade");
    properties.forEach((property, index) => {
      const value = previous[index];
      if (value) element.style.setProperty(property, value);
      else element.style.removeProperty(property);
    });
  };
}
