import { scrollFade } from "../shared/scroll-fade.js";
import {
  type ConversationNode,
  conversationEntries,
} from "./conversation-tree-model.js";
import type { ResponseHeading } from "./response-headings.js";
import "./conversation-tree.css";

interface TreeOptions {
  host: HTMLElement;
  viewport: HTMLElement;
  tree: ReadonlyMap<number, ConversationNode>;
  isLoaded: (id: number) => boolean;
  currentMessage: () => number | null;
  headings: (id: number) => readonly ResponseHeading[];
  navigate: (id: number, headingIndex?: number) => Promise<boolean>;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const HEADING_ROW_HEIGHT = 24;
const BAND_GAP = 12;
const ICONS = {
  // Lucide MessageSquare.
  user: "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
  assistant: "M5 2h9l5 5v15H5zM14 2v6h5M8 12h8M8 16h8",
  image: "M3 3h18v18H3zM3 17l6-6 4 4 3-3 5 5M15 7h.01",
  images: "M3 7v14h14M7 3h14v14H7zM7 13l4-4 4 4 2-2 4 4M16 6h.01",
  attachment:
    "m21 11-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.5-8.5",
};

function icon(path: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS(SVG_NS, "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  return svg;
}

/** Lucide Network; CSS normalizes control strokes to one rendered pixel. */
function networkIcon(): SVGSVGElement {
  const svg = icon("M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3 M12 12V8");
  for (const [x, y] of [
    [16, 16],
    [2, 16],
    [9, 2],
  ]) {
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", "6");
    rect.setAttribute("height", "6");
    rect.setAttribute("rx", "1");
    svg.prepend(rect);
  }
  return svg;
}

/** Built only on opening or a structural change while open. No token or
 * animation-frame subscription; reading position updates at scroll end. */
export function createConversationTree(options: TreeOptions): {
  refresh: () => void;
  reset: () => void;
  refreshLoaded: () => void;
  dispose: () => void;
} {
  const listeners = new AbortController();
  const { signal } = listeners;
  const root = document.createElement("div");
  root.className = "conversation-tree";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "scroll-jump conversation-tree-toggle";
  toggle.setAttribute("aria-label", "Conversation tree");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "conversation-tree-panel");
  toggle.append(networkIcon());
  const panel = document.createElement("section");
  panel.id = "conversation-tree-panel";
  panel.className = "conversation-tree-panel";
  panel.setAttribute("aria-label", "Conversation tree");
  panel.hidden = true;
  const header = document.createElement("div");
  header.className = "conversation-tree-header";
  const title = document.createElement("h2");
  title.textContent = "Conversation";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "conversation-tree-close";
  closeButton.setAttribute("aria-label", "Close conversation tree");
  closeButton.append(icon("M6 6l12 12M18 6 6 18"));
  header.append(title, closeButton);
  const controls = document.createElement("div");
  controls.className = "conversation-tree-controls";
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Tree view controls");
  function control(label: string, path: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.append(icon(path));
    controls.append(button);
    return button;
  }
  const zoomOut = control("Zoom out tree", "M5 12h14");
  const zoomReset = document.createElement("button");
  zoomReset.type = "button";
  zoomReset.className = "conversation-tree-zoom-value";
  zoomReset.setAttribute("aria-label", "Reset tree zoom to 100%");
  controls.append(zoomReset);
  const zoomIn = control("Zoom in tree", "M5 12h14M12 5v14");
  const fitButton = control(
    "Fit entire tree",
    "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5",
  );
  const locateButton = control(
    "Locate current chat position",
    "M12 2v4m0 12v4M2 12h4m12 0h4M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12Z",
  );
  const widthButton = control(
    "Full width tree panel",
    "M3 4v16M21 4v16M8 8l-4 4 4 4m8-8 4 4-4 4M4 12h16",
  );
  widthButton.setAttribute("aria-pressed", "false");
  const scroller = document.createElement("div");
  scroller.className = "conversation-tree-scroll";
  const surface = document.createElement("div");
  surface.className = "conversation-tree-surface";
  const canvas = document.createElement("div");
  canvas.className = "conversation-tree-canvas";
  surface.append(canvas);
  scroller.append(surface);
  const status = document.createElement("p");
  status.className = "conversation-tree-status";
  status.setAttribute("role", "status");
  status.hidden = true;
  const statusMessage = document.createElement("span");
  // Transient navigation status overlays the tree without changing its height.
  const statusText = document.createTextNode("");
  statusMessage.append(statusText);
  status.append(statusMessage);
  function setStatus(message: string): void {
    statusText.data = message;
    status.hidden = message.length === 0;
  }
  header.insertBefore(controls, closeButton);
  panel.append(header, scroller, status);
  // One continuous stroke avoids the hairline seam where rotated CSS
  // borders meet at the tip, especially at fractional display scales.
  const notch = icon("M-1 7.5H0L7 .5L14 7.5H15");
  notch.classList.add("conversation-tree-notch");
  notch.setAttribute("viewBox", "-1 -1 16 9");
  notch.setAttribute("stroke-width", "1");
  notch.setAttribute("stroke-linecap", "butt");
  // Cover the straight panel border underneath the opening, independently
  // of the stroke whose short horizontal ends meet that border's centerline.
  const notchFill = document.createElementNS(SVG_NS, "path");
  notchFill.setAttribute("d", "M-1 7.5H0L7 .5L14 7.5H15V8H-1Z");
  notchFill.setAttribute("fill", "var(--conversation-tree-bg)");
  notchFill.setAttribute("stroke", "none");
  notch.prepend(notchFill);
  root.append(toggle, panel, notch);
  options.host.append(root);
  let dirty = true;
  let pinned = false;
  let navigating = false;
  let replacingNodes = false;
  let closeTimer = 0;
  // Retain the scroll extent while alternative branches fold.
  let stableHalfWidth = 0;
  let stableLeft = 0;
  let stableRight = 0;
  let layoutOrigin = 0;
  let stableCanvasHeight = 0;
  let layoutWidth = 0;
  let zoom = 1;
  let fitting = false;
  let fullWidth = false;
  let canvasLeft = 0;
  let canvasTop = 0;
  let layout = (): void => {};
  let current: HTMLElement | undefined;
  let selection: { id: number; readingId: number | null } | null = null;
  const buttons = new Map<number, HTMLElement>();
  const bandWidths = new Map<number, number>();
  const headingButtons = new Map<string, HTMLElement>();
  const stopFade = scrollFade(scroller);
  // Toolbar interaction makes a hover-opened panel persistent too. Updating
  // the percentage must not let a transient focus/hover change dismiss it.
  controls.addEventListener(
    "pointerdown",
    () => {
      pinned = true;
    },
    { signal },
  );

  function applyZoom(next = zoom): void {
    const width = Math.max(1, scroller.clientWidth - 24);
    const height = Math.max(1, scroller.clientHeight - 24);
    const centerX = (scroller.scrollLeft + width / 2 - canvasLeft) / zoom;
    const centerY = (scroller.scrollTop + height / 2 - canvasTop) / zoom;
    const treeWidth = Math.max(1, stableHalfWidth * 2);
    const treeHeight = Math.max(1, stableCanvasHeight);
    zoom = fitting ? Math.min(1, width / treeWidth, height / treeHeight) : next;
    canvasLeft = Math.max(0, (width - treeWidth * zoom) / 2);
    canvasTop = Math.max(0, (height - treeHeight * zoom) / 2);
    surface.style.width = `${Math.max(width, treeWidth * zoom)}px`;
    surface.style.height = `${Math.max(height, treeHeight * zoom)}px`;
    canvas.style.left = `${canvasLeft}px`;
    canvas.style.top = `${canvasTop}px`;
    canvas.style.transform = `scale(${zoom})`;
    panel.dataset.zoom = String(zoom);
    fitButton.setAttribute("aria-pressed", String(fitting));
    zoomReset.textContent = `${Math.round(zoom * 100)}%`;
    zoomIn.disabled = zoom >= 3;
    zoomOut.disabled =
      zoom <= Math.min(0.1, width / treeWidth, height / treeHeight);
    scroller.scrollTo({
      left: fitting ? 0 : centerX * zoom + canvasLeft - width / 2,
      top: fitting ? 0 : centerY * zoom + canvasTop - height / 2,
      behavior: "instant",
    });
  }

  function changeZoom(next: number): void {
    fitting = false;
    applyZoom(Math.max(Math.min(0.1, zoom), Math.min(3, next)));
  }
  zoomOut.addEventListener("click", () => changeZoom(zoom / 1.25), { signal });
  zoomIn.addEventListener("click", () => changeZoom(zoom * 1.25), { signal });
  zoomReset.addEventListener("click", () => changeZoom(1), { signal });
  widthButton.addEventListener(
    "click",
    () => {
      fullWidth = !fullWidth;
      widthButton.setAttribute("aria-pressed", String(fullWidth));
      widthButton.title = fullWidth
        ? "Restore tree panel width"
        : "Full width tree panel";
      placePanel();
    },
    { signal },
  );
  fitButton.addEventListener(
    "click",
    () => {
      fitting = true;
      render();
    },
    { signal },
  );
  const pointers = new Map<number, { x: number; y: number }>();
  scroller.addEventListener(
    "mousedown",
    (event) => {
      // Every canvas surface, including text, starts a pan gesture.
      if (event.button === 0) event.preventDefault();
    },
    { signal },
  );
  let gesture: {
    x: number;
    y: number;
    distance: number;
    zoom: number;
    left: number;
    top: number;
    anchorX: number;
    anchorY: number;
  } | null = null;
  let dragged = false;
  function pointerCenter(): { x: number; y: number; distance: number } {
    const [first, second] = [...pointers.values()];
    if (!first) return { x: 0, y: 0, distance: 0 };
    return second
      ? {
          x: (first.x + second.x) / 2,
          y: (first.y + second.y) / 2,
          distance: Math.hypot(second.x - first.x, second.y - first.y),
        }
      : { ...first, distance: 0 };
  }
  function beginGesture(): void {
    const point = pointerCenter();
    const view = scroller.getBoundingClientRect();
    gesture = {
      ...point,
      zoom,
      left: scroller.scrollLeft,
      top: scroller.scrollTop,
      anchorX:
        (scroller.scrollLeft + point.x - view.left - 12 - canvasLeft) / zoom,
      anchorY: (scroller.scrollTop + point.y - view.top - canvasTop) / zoom,
    };
  }
  function zoomAt(
    next: number,
    x: number,
    y: number,
    anchorX: number,
    anchorY: number,
  ): void {
    changeZoom(next);
    const view = scroller.getBoundingClientRect();
    scroller.scrollTo({
      left: anchorX * zoom + canvasLeft - (x - view.left - 12),
      top: anchorY * zoom + canvasTop - (y - view.top),
      behavior: "instant",
    });
  }
  scroller.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0 || pointers.size >= 2) return;
      if (pointers.size === 0) dragged = false;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      beginGesture();
    },
    { signal },
  );
  scroller.addEventListener(
    "pointermove",
    (event) => {
      if (!pointers.has(event.pointerId) || !gesture) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const point = pointerCenter();
      if (
        !dragged &&
        pointers.size === 1 &&
        Math.hypot(point.x - gesture.x, point.y - gesture.y) < 4
      )
        return;
      dragged = true;
      fitting = false;
      fitButton.setAttribute("aria-pressed", "false");
      scroller.dataset.dragging = "";
      if (event.isTrusted) scroller.setPointerCapture(event.pointerId);
      event.preventDefault();
      if (pointers.size === 2 && gesture.distance > 0) {
        zoomAt(
          (gesture.zoom * point.distance) / gesture.distance,
          point.x,
          point.y,
          gesture.anchorX,
          gesture.anchorY,
        );
      } else {
        scroller.scrollTo({
          left: gesture.left - (point.x - gesture.x),
          top: gesture.top - (point.y - gesture.y),
          behavior: "instant",
        });
      }
    },
    { signal },
  );
  function endPointer(event: PointerEvent): void {
    if (!pointers.delete(event.pointerId)) return;
    if (pointers.size) beginGesture();
    else {
      gesture = null;
      delete scroller.dataset.dragging;
    }
  }
  document.addEventListener("pointerup", endPointer, { signal });
  document.addEventListener("pointercancel", endPointer, { signal });
  scroller.addEventListener(
    "click",
    (event) => {
      if (dragged) {
        event.preventDefault();
        event.stopPropagation();
        dragged = false;
      }
    },
    { capture: true, signal },
  );
  scroller.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const view = scroller.getBoundingClientRect();
      const anchorX =
        (scroller.scrollLeft + event.clientX - view.left - 12 - canvasLeft) /
        zoom;
      const anchorY =
        (scroller.scrollTop + event.clientY - view.top - canvasTop) / zoom;
      zoomAt(
        zoom * Math.exp(-event.deltaY / 300),
        event.clientX,
        event.clientY,
        anchorX,
        anchorY,
      );
    },
    { passive: false, signal },
  );
  // Safari trackpads expose gesture events instead of control-wheel input.
  let trackpadPinch: {
    zoom: number;
    x: number;
    y: number;
    anchorX: number;
    anchorY: number;
  } | null = null;
  scroller.addEventListener(
    "gesturestart",
    (event) => {
      event.preventDefault();
      const view = scroller.getBoundingClientRect();
      const x =
        "clientX" in event && typeof event.clientX === "number"
          ? event.clientX
          : view.left + view.width / 2;
      const y =
        "clientY" in event && typeof event.clientY === "number"
          ? event.clientY
          : view.top + view.height / 2;
      trackpadPinch = {
        zoom,
        x,
        y,
        anchorX: (scroller.scrollLeft + x - view.left - 12 - canvasLeft) / zoom,
        anchorY: (scroller.scrollTop + y - view.top - canvasTop) / zoom,
      };
    },
    { passive: false, signal },
  );
  scroller.addEventListener(
    "gesturechange",
    (event) => {
      if (
        !trackpadPinch ||
        !("scale" in event) ||
        typeof event.scale !== "number" ||
        !Number.isFinite(event.scale) ||
        event.scale <= 0
      )
        return;
      event.preventDefault();
      const start = trackpadPinch;
      zoomAt(
        start.zoom * event.scale,
        start.x,
        start.y,
        start.anchorX,
        start.anchorY,
      );
    },
    { passive: false, signal },
  );
  scroller.addEventListener(
    "gestureend",
    () => {
      trackpadPinch = null;
    },
    { signal },
  );
  locateButton.addEventListener(
    "click",
    () => {
      updateCurrent();
      if (!current) return;
      const item = current.getBoundingClientRect();
      const width =
        bandWidths.get(Number(current.dataset.messageId)) ??
        current.offsetWidth;
      const view = scroller.getBoundingClientRect();
      scroller.scrollBy({
        left:
          item.left + (width * zoom) / 2 - view.left - scroller.clientWidth / 2,
        top: item.top + item.height / 2 - view.top - scroller.clientHeight / 2,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    },
    { signal },
  );

  function placePanel(): void {
    if (panel.hidden) return;
    const origin = root.getBoundingClientRect();
    const margin = 16;
    if (fullWidth) {
      panel.style.left = `${margin - origin.left}px`;
      panel.style.width = `${Math.max(0, document.documentElement.clientWidth - margin * 2)}px`;
      layout();
      return;
    }
    // Keep the compact-screen popover usable. On desktop, spend the free
    // left gutter first, targeting 15% overlap while keeping controls visible.
    if (window.matchMedia("(max-width: 984px)").matches) {
      panel.style.removeProperty("left");
      panel.style.removeProperty("width");
      layout();
      return;
    }
    const chat = options.host.getBoundingClientRect();
    const rightLimit = Math.min(
      chat.left + chat.width * 0.15,
      document.documentElement.clientWidth - margin,
    );
    const width = Math.min(664, Math.max(214, rightLimit - margin));
    const left = Math.max(margin, origin.right - width);
    panel.style.width = `${width}px`;
    panel.style.left = `${left - origin.left}px`;
    layout();
  }

  // Placement reads geometry only on opening, tree changes, and resizing;
  // it doesn't participate in chat scrolling or streaming frame updates.
  const placementObserver = new ResizeObserver(placePanel);
  placementObserver.observe(options.host);
  window.addEventListener("resize", placePanel, { signal });

  function refreshLoaded(): void {
    if (panel.hidden) return;
    for (const [id, button] of buttons) {
      const loaded = String(options.isLoaded(id));
      if (button.dataset.loaded !== loaded) button.dataset.loaded = loaded;
    }
    for (const button of headingButtons.values()) {
      const loaded = String(options.isLoaded(Number(button.dataset.messageId)));
      if (button.dataset.loaded !== loaded) button.dataset.loaded = loaded;
    }
  }

  function updateCurrent(): void {
    if (panel.hidden) return;
    current?.removeAttribute("aria-current");
    const readingId = options.currentMessage();
    if (
      selection &&
      (selection.readingId !== readingId || !buttons.has(selection.id))
    )
      selection = null;
    const id = selection?.id ?? readingId;
    current = id === null ? undefined : buttons.get(id);
    current?.setAttribute("aria-current", "location");
    locateButton.disabled = !current;
  }

  function revealSelection(
    button: HTMLElement | undefined,
    behavior: ScrollBehavior = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches
      ? "auto"
      : "smooth",
  ): void {
    if (!button) return;
    const item = button.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const inset = 14;
    const nearest = (
      start: number,
      end: number,
      low: number,
      high: number,
    ): number => {
      // Oversized items that already span the viewport need no movement.
      if (start < low && end > high) return 0;
      if (start < low) return start - low;
      if (end > high) return end - high;
      return 0;
    };
    const left = nearest(
      item.left,
      item.right,
      view.left + inset,
      view.left + scroller.clientWidth - inset,
    );
    const top = nearest(
      item.top,
      item.bottom,
      view.top + inset,
      view.top + scroller.clientHeight - inset,
    );
    if (Math.abs(left) < 1 && Math.abs(top) < 1) return;
    scroller.scrollBy({
      left,
      top,
      behavior,
    });
  }

  function render(): void {
    const scrollTop = scroller.scrollTop;
    const scrollLeft = scroller.scrollLeft;
    const previousOrigin = layoutOrigin;
    const focusedHeading =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.dataset.headingIndex
        : undefined;
    const focusedId =
      document.activeElement instanceof HTMLElement &&
      canvas.contains(document.activeElement)
        ? document.activeElement.dataset.messageId
        : undefined;
    buttons.clear();
    bandWidths.clear();
    headingButtons.clear();
    const entries = conversationEntries(options.tree);
    const headings = new Map(
      entries.map((entry) => {
        const sections = options.headings(entry.id);
        // The node title already navigates to the opening section. Keep the
        // original ordinals when hiding its duplicate from the ToC.
        const title = entry.label.replace(/\s+/g, " ").trim();
        return [
          entry.id,
          sections[0]?.label === title ? sections.slice(1) : sections,
        ] as const;
      }),
    );
    const entriesByRow = new Map<number, typeof entries>();
    for (const entry of entries) {
      const siblings = entriesByRow.get(entry.row) ?? [];
      siblings.push(entry);
      entriesByRow.set(entry.row, siblings);
    }
    // Siblings share one depth row; selection changes the blue path, not
    // the position of a version within its parent's fork.
    const displayRows = Array.from(entriesByRow.values());
    // Allow a compact badge line for branches that can be folded. Measure
    // it with its own title, so switching versions doesn't move later rows.
    const badgeEntries = new Set(
      entries
        .filter(
          (entry) =>
            entry.hiddenCount > 0 ||
            ((entriesByRow.get(entry.row)?.length ?? 0) > 1 &&
              (options.tree.get(entry.id)?.childrenIds.length ?? 0) > 0),
        )
        .map((entry) => entry.id),
    );
    const edges = document.createElementNS(SVG_NS, "svg");
    edges.classList.add("conversation-tree-edges");
    edges.setAttribute("aria-hidden", "true");
    const ribbon = document.createElementNS(SVG_NS, "path");
    ribbon.classList.add("conversation-tree-path-ribbon");
    const inactiveEdges = document.createElementNS(SVG_NS, "g");
    const activeEdges = document.createElementNS(SVG_NS, "g");
    // SVG paints in document order: the active spine must cover the shared
    // gray segment, regardless of sibling order.
    edges.append(ribbon, inactiveEdges, activeEdges);
    const content = document.createDocumentFragment();
    content.append(edges);
    const tocs = new Map<number, HTMLUListElement>();
    for (const entry of entries) {
      const button = document.createElement("div");
      button.setAttribute("role", "button");
      button.tabIndex = 0;
      button.className = "conversation-tree-node";
      button.dataset.messageId = String(entry.id);
      button.dataset.row = String(entry.row);
      button.dataset.active = String(entry.active);
      button.dataset.role = entry.role;
      const glyph = document.createElement("span");
      glyph.className = "conversation-tree-glyph";
      const imageIcon = entry.imageCount > 1 ? ICONS.images : ICONS.image;
      const userAttachments =
        entry.role === "user" && (entry.hasImages || entry.fileCount > 0);
      const pictogram = icon(
        entry.image && !userAttachments ? imageIcon : ICONS[entry.role],
      );
      // MessageSquare's drawing spans y=3..22, centered at 12.5, not 12.
      if (entry.role === "user")
        pictogram.setAttribute("viewBox", "0 0.5 24 24");
      glyph.append(pictogram);
      if (userAttachments || (entry.hasImages && !entry.image)) {
        const indicator = document.createElement("span");
        indicator.className = userAttachments
          ? "conversation-tree-attachment-indicator"
          : "conversation-tree-image-indicator";
        indicator.setAttribute("aria-hidden", "true");
        indicator.append(icon(userAttachments ? ICONS.attachment : imageIcon));
        glyph.append(indicator);
      }
      const included: string[] = [];
      if (entry.hasImages)
        included.push(
          `${entry.imageCount} ${entry.imageCount === 1 ? "image" : "images"}`,
        );
      if (entry.fileCount > 0)
        included.push(
          `${entry.fileCount} ${entry.fileCount === 1 ? "file" : "files"}`,
        );
      if (included.length)
        button.setAttribute(
          "aria-description",
          `Includes ${included.join(" and ")}`,
        );
      const text = document.createElement("span");
      text.className = "conversation-tree-text";
      const label = document.createElement("span");
      label.className = "conversation-tree-label";
      label.textContent = entry.label;
      text.append(label);
      if (badgeEntries.has(entry.id)) {
        const count = document.createElement("span");
        count.className = "conversation-tree-count";
        count.textContent = `${entry.descendantCount} more ${entry.descendantCount === 1 ? "message" : "messages"}`;
        // Reserve the folded badge's intrinsic width even on the active branch.
        if (!entry.hiddenCount) {
          count.style.visibility = "hidden";
          count.setAttribute("aria-hidden", "true");
        }
        text.append(count);
      }
      button.append(glyph, text);
      buttons.set(entry.id, button);
      content.append(button);
      const sections = headings.get(entry.id) ?? [];
      if (sections.length) {
        const baseLevel = sections.some((section) => section.level === 1)
          ? 1
          : 2;
        const toc = document.createElement("ul");
        toc.className = "conversation-tree-toc";
        toc.setAttribute("aria-label", `Sections in ${entry.label}`);
        tocs.set(entry.id, toc);
        for (const section of sections) {
          const item = document.createElement("li");
          const heading = document.createElement("div");
          heading.setAttribute("role", "button");
          heading.tabIndex = 0;
          heading.className = "conversation-tree-heading";
          heading.dataset.messageId = String(entry.id);
          heading.dataset.headingIndex = String(section.index);
          heading.dataset.level = String(section.level);
          heading.dataset.depth = String(section.level - baseLevel);
          heading.dataset.active = String(entry.active);
          heading.textContent = section.label;
          heading.title = section.label;
          headingButtons.set(`${entry.id}:${section.index}`, heading);
          item.append(heading);
          toc.append(item);
        }
        content.append(toc);
      }
    }
    // Chromium emits focusout when a focused node is removed. This is an
    // internal replacement, not the reader leaving an unpinned panel.
    replacingNodes = true;
    try {
      canvas.replaceChildren(content);
    } finally {
      replacingNodes = false;
    }
    layout = () => {
      const previousOrigin = layoutOrigin;
      const previousScrollLeft = scroller.scrollLeft;
      const availableWidth = Math.max(0, scroller.clientWidth - 24);
      const maxWidth = Math.max(0, Math.min(320, availableWidth - 16));
      // Apply all caps before measuring: short content shrink-wraps, while
      // long labels and outlines keep the same depth-independent maximum.
      for (const entry of entries) {
        const button = buttons.get(entry.id);
        if (button) button.style.maxWidth = `${maxWidth}px`;
        const toc = tocs.get(entry.id);
        if (toc) toc.style.maxWidth = `${Math.max(0, maxWidth - 20)}px`;
      }
      for (const entry of entries) {
        const toc = tocs.get(entry.id);
        bandWidths.set(
          entry.id,
          Math.max(
            buttons.get(entry.id)?.offsetWidth ?? 0,
            toc ? toc.offsetWidth + 20 : 0,
          ),
        );
      }
      // Keep extents stable for branch switches, but refit on real resizes.
      if (fitting || layoutWidth !== availableWidth) {
        stableLeft = 0;
        stableRight = 0;
      }
      if (fitting) stableCanvasHeight = 0;
      layoutWidth = availableWidth;
      const bands = new Map<number, number>([[0, 0]]);
      for (const siblings of displayRows) {
        let offset = 0;
        const offsets = siblings.map((entry) => {
          const left = offset;
          offset += (bandWidths.get(entry.id) ?? 0) + BAND_GAP;
          return left;
        });
        const center =
          offsets.reduce((sum, left) => sum + left, 0) / siblings.length;
        siblings.forEach((entry, index) => {
          const parent = bands.get(entry.parentId) ?? 0;
          // Pack actual occupied widths, leaving only the gutter between
          // siblings. A single child keeps its parent's spine.
          bands.set(entry.id, parent + (offsets[index] ?? 0) - center);
        });
      }
      for (const entry of entries) {
        const left = (bands.get(entry.id) ?? 0) - 26;
        stableLeft = Math.min(stableLeft, left);
        stableRight = Math.max(
          stableRight,
          left + (bandWidths.get(entry.id) ?? 0),
        );
      }
      const contentWidth = stableRight - stableLeft;
      const canvasWidth = Math.max(availableWidth, contentWidth);
      stableHalfWidth = canvasWidth / 2;
      layoutOrigin = (canvasWidth - contentWidth) / 2 - stableLeft;
      canvas.style.width = `${canvasWidth}px`;
      const positions = new Map<number, { x: number; y: number }>();
      for (const entry of entries) {
        const band = bands.get(entry.id);
        if (band === undefined) continue;
        const x = layoutOrigin + band;
        const left = x - 26;
        positions.set(entry.id, { x, y: 0 });
        const button = buttons.get(entry.id);
        if (button) {
          button.style.left = `${left}px`;
        }
        const toc = tocs.get(entry.id);
        if (toc) {
          toc.style.left = `${x - 6}px`;
        }
      }
      const tocOffsets = new Map<number, number>();
      let canvasHeight = 0;
      displayRows.forEach((row, rowIndex) => {
        let contentBottom = 36;
        let headingCount = 0;
        for (const entry of row) {
          const button = buttons.get(entry.id);
          const label = button?.querySelector<HTMLElement>(
            ".conversation-tree-label",
          );
          const bottom = Math.max(
            36,
            13 +
              (label?.offsetHeight ?? 0) +
              (badgeEntries.has(entry.id) ? 20 : 0),
          );
          contentBottom = Math.max(contentBottom, bottom);
          headingCount = Math.max(
            headingCount,
            headings.get(entry.id)?.length ?? 0,
          );
          const position = positions.get(entry.id);
          if (position) position.y = canvasHeight;
          if (button) {
            button.style.top = `${canvasHeight}px`;
            button.style.height = `${Math.max(48, bottom)}px`;
          }
        }
        const tocOffset = contentBottom > 36 ? contentBottom + 4 : 36;
        for (const entry of row) tocOffsets.set(entry.id, tocOffset);
        const nextRowBranches = displayRows[rowIndex + 1]?.some(
          (entry) => !entry.active,
        );
        const gap = nextRowBranches ? 24 : 8;
        canvasHeight += headingCount
          ? tocOffset + headingCount * HEADING_ROW_HEIGHT + gap
          : Math.max(48, contentBottom + gap);
      });
      stableCanvasHeight = Math.max(stableCanvasHeight, canvasHeight);
      canvas.style.height = `${stableCanvasHeight}px`;
      edges.setAttribute("width", "100%");
      edges.setAttribute("height", String(canvasHeight));
      activeEdges.replaceChildren();
      inactiveEdges.replaceChildren();
      const ribbonPaths: string[] = [];
      for (const entry of entries) {
        const position = positions.get(entry.id);
        if (!position) continue;
        const { x, y } = position;
        // Bridge the glyph as well as the connectors for one continuous stream.
        if (entry.active) ribbonPaths.push(`M${x} ${y + 8}V${y + 36}`);
        const paths: string[] = [];
        const parent = positions.get(entry.parentId);
        if (parent) {
          const direction = Math.sign(x - parent.x);
          const radius = Math.min(8, Math.abs(x - parent.x) / 2);
          paths.push(
            x === parent.x
              ? `M${parent.x} ${parent.y + 36}V${y + 8}`
              : `M${parent.x} ${parent.y + 36}V${y - 8 - radius}Q${parent.x} ${y - 8} ${parent.x + direction * radius} ${y - 8}H${x - direction * radius}Q${x} ${y - 8} ${x} ${y - 8 + radius}V${y + 8}`,
          );
        }
        const toc = tocs.get(entry.id);
        if (toc) {
          const top = y + (tocOffsets.get(entry.id) ?? 36);
          toc.style.top = `${top}px`;
          const count = headings.get(entry.id)?.length ?? 0;
          paths.push(
            `M${x} ${y + 36}V${top + (count - 1) * HEADING_ROW_HEIGHT + 12}`,
          );
        }
        for (const [index, path] of paths.entries()) {
          if (entry.active) ribbonPaths.push(path);
          const edge = document.createElementNS(SVG_NS, "path");
          if (parent && index === 0) {
            edge.dataset.childId = String(entry.id);
            edge.dataset.parentId = String(entry.parentId);
          }
          edge.setAttribute("d", path);
          edge.setAttribute(
            "class",
            `conversation-tree-edge${entry.active ? " active" : ""}`,
          );
          (entry.active ? activeEdges : inactiveEdges).append(edge);
        }
      }
      ribbon.setAttribute("d", ribbonPaths.join(" "));
      scroller.scrollLeft =
        previousScrollLeft + (layoutOrigin - previousOrigin) * zoom;
      applyZoom();
    };
    setStatus(entries.length ? "" : "Send a message to start a conversation.");
    dirty = false;
    placePanel();
    refreshLoaded();
    updateCurrent();
    if (focusedId) {
      const focused =
        focusedHeading === undefined
          ? buttons.get(Number(focusedId))
          : headingButtons.get(`${focusedId}:${focusedHeading}`);
      focused?.focus({ preventScroll: true });
    }
    if (!fitting) {
      scroller.scrollTop = scrollTop;
      scroller.scrollLeft = scrollLeft + (layoutOrigin - previousOrigin) * zoom;
    }
  }

  function positionCurrentView(): void {
    if (fitting) return;
    const target = current ?? buttons.values().next().value;
    if (target) {
      const bandCenter =
        Number.parseFloat(target.style.left) +
        (bandWidths.get(Number(target.dataset.messageId)) ??
          target.offsetWidth) /
          2;
      scroller.scrollTo({
        top: Math.max(
          0,
          Number.parseFloat(target.style.top) * zoom + canvasTop - 96,
        ),
        left: Math.max(
          0,
          bandCenter * zoom + canvasLeft - scroller.clientWidth / 2 + 12,
        ),
        behavior: "instant",
      });
    }
  }

  function open(): void {
    window.clearTimeout(closeTimer);
    if (!panel.hidden) return;
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    if (dirty) render();
    else {
      placePanel();
      refreshLoaded();
    }
    updateCurrent();
    positionCurrentView();
    revealSelection(current ?? buttons.values().next().value, "instant");
  }

  function close(restoreFocus = false): void {
    window.clearTimeout(closeTimer);
    pinned = false;
    pointers.clear();
    trackpadPinch = null;
    gesture = null;
    dragged = false;
    delete scroller.dataset.dragging;
    if (restoreFocus) toggle.focus({ preventScroll: true });
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  }

  root.addEventListener(
    "pointerenter",
    (event) => {
      if (event.pointerType === "mouse") open();
    },
    { signal },
  );
  root.addEventListener(
    "pointerleave",
    () => {
      closeTimer = window.setTimeout(() => {
        if (!pinned && !root.contains(document.activeElement)) close();
      }, 180);
    },
    { signal },
  );
  root.addEventListener("focusin", open, { signal });
  root.addEventListener(
    "pointerdown",
    () => {
      root.dataset.pointerFocus = "";
    },
    { signal },
  );
  root.addEventListener(
    "keydown",
    () => {
      delete root.dataset.pointerFocus;
    },
    { signal },
  );
  root.addEventListener(
    "focusout",
    (event) => {
      if (
        !replacingNodes &&
        !pinned &&
        !(
          event.relatedTarget instanceof Node &&
          root.contains(event.relatedTarget)
        )
      )
        close();
    },
    { signal },
  );
  toggle.addEventListener(
    "click",
    () => {
      if (pinned) close();
      else {
        pinned = true;
        open();
      }
    },
    { signal },
  );
  closeButton.addEventListener("click", () => close(true), { signal });
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (event.target instanceof Node && !root.contains(event.target)) close();
    },
    { signal },
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && !panel.hidden) {
        event.preventDefault();
        close(root.contains(document.activeElement));
      }
    },
    { signal },
  );
  options.viewport.addEventListener("scrollend", () => updateCurrent(), {
    signal,
  });
  canvas.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>(
              '[role="button"][data-message-id]',
            )
          : null;
      if (!target) return;
      event.preventDefault();
      if (!event.repeat) target.click();
    },
    { signal },
  );
  canvas.addEventListener(
    "mousedown",
    (event) => {
      if (event.button !== 0) return;
      const button =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-message-id]")
          : null;
      if (!button) return;
      // Focus must not instantly reveal the item before smooth navigation.
      event.preventDefault();
      button.focus({ preventScroll: true });
    },
    { signal },
  );
  canvas.addEventListener(
    "click",
    async (event) => {
      const button =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-message-id]")
          : null;
      if (!button || navigating) return;
      navigating = true;
      setStatus("Opening message…");
      panel.setAttribute("aria-busy", "true");
      try {
        const headingIndex = button.dataset.headingIndex;
        if (
          await options.navigate(
            Number(button.dataset.messageId),
            headingIndex === undefined ? undefined : Number(headingIndex),
          )
        ) {
          // A short final reply can share the viewport with its prompt.
          // Keep explicit selection distinct from the first-visible marker
          // until the reader moves to another chat position.
          selection = {
            id: Number(button.dataset.messageId),
            readingId: options.currentMessage(),
          };
          dirty = true;
          render();
          updateCurrent();
          revealSelection(
            headingIndex === undefined
              ? buttons.get(Number(button.dataset.messageId))
              : headingButtons.get(
                  `${button.dataset.messageId}:${headingIndex}`,
                ),
          );
        } else setStatus("Finish the current response, then try again.");
      } catch {
        setStatus("Could not open this message. Please try again.");
      } finally {
        navigating = false;
        panel.removeAttribute("aria-busy");
      }
    },
    { signal },
  );
  return {
    refreshLoaded,
    reset() {
      // A new chat must not inherit an old branch's empty canvas or viewport.
      stableHalfWidth = 0;
      stableLeft = 0;
      stableRight = 0;
      layoutOrigin = 0;
      stableCanvasHeight = 0;
      layoutWidth = -1;
      zoom = 1;
      fitting = false;
      selection = null;
      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
      dirty = true;
      if (!panel.hidden) {
        render();
        positionCurrentView();
      }
    },
    refresh() {
      dirty = true;
      if (!panel.hidden) render();
    },
    dispose() {
      listeners.abort();
      placementObserver.disconnect();
      stopFade();
      window.clearTimeout(closeTimer);
      root.remove();
    },
  };
}
