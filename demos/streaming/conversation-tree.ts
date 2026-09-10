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
const MIN_BAND_WIDTH = 208;
const HEADING_ROW_HEIGHT = 24;
const ICONS = {
  user: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2v-10a9.5 9.5 0 1 1 19 0Z",
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
  const scroller = document.createElement("div");
  scroller.className = "conversation-tree-scroll";
  const canvas = document.createElement("div");
  canvas.className = "conversation-tree-canvas";
  scroller.append(canvas);
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
  let stableCanvasHeight = 0;
  let layoutWidth = 0;
  let layout = (): void => {};
  let current: HTMLButtonElement | undefined;
  const buttons = new Map<number, HTMLButtonElement>();
  const headingButtons = new Map<string, HTMLButtonElement>();
  const stopFade = scrollFade(scroller);

  function placePanel(): void {
    if (panel.hidden) return;
    // Keep the compact-screen popover usable. On desktop, spend the free
    // left gutter first and never cover more than 15% of the chat column.
    if (window.matchMedia("(max-width: 984px)").matches) {
      panel.style.removeProperty("left");
      panel.style.removeProperty("width");
      layout();
      return;
    }
    const chat = options.host.getBoundingClientRect();
    const origin = root.getBoundingClientRect();
    const margin = 16;
    const rightLimit = Math.min(
      chat.left + chat.width * 0.15,
      document.documentElement.clientWidth - margin,
    );
    const width = Math.min(664, Math.max(0, rightLimit - margin));
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

  function updateCurrent(center = false): void {
    if (panel.hidden) return;
    current?.removeAttribute("aria-current");
    const id = options.currentMessage();
    current = id === null ? undefined : buttons.get(id);
    current?.setAttribute("aria-current", "location");
    if (center && current) {
      scroller.scrollTop = Math.max(
        0,
        Number.parseFloat(current.style.top) - 96,
      );
      scroller.scrollLeft = Math.max(
        0,
        (canvas.offsetWidth - scroller.clientWidth) / 2 + 12,
      );
    }
  }

  function revealSelection(button: HTMLButtonElement | undefined): void {
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
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }

  function render(): void {
    const scrollTop = scroller.scrollTop;
    const scrollLeft = scroller.scrollLeft;
    const previousCenter = stableHalfWidth;
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
    const inactiveEdges = document.createElementNS(SVG_NS, "g");
    const activeEdges = document.createElementNS(SVG_NS, "g");
    // SVG paints in document order: the active spine must cover the shared
    // gray segment, regardless of sibling order.
    edges.append(inactiveEdges, activeEdges);
    const content = document.createDocumentFragment();
    content.append(edges);
    const tocs = new Map<number, HTMLUListElement>();
    for (const entry of entries) {
      const button = document.createElement("button");
      button.type = "button";
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
      glyph.append(
        icon(entry.image && !userAttachments ? imageIcon : ICONS[entry.role]),
      );
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
      if (entry.hiddenCount) {
        const count = document.createElement("span");
        count.className = "conversation-tree-count";
        count.textContent = `${entry.hiddenCount} more ${entry.hiddenCount === 1 ? "message" : "messages"}`;
        text.append(count);
      }
      button.append(glyph, text);
      buttons.set(entry.id, button);
      content.append(button);
      const sections = headings.get(entry.id) ?? [];
      if (sections.length) {
        const toc = document.createElement("ul");
        toc.className = "conversation-tree-toc";
        toc.setAttribute("aria-label", `Sections in ${entry.label}`);
        tocs.set(entry.id, toc);
        for (const section of sections) {
          const item = document.createElement("li");
          const heading = document.createElement("button");
          heading.type = "button";
          heading.className = "conversation-tree-heading";
          heading.dataset.messageId = String(entry.id);
          heading.dataset.headingIndex = String(section.index);
          heading.dataset.level = String(section.level);
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
      const previousCenter = stableHalfWidth;
      const previousScrollLeft = scroller.scrollLeft;
      const availableWidth = Math.max(0, scroller.clientWidth - 24);
      // Keep extents stable for branch switches, but refit on real resizes.
      if (layoutWidth !== availableWidth) stableHalfWidth = 0;
      layoutWidth = availableWidth;
      const bands = new Map<number, { center: number; width: number }>([
        [0, { center: 0, width: availableWidth }],
      ]);
      for (const siblings of displayRows) {
        siblings.forEach((entry, index) => {
          const parent = bands.get(entry.parentId) ?? {
            center: 0,
            width: availableWidth,
          };
          // Split the parent band evenly around its spine. A single child
          // inherits that band's center, so a fork never snaps back to root.
          const width = Math.max(
            MIN_BAND_WIDTH,
            parent.width / siblings.length,
          );
          bands.set(entry.id, {
            center: parent.center + (index - (siblings.length - 1) / 2) * width,
            width,
          });
        });
      }
      stableHalfWidth = Math.max(stableHalfWidth, availableWidth / 2);
      for (const band of bands.values()) {
        stableHalfWidth = Math.max(
          stableHalfWidth,
          Math.abs(band.center) + band.width / 2,
        );
      }
      const canvasWidth = stableHalfWidth * 2;
      const centerX = stableHalfWidth;
      canvas.style.width = `${canvasWidth}px`;
      const positions = new Map<number, { x: number; y: number }>();
      for (const entry of entries) {
        const band = bands.get(entry.id);
        if (!band) continue;
        const x = centerX + band.center;
        const width = band.width / 2 + 18;
        const left = entry.role === "user" ? x + 26 - width : x - 26;
        positions.set(entry.id, { x, y: 0 });
        const button = buttons.get(entry.id);
        if (button) {
          button.style.left = `${left}px`;
          button.style.width = `${width}px`;
        }
        const toc = tocs.get(entry.id);
        if (toc) {
          toc.style.left = `${x - 6}px`;
          toc.style.width = `${width - 20}px`;
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
      for (const entry of entries) {
        const position = positions.get(entry.id);
        if (!position) continue;
        const { x, y } = position;
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
      scroller.scrollLeft =
        previousScrollLeft + stableHalfWidth - previousCenter;
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
    scroller.scrollTop = scrollTop;
    scroller.scrollLeft = scrollLeft + stableHalfWidth - previousCenter;
  }

  function open(): void {
    window.clearTimeout(closeTimer);
    if (!panel.hidden) return;
    stableHalfWidth = 0;
    stableCanvasHeight = 0;
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    if (dirty) render();
    else {
      placePanel();
      refreshLoaded();
    }
    updateCurrent(true);
  }

  function close(restoreFocus = false): void {
    window.clearTimeout(closeTimer);
    pinned = false;
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
    "mousedown",
    (event) => {
      if (event.button !== 0) return;
      const button =
        event.target instanceof Element
          ? event.target.closest<HTMLButtonElement>("[data-message-id]")
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
          ? event.target.closest<HTMLButtonElement>("[data-message-id]")
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
