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
  currentHeading?: (id: number) => number | undefined;
  headings: (id: number) => readonly ResponseHeading[];
  navigate: (id: number, headingIndex?: number) => Promise<boolean>;
  /** Image sources of a message, resolved only when its node is hovered. */
  images?: (id: number) => readonly { src: string; label: string }[];
  /** A small preview of a reply's first image, requested once its turn is
   * about to scroll into view: a ready URL, or one still being made. */
  thumbnail?: (id: number) => string | Promise<string | null> | null;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const HEADING_ROW_HEIGHT = 24;
const BAND_GAP = 12;
/** Children closer than this to their parent's spine continue it straight. */
const SPINE_SNAP = 24;
/** A reply's image thumbnail; its line grows to this height. */
const THUMBNAIL_HEIGHT = 30;
/** A tree jump shows "Opening message…" only after waiting this long. */
const OPENING_STATUS_DELAY_MS = 400;
/** A node's label starts this far in from its left and top edges. */
const TEXT_LEFT = 49;
const TEXT_TOP = 13;
/** Even space between the keyboard focus ring and the turn it frames. */
const FOCUS_RING_PADDING = 8;
/** Rails run through each node's dot, centered this far below its top. */
const DOT_CENTER = 22;
/** Trackpad pinches zoom this much faster than 1:1; touch pinches stay 1:1
 * so the content stays under the fingers. */
const PINCH_GAIN = 2.5;
const ICONS = {
  // Lucide CornerDownRight: a reply continuing from its prompt above.
  reply: "M15 10l5 5-5 5M4 4v7a4 4 0 0 0 4 4h12",
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
  // Hovering an image node previews its first image beside the panel.
  const imageCard = document.createElement("figure");
  imageCard.className = "conversation-tree-image-card";
  imageCard.setAttribute("aria-hidden", "true");
  imageCard.hidden = true;
  const cardImage = document.createElement("img");
  cardImage.alt = "";
  cardImage.decoding = "async";
  const cardCaption = document.createElement("figcaption");
  const cardLabel = document.createElement("span");
  const cardCount = document.createElement("span");
  cardCount.className = "conversation-tree-image-count";
  cardCaption.append(cardLabel, cardCount);
  imageCard.append(cardImage, cardCaption);
  root.append(toggle, panel, notch, imageCard);
  options.host.append(root);
  let dirty = true;
  let pinned = false;
  let navigating = false;
  let navigationEpoch = 0;
  let replacingNodes = false;
  let closeTimer = 0;
  let statusTimer = 0;
  let imageTimer = 0;
  let imageNode: HTMLElement | null = null;
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
  let selection: {
    id: number;
    headingIndex: number | undefined;
    readingId: number | null;
  } | null = null;
  const buttons = new Map<number, HTMLElement>();
  // A turn's reply maps to its prompt, whose dot stands for the whole turn.
  const turns = new Map<number, number>();
  const turnReplies = new Map<number, number>();
  // Where each turn's text or thumbnail ends, in canvas coordinates.
  const turnBottoms = new Map<number, number>();
  let readingDot: HTMLElement | undefined;
  /**
   * The rounded box around a turn's text and thumbnail, with even padding;
   * the rail, its glow, and the dot stay outside. A reply resolves to its
   * prompt's turn. Built from stored positions, never measured.
   */
  function placeOnTurn(box: HTMLElement, node: HTMLElement | undefined): void {
    const id = Number(node?.dataset.messageId);
    const turn = node?.isConnected ? buttons.get(turns.get(id) ?? id) : null;
    const turnId = Number(turn?.dataset.messageId);
    const left = Number.parseFloat(turn?.style.left ?? "");
    const top = Number.parseFloat(turn?.style.top ?? "");
    const bottom = turnBottoms.get(turnId) ?? Number.NaN;
    const width = bandWidths.get(turnId) ?? Number.NaN;
    box.hidden = ![left, top, bottom, width].every(Number.isFinite);
    if (box.hidden) return;
    const p = FOCUS_RING_PADDING;
    box.style.left = `${left + TEXT_LEFT - p}px`;
    box.style.top = `${top + TEXT_TOP - p}px`;
    box.style.width = `${width - TEXT_LEFT + 2 * p}px`;
    box.style.height = `${bottom - top - TEXT_TOP + 2 * p}px`;
  }
  // Keyboard focus frames the whole turn instead of
  // the focused node's own box, which covers a prompt but not its reply.
  let focusRing: HTMLElement | null = null;
  function placeFocusRing(): void {
    if (!focusRing) return;
    const focused = document.activeElement;
    const node =
      focused instanceof HTMLElement &&
      focused.matches(".conversation-tree-node") &&
      canvas.contains(focused) &&
      root.dataset.pointerFocus === undefined
        ? focused
        : undefined;
    placeOnTurn(focusRing, node);
  }
  const bandWidths = new Map<number, number>();
  const headingButtons = new Map<string, HTMLElement>();
  const stopFade = scrollFade(scroller);
  // Thumbnails shown per message, so a rebuild repaints them without waiting.
  const thumbnails = new Map<number, string>();
  const thumbnailSlots = new Map<Element, number>();
  function showThumbnail(slot: Element, url: string): void {
    if (slot.querySelector("img")?.getAttribute("src") === url) return;
    const image = document.createElement("img");
    image.alt = "";
    image.decoding = "async";
    image.src = url;
    slot.replaceChildren(image);
  }
  // Thumbnail requests and swaps wait until the tree has stopped scrolling,
  // so scrolling frames never mutate the canvas.
  const pendingSlots = new Set<Element>();
  const pendingReveals = new Map<Element, string>();
  let lastTreeScroll = 0;
  let thumbnailTimer = 0;
  function flushThumbnails(): void {
    window.clearTimeout(thumbnailTimer);
    const wait = 150 - (performance.now() - lastTreeScroll);
    if (wait > 0) {
      thumbnailTimer = window.setTimeout(flushThumbnails, wait);
      return;
    }
    // Take the queues first: a ready thumbnail reveals synchronously and
    // flushes again.
    const reveals = [...pendingReveals];
    const slots = [...pendingSlots];
    pendingReveals.clear();
    pendingSlots.clear();
    for (const [slot, url] of reveals)
      if (slot.isConnected) showThumbnail(slot, url);
    for (const slot of slots) requestThumbnail(slot);
  }
  function requestThumbnail(slot: Element): void {
    const id = thumbnailSlots.get(slot);
    const request = id === undefined ? null : options.thumbnail?.(id);
    if (id === undefined || !request) return;
    const reveal = (url: string): void => {
      thumbnails.set(id, url);
      if (thumbnailSlots.get(slot) !== id) return;
      pendingReveals.set(slot, url);
      flushThumbnails();
    };
    if (typeof request === "string") reveal(request);
    else
      void request.then(async (url) => {
        if (!url) return;
        // Swap in a decoded preview so the slot never paints empty.
        const probe = new Image();
        probe.src = url;
        await probe.decode().catch(() => undefined);
        reveal(url);
      });
  }
  const thumbnailObserver = new IntersectionObserver(
    (records) => {
      for (const record of records) {
        if (!record.isIntersecting) continue;
        thumbnailObserver.unobserve(record.target);
        pendingSlots.add(record.target);
      }
      if (pendingSlots.size) flushThumbnails();
    },
    { root: scroller, rootMargin: "240px" },
  );
  scroller.addEventListener(
    "scroll",
    () => {
      lastTreeScroll = performance.now();
    },
    { passive: true, signal },
  );
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
      if (event.pointerType === "touch") return;
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
  // Leave one-finger panning to the browser, including momentum after release.
  // Touch events keep pinch tracking alive when native pan cancels pointers.
  let touchCount = 0;
  let touchPinch: {
    distance: number;
    zoom: number;
    anchorX: number;
    anchorY: number;
  } | null = null;
  function handleTouch(event: TouchEvent): void {
    const previousCount = touchCount;
    // Fingers may start on different labels, so targetTouches is too narrow.
    const touches = Array.from(event.touches).filter(
      (touch) =>
        touch.target instanceof Node && scroller.contains(touch.target),
    );
    touchCount = touches.length;
    if (touchCount === 0) {
      touchPinch = null;
      return;
    }
    if (previousCount === 0) dragged = false;
    if (event.type === "touchmove") {
      fitting = false;
      fitButton.setAttribute("aria-pressed", "false");
    }
    // Once claimed, suppress the remaining finger until the pinch ends.
    if (touchPinch && event.cancelable) event.preventDefault();
    const [first, second] = touches;
    if (!first || !second || !event.cancelable) return;
    event.preventDefault();
    dragged = true;
    const x = (first.clientX + second.clientX) / 2;
    const y = (first.clientY + second.clientY) / 2;
    const distance = Math.hypot(
      second.clientX - first.clientX,
      second.clientY - first.clientY,
    );
    if (!touchPinch || previousCount !== touchCount) {
      const view = scroller.getBoundingClientRect();
      touchPinch = {
        distance,
        zoom,
        anchorX: (scroller.scrollLeft + x - view.left - 12 - canvasLeft) / zoom,
        anchorY: (scroller.scrollTop + y - view.top - canvasTop) / zoom,
      };
      return;
    }
    if (touchPinch.distance > 0) {
      zoomAt(
        (touchPinch.zoom * distance) / touchPinch.distance,
        x,
        y,
        touchPinch.anchorX,
        touchPinch.anchorY,
      );
    }
  }
  for (const type of [
    "touchstart",
    "touchmove",
    "touchend",
    "touchcancel",
  ] as const) {
    scroller.addEventListener(type, handleTouch, { passive: false, signal });
  }
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
        zoom * Math.exp((-event.deltaY * PINCH_GAIN) / 300),
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
      if (touchCount > 0) return;
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
        touchCount > 0 ||
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
        start.zoom * event.scale ** PINCH_GAIN,
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
      // Locate reads the chat now, not the last explicit tree selection.
      selection = null;
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

  function hideImageCard(): void {
    window.clearTimeout(imageTimer);
    imageNode = null;
    imageCard.hidden = true;
    cardImage.removeAttribute("src");
  }

  function placeImageCard(node: HTMLElement): void {
    const margin = 8;
    const origin = root.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    const item = node.getBoundingClientRect();
    const width = imageCard.offsetWidth;
    const height = imageCard.offsetHeight;
    const viewWidth = document.documentElement.clientWidth;
    const viewHeight = document.documentElement.clientHeight;
    const clamp = (value: number, low: number, high: number): number =>
      Math.max(low, Math.min(value, high));
    let left: number;
    let top: number;
    // Beside the panel keeps the tree readable; a full-width panel falls
    // back to below (or above) the hovered node.
    if (bounds.right + margin + width <= viewWidth - margin)
      left = bounds.right + margin;
    else if (bounds.left - margin - width >= margin)
      left = bounds.left - margin - width;
    else left = Number.NaN;
    if (Number.isNaN(left)) {
      left = clamp(item.left, margin, viewWidth - margin - width);
      top =
        item.bottom + 4 + height <= viewHeight - margin
          ? item.bottom + 4
          : item.top - 4 - height;
    } else top = item.top + item.height / 2 - height / 2;
    top = clamp(top, margin, viewHeight - margin - height);
    imageCard.style.left = `${left - origin.left}px`;
    imageCard.style.top = `${top - origin.top}px`;
  }

  function showImageCard(node: HTMLElement): void {
    const images = options.images?.(Number(node.dataset.messageId)) ?? [];
    const first = images[0];
    if (!first) return;
    imageNode = node;
    cardLabel.textContent = first.label;
    cardCount.textContent = images.length > 1 ? `+${images.length - 1}` : "";
    cardImage.src = first.src;
    // Reveal only a decoded image, so the card never flashes empty.
    cardImage
      .decode()
      .then(() => {
        if (imageNode !== node || panel.hidden) return;
        imageCard.hidden = false;
        placeImageCard(node);
      })
      .catch(() => {
        if (imageNode === node) hideImageCard();
      });
  }

  // A pressed node stays without a card, also after navigation rebuilds it
  // under the resting pointer, until the pointer leaves that node.
  let suppressedImageId: string | undefined;
  // Phones have neither hover nor room beside the panel for a preview.
  const canHover = window.matchMedia("(hover: hover) and (pointer: fine)");
  const treeNode = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element
      ? target.closest<HTMLElement>(".conversation-tree-node")
      : null;
  // Movement, not pointerover: a rebuild fires pointerover on the new node
  // beneath a pointer that never moved.
  canvas.addEventListener(
    "pointermove",
    (event) => {
      if (
        event.pointerType !== "mouse" ||
        pointers.size > 0 ||
        !canHover.matches
      )
        return;
      const node = treeNode(event.target);
      if (
        !node ||
        node === imageNode ||
        node.dataset.images === undefined ||
        node.dataset.messageId === suppressedImageId
      )
        return;
      hideImageCard();
      imageNode = node;
      imageTimer = window.setTimeout(() => showImageCard(node), 250);
    },
    { signal },
  );
  canvas.addEventListener(
    "pointerout",
    (event) => {
      const next = treeNode(event.relatedTarget);
      if (imageNode && next !== imageNode) hideImageCard();
      // A node removed by a rebuild reports no destination; that isn't leaving.
      const left = next ?? (event.target as Node).isConnected;
      if (left && next?.dataset.messageId !== suppressedImageId)
        suppressedImageId = undefined;
    },
    { signal },
  );
  scroller.addEventListener("scroll", hideImageCard, {
    passive: true,
    signal,
  });
  scroller.addEventListener(
    "pointerdown",
    (event) => {
      suppressedImageId = treeNode(event.target)?.dataset.messageId;
      hideImageCard();
    },
    { signal },
  );

  function placePanel(): void {
    if (signal.aborted || panel.hidden) return;
    const origin = root.getBoundingClientRect();
    const margin = 16;
    panel.style.removeProperty("height");
    if (fullWidth) {
      panel.style.left = `${margin - origin.left}px`;
      panel.style.width = `${Math.max(0, document.documentElement.clientWidth - margin * 2)}px`;
      layout();
      return;
    }
    const compact = window.matchMedia("(max-width: 984px)").matches;
    if (compact) {
      panel.style.removeProperty("left");
      panel.style.removeProperty("width");
    }
    const chat = options.host.getBoundingClientRect();
    const rightLimit = Math.min(
      chat.left + chat.width * 0.15,
      document.documentElement.clientWidth - margin,
    );
    const maximumWidth = compact
      ? Math.min(460, document.documentElement.clientWidth - margin * 2)
      : Math.min(664, Math.max(214, rightLimit - margin));
    // Measure at the allowed width first, so an earlier narrow viewport
    // cannot permanently constrain labels. The overlap allowance is a cap,
    // not a request to fill the entire gutter and part of the chat.
    panel.style.width = `${maximumWidth}px`;
    layout();
    const width = Math.min(
      maximumWidth,
      // An empty panel keeps room for its title beside the close button.
      Math.max(
        panel.hasAttribute("data-empty") ? 260 : 214,
        Math.ceil(stableRight - stableLeft) + 26,
      ),
    );
    panel.style.width = `${width}px`;
    if (!compact) {
      const left = Math.max(margin, origin.right - width);
      panel.style.left = `${left - origin.left}px`;
    }
    layout();
    // An empty tree shows only its in-flow message below the header.
    panel.style.height = `${Math.min(
      panel.getBoundingClientRect().height,
      header.offsetHeight +
        (panel.hasAttribute("data-empty")
          ? status.offsetHeight
          : stableCanvasHeight + 26),
    )}px`;
    layout();
  }

  // Placement reads geometry only on opening, tree changes, and resizing;
  // it doesn't participate in chat scrolling or streaming frame updates.
  const placementObserver = new ResizeObserver(placePanel);
  placementObserver.observe(options.host);
  window.addEventListener("resize", placePanel, { signal });

  function refreshLoaded(): void {
    if (signal.aborted || panel.hidden) return;
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
    const headingIndex = selection
      ? selection.headingIndex
      : id === null
        ? undefined
        : options.currentHeading?.(id);
    current =
      id === null
        ? undefined
        : headingIndex === undefined
          ? buttons.get(id)
          : (headingButtons.get(`${id}:${headingIndex}`) ?? buttons.get(id));
    current?.setAttribute("aria-current", "location");
    // Fill the dot of the turn being read, also when its reply or one of
    // the reply's sections is the current location.
    readingDot?.removeAttribute("data-reading");
    readingDot = id === null ? undefined : buttons.get(turns.get(id) ?? id);
    readingDot?.setAttribute("data-reading", "");
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
    turns.clear();
    turnReplies.clear();
    turnBottoms.clear();
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
    const childEntries = new Map<number, typeof entries>();
    for (const entry of entries) {
      const siblings = childEntries.get(entry.parentId) ?? [];
      siblings.push(entry);
      childEntries.set(entry.parentId, siblings);
    }
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
    // Above the rails, below every node.
    focusRing = document.createElement("div");
    focusRing.className = "conversation-tree-focus-ring";
    focusRing.setAttribute("aria-hidden", "true");
    focusRing.hidden = true;
    content.append(focusRing);
    const tocs = new Map<number, HTMLUListElement>();
    for (const entry of entries) {
      const button = document.createElement("div");
      button.setAttribute("role", "button");
      button.tabIndex = 0;
      button.className = entry.attached
        ? "conversation-tree-node conversation-tree-reply"
        : "conversation-tree-node";
      button.dataset.messageId = String(entry.id);
      button.dataset.row = String(entry.row);
      button.dataset.active = String(entry.active);
      button.dataset.role = entry.role;
      if (entry.hasImages) button.dataset.images = String(entry.imageCount);
      const glyph = document.createElement("span");
      glyph.className = "conversation-tree-glyph";
      // A prompt or standalone message is a dot on its rail. A turn's reply
      // line previews its first image, or marks a text reply with an icon.
      if (entry.attached && entry.hasImages && options.thumbnail) {
        glyph.classList.add("conversation-tree-thumb");
        glyph.append(icon(entry.imageCount > 1 ? ICONS.images : ICONS.image));
        thumbnailSlots.set(glyph, entry.id);
        const shown = thumbnails.get(entry.id);
        if (shown) showThumbnail(glyph, shown);
      } else if (entry.attached)
        glyph.append(
          icon(
            entry.hasImages
              ? entry.imageCount > 1
                ? ICONS.images
                : ICONS.image
              : ICONS.reply,
          ),
        );
      // Leading the label's first line, like the reply line's icon: a
      // prompt's attachments or a standalone message's images.
      let indicator: HTMLElement | null = null;
      if (!entry.attached && (entry.hasImages || entry.fileCount > 0)) {
        const userAttachments = entry.role === "user";
        indicator = document.createElement("span");
        indicator.className = userAttachments
          ? "conversation-tree-attachment-indicator"
          : "conversation-tree-image-indicator";
        indicator.setAttribute("aria-hidden", "true");
        indicator.append(
          icon(
            userAttachments
              ? ICONS.attachment
              : entry.imageCount > 1
                ? ICONS.images
                : ICONS.image,
          ),
        );
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
      // Inline, so wrapped lines return to the column edge beneath it.
      if (indicator) label.prepend(indicator);
      text.append(label);
      // A text reply's arrow leads its first line, so a wrapped second line
      // returns to the column edge; a thumbnail stays beside the text.
      if (
        entry.attached &&
        !glyph.classList.contains("conversation-tree-thumb")
      ) {
        label.prepend(glyph);
        button.append(text);
      } else button.append(glyph, text);
      buttons.set(entry.id, button);
      if (entry.attached) {
        turns.set(entry.id, entry.parentId);
        turnReplies.set(entry.parentId, entry.id);
      }
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
    hideImageCard();
    // Chromium emits focusout when a focused node is removed. This is an
    // internal replacement, not the reader leaving an unpinned panel.
    replacingNodes = true;
    try {
      canvas.replaceChildren(content);
    } finally {
      replacingNodes = false;
    }
    thumbnailObserver.disconnect();
    for (const slot of thumbnailSlots.keys()) {
      if (slot.isConnected) thumbnailObserver.observe(slot);
      else thumbnailSlots.delete(slot);
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
      // Read every measurement before the first position write, so a large
      // tree costs one layout rather than one per node.
      const labelHeights = new Map<number, number>();
      for (const entry of entries) {
        const toc = tocs.get(entry.id);
        const button = buttons.get(entry.id);
        bandWidths.set(
          entry.id,
          Math.max(button?.offsetWidth ?? 0, toc ? toc.offsetWidth + 20 : 0),
        );
        labelHeights.set(
          entry.id,
          button?.querySelector<HTMLElement>(".conversation-tree-label")
            ?.offsetHeight ?? 0,
        );
      }
      // A turn packs as one band: its prompt and reply share a spine and row.
      const replies = new Map<number, (typeof entries)[number]>();
      for (const entry of entries) {
        if (!entry.attached) continue;
        replies.set(entry.parentId, entry);
        bandWidths.set(
          entry.parentId,
          Math.max(
            bandWidths.get(entry.parentId) ?? 0,
            bandWidths.get(entry.id) ?? 0,
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
      // Each turn starts below its own parent turn, not below the tallest
      // node at its depth, so alternative paths keep their own heights.
      // Depth-first order places every parent before its children.
      const tops = new Map<number, number>();
      const steps = new Map<number, number>();
      const tocOffsets = new Map<number, number>();
      let canvasHeight = 0;
      for (const entry of entries) {
        // A reply is placed beneath its prompt's label, in the same band.
        if (entry.attached) continue;
        const top =
          (tops.get(entry.parentId) ?? 0) + (steps.get(entry.parentId) ?? 0);
        const button = buttons.get(entry.id);
        let bottom = Math.max(36, 13 + (labelHeights.get(entry.id) ?? 0));
        let height = Math.max(48, bottom);
        const reply = replies.get(entry.id);
        const replyButton = reply && buttons.get(reply.id);
        if (reply && replyButton) {
          const replyTop = 17 + (labelHeights.get(entry.id) ?? 0);
          const replyHeight = Math.max(
            labelHeights.get(reply.id) ?? 0,
            reply.hasImages && options.thumbnail ? THUMBNAIL_HEIGHT : 0,
          );
          replyButton.style.top = `${top + replyTop}px`;
          replyButton.style.height = `${replyHeight + 8}px`;
          height = replyTop;
          bottom = Math.max(36, replyTop + replyHeight);
          turnBottoms.set(entry.id, top + replyTop + replyHeight);
        } else
          turnBottoms.set(
            entry.id,
            top + TEXT_TOP + (labelHeights.get(entry.id) ?? 0),
          );
        if (button) {
          button.style.top = `${top}px`;
          button.style.height = `${height}px`;
        }
        const turn = reply ? [entry.id, reply.id] : [entry.id];
        const headingCount = Math.max(
          ...turn.map((id) => headings.get(id)?.length ?? 0),
        );
        const tocOffset = bottom > 36 ? bottom + 4 : 36;
        // Fork connectors turn sideways below the turn and need the room.
        const forks = childEntries.get((reply ?? entry).id)?.length ?? 0;
        const gap = forks > 1 ? 24 : 8;
        const step = headingCount
          ? tocOffset + headingCount * HEADING_ROW_HEIGHT + gap
          : Math.max(48, bottom + gap);
        for (const id of turn) {
          tops.set(id, top);
          steps.set(id, step);
          tocOffsets.set(id, tocOffset);
        }
        canvasHeight = Math.max(canvasHeight, top + step);
      }
      // Each subtree records its occupied extent per row, relative to its
      // own spine, with the row's vertical span. Rows of different subtrees
      // need not align, so siblings pack against every row they overlap
      // vertically, with one gutter, and center under their parent; a single
      // child keeps the parent's spine and shares its contour, so linear
      // chats stay linear time.
      type Contour = {
        left: number[];
        right: number[];
        top: number[];
        bottom: number[];
      };
      const contours = new Map<number, Contour>();
      const shifts = new Map<number, number>();
      const pack = (parentId: number): Contour => {
        const children = childEntries.get(parentId) ?? [];
        const only = children.length === 1 ? children[0] : undefined;
        const onlyContour = only && contours.get(only.id);
        if (only && onlyContour) {
          shifts.set(only.id, 0);
          return onlyContour;
        }
        const merged: Contour = { left: [], right: [], top: [], bottom: [] };
        const placed = children.map((child) => {
          const contour = contours.get(child.id);
          if (!contour) return 0;
          let shift = 0;
          for (let row = child.row; row < contour.left.length; row++) {
            const left = contour.left[row];
            const top = contour.top[row];
            const bottom = contour.bottom[row];
            if (left === undefined || top === undefined || bottom === undefined)
              continue;
            // A row's highest top grows with depth, so later rows start
            // below this one once a top passes its bottom.
            for (let other = child.row; other < merged.right.length; other++) {
              const right = merged.right[other];
              const otherTop = merged.top[other];
              const otherBottom = merged.bottom[other];
              if (
                right === undefined ||
                otherTop === undefined ||
                otherBottom === undefined
              )
                continue;
              if (otherTop >= bottom) break;
              if (otherBottom > top)
                shift = Math.max(shift, right + BAND_GAP - left);
            }
          }
          for (let row = child.row; row < contour.left.length; row++) {
            const left = contour.left[row];
            const right = contour.right[row];
            const top = contour.top[row];
            const bottom = contour.bottom[row];
            if (
              left === undefined ||
              right === undefined ||
              top === undefined ||
              bottom === undefined
            )
              continue;
            merged.left[row] = Math.min(
              merged.left[row] ?? left + shift,
              left + shift,
            );
            merged.right[row] = Math.max(
              merged.right[row] ?? right + shift,
              right + shift,
            );
            merged.top[row] = Math.min(merged.top[row] ?? top, top);
            merged.bottom[row] = Math.max(merged.bottom[row] ?? bottom, bottom);
          }
          return shift;
        });
        let center =
          placed.reduce((sum, shift) => sum + shift, 0) / (placed.length || 1);
        // A child a few pixels off its parent's spine would draw a jog, not
        // an elbow. Align the nearest child exactly; the group stays packed.
        const nearest = placed.reduce(
          (best, shift) =>
            Math.abs(shift - center) < Math.abs(best - center) ? shift : best,
          placed[0] ?? 0,
        );
        if (Math.abs(nearest - center) < SPINE_SNAP) center = nearest;
        children.forEach((child, index) => {
          shifts.set(child.id, (placed[index] ?? 0) - center);
        });
        for (let row = 0; row < merged.left.length; row++) {
          const left = merged.left[row];
          const right = merged.right[row];
          if (left === undefined || right === undefined) continue;
          merged.left[row] = left - center;
          merged.right[row] = right - center;
        }
        return merged;
      };
      // Reverse depth-first order visits every child before its parent.
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (!entry) continue;
        const contour = pack(entry.id);
        contour.left[entry.row] = -26;
        contour.right[entry.row] = -26 + (bandWidths.get(entry.id) ?? 0);
        // The span starts above the turn to keep its incoming elbow clear.
        const top = tops.get(entry.id) ?? 0;
        contour.top[entry.row] = top - 16;
        contour.bottom[entry.row] = top + (steps.get(entry.id) ?? 0);
        contours.set(entry.id, contour);
      }
      pack(0);
      const bands = new Map<number, number>([[0, 0]]);
      for (const entry of entries) {
        bands.set(
          entry.id,
          (bands.get(entry.parentId) ?? 0) + (shifts.get(entry.id) ?? 0),
        );
      }
      for (const entry of entries) {
        const left = (bands.get(entry.id) ?? 0) - 26;
        stableLeft = Math.min(stableLeft, left);
        // The focus ring extends past the band's text.
        stableRight = Math.max(
          stableRight,
          left + (bandWidths.get(entry.id) ?? 0) + FOCUS_RING_PADDING,
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
        positions.set(entry.id, { x, y: tops.get(entry.id) ?? 0 });
        const button = buttons.get(entry.id);
        if (button) {
          button.style.left = `${left}px`;
        }
        const toc = tocs.get(entry.id);
        if (toc) {
          toc.style.left = `${x - 6}px`;
        }
      }
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
        // Connectors meet at dot centers, so the active ones form one stream.
        // A reply shares its prompt's dot, rail, and incoming connector.
        const paths: string[] = [];
        const parent = entry.attached
          ? undefined
          : positions.get(entry.parentId);
        if (parent) {
          const direction = Math.sign(x - parent.x);
          const radius = Math.min(8, Math.abs(x - parent.x) / 2);
          paths.push(
            x === parent.x
              ? `M${parent.x} ${parent.y + DOT_CENTER}V${y + DOT_CENTER}`
              : `M${parent.x} ${parent.y + DOT_CENTER}V${y - 8 - radius}Q${parent.x} ${y - 8} ${parent.x + direction * radius} ${y - 8}H${x - direction * radius}Q${x} ${y - 8} ${x} ${y - 8 + radius}V${y + DOT_CENTER}`,
          );
        }
        const toc = tocs.get(entry.id);
        if (toc) {
          const top = y + (tocOffsets.get(entry.id) ?? 36);
          toc.style.top = `${top}px`;
          const count = headings.get(entry.id)?.length ?? 0;
          paths.push(
            `M${x} ${y + DOT_CENTER}V${top + (count - 1) * HEADING_ROW_HEIGHT + 12}`,
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
      placeFocusRing();
    };
    panel.toggleAttribute("data-empty", entries.length === 0);
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

  function clearGesture(): void {
    for (const id of pointers.keys()) {
      if (scroller.hasPointerCapture(id)) scroller.releasePointerCapture(id);
    }
    pointers.clear();
    touchCount = 0;
    touchPinch = null;
    trackpadPinch = null;
    gesture = null;
    dragged = false;
    delete scroller.dataset.dragging;
  }

  function close(restoreFocus = false): void {
    window.clearTimeout(closeTimer);
    pinned = false;
    clearGesture();
    hideImageCard();
    suppressedImageId = undefined;
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
        if (pinned) return;
        // A clicked node keeps focus; only keyboard focus holds the panel.
        const focused = document.activeElement;
        if (!root.contains(focused)) close();
        else if (root.dataset.pointerFocus !== undefined) {
          if (focused instanceof HTMLElement) focused.blur();
          close();
        }
      }, 180);
    },
    { signal },
  );
  root.addEventListener("focusin", open, { signal });
  root.addEventListener(
    "pointerdown",
    () => {
      root.dataset.pointerFocus = "";
      placeFocusRing();
    },
    { signal },
  );
  root.addEventListener(
    "keydown",
    () => {
      delete root.dataset.pointerFocus;
      placeFocusRing();
    },
    { signal },
  );
  canvas.addEventListener("focusin", placeFocusRing, { signal });
  canvas.addEventListener("focusout", () => queueMicrotask(placeFocusRing), {
    signal,
  });
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
      const epoch = navigationEpoch;
      const isCurrentNavigation = (): boolean =>
        !signal.aborted && epoch === navigationEpoch;
      navigating = true;
      // Most jumps land at once; announce only one that waits, such as an
      // older page loading, so a quick click never flashes a status line.
      window.clearTimeout(statusTimer);
      statusTimer = window.setTimeout(() => {
        if (navigating && isCurrentNavigation()) setStatus("Opening message…");
      }, OPENING_STATUS_DELAY_MS);
      panel.setAttribute("aria-busy", "true");
      try {
        const headingIndex = button.dataset.headingIndex;
        const opened = await options.navigate(
          Number(button.dataset.messageId),
          headingIndex === undefined ? undefined : Number(headingIndex),
        );
        if (!isCurrentNavigation()) return;
        if (opened) {
          // A short final reply can share the viewport with its prompt.
          // Keep explicit selection distinct from the first-visible marker
          // until the reader moves to another chat position.
          selection = {
            id: Number(button.dataset.messageId),
            headingIndex:
              headingIndex === undefined ? undefined : Number(headingIndex),
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
        if (isCurrentNavigation())
          setStatus("Could not open this message. Please try again.");
      } finally {
        if (isCurrentNavigation()) {
          window.clearTimeout(statusTimer);
          navigating = false;
          panel.removeAttribute("aria-busy");
        }
      }
    },
    { signal },
  );
  return {
    refreshLoaded,
    reset() {
      if (signal.aborted) return;
      // A new conversation must not inherit pending selection or busy state.
      navigationEpoch++;
      window.clearTimeout(statusTimer);
      navigating = false;
      clearGesture();
      panel.removeAttribute("aria-busy");
      setStatus("");
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
      thumbnails.clear();
      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
      dirty = true;
      if (!panel.hidden) {
        render();
        positionCurrentView();
      }
    },
    refresh() {
      if (signal.aborted) return;
      dirty = true;
      if (!panel.hidden) render();
    },
    dispose() {
      if (signal.aborted) return;
      listeners.abort();
      clearGesture();
      placementObserver.disconnect();
      thumbnailObserver.disconnect();
      thumbnailSlots.clear();
      pendingSlots.clear();
      pendingReveals.clear();
      window.clearTimeout(thumbnailTimer);
      stopFade();
      window.clearTimeout(closeTimer);
      window.clearTimeout(imageTimer);
      window.clearTimeout(statusTimer);
      root.remove();
    },
  };
}
