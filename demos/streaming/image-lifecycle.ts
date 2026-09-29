// Retained virtual rows keep their DOM for reuse. An off-DOM img with a src can
// still keep a decoded surface and a compositor image alive in Firefox/WebKit.
interface SuspendedImage {
  source: string;
  finish: () => void;
}
const suspended = new WeakMap<HTMLImageElement, SuspendedImage>();

/** Reserve known image boxes during offscreen preparation and retirement. */
export function suspendRowImages(root: ParentNode): void {
  for (const image of root.querySelectorAll("img")) {
    const source = image.getAttribute("src");
    if (
      !source ||
      image.hasAttribute("srcset") ||
      image.closest("picture") ||
      !(Number(image.getAttribute("width")) > 0) ||
      !(Number(image.getAttribute("height")) > 0)
    )
      continue;
    let state = suspended.get(image);
    if (state) {
      image.removeEventListener("load", state.finish);
      state.source = source;
    } else {
      // The low-specificity CSS fallback gives an unloaded inline image a
      // ratio-sized box without overriding the renderer's block layout.
      // Only an explicit inline style needs an inline override of its own.
      const display = image.style.display;
      image.setAttribute("data-image-suspended", "");
      const restore = (
        [
          ...(display === "inline" ? [["display", "inline-block"]] : []),
          ["overflow", "hidden"],
          [
            "aspect-ratio",
            `${image.getAttribute("width")} / ${image.getAttribute("height")}`,
          ],
        ] as const
      ).map(([property, value]) => {
        const previous = image.style.getPropertyValue(property);
        const priority = image.style.getPropertyPriority(property);
        image.style.setProperty(property, value);
        const applied = image.style.getPropertyValue(property);
        return () => {
          // Leave a renderer's newer style alone.
          if (image.style.getPropertyValue(property) !== applied) return;
          if (previous) image.style.setProperty(property, previous, priority);
          else image.style.removeProperty(property);
        };
      });
      const finish = () => {
        for (const reset of restore) reset();
        image.removeAttribute("data-image-suspended");
        suspended.delete(image);
        image.removeEventListener("load", finish);
      };
      state = { source, finish };
      suspended.set(image, state);
    }
    image.removeAttribute("src");
  }
}

/** Keep the reserved ratio until the restored source supplies intrinsic sizing. */
export function resumeRowImages(root: ParentNode): void {
  for (const image of root.querySelectorAll("img")) {
    const state = suspended.get(image);
    if (!state) continue;
    // A renderer may have supplied newer content while the row was detached.
    if (
      image.hasAttribute("src") &&
      image.getAttribute("src") !== state.source
    ) {
      state.finish();
      continue;
    }
    image.addEventListener("load", state.finish, { once: true });
    image.setAttribute("src", state.source);
    if (image.complete && image.naturalWidth > 0) state.finish();
  }
}
