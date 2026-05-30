/**
 * Sticky group/section headers for a VirtualList.
 *
 * A companion to the core virtualizer (it stays unaware of grouping): the app
 * interleaves header rows into the item index space, then points this at the
 * same viewport plus the header layout-indices and the list's `getItemOffset`.
 *
 * A floating header pins the current group to the top. As the next group's
 * in-flow header scrolls up, its pill rises on top of the pinned one (an
 * `incoming` slot stacked above the `active` slot), covering it; when it reaches
 * the top it becomes the pinned header. The pinned group's own in-flow header is
 * hidden meanwhile so it never shows twice.
 *
 * Offsets are read live from `getItemOffset` (O(log g · log n) per tick) so the
 * overlay always tracks the virtualizer's measured row positions exactly.
 */

export interface StickyHeadersConfig {
  /** A `position: relative` ancestor of the viewport; the overlay pins to its top. */
  container: HTMLElement;
  /** The scroll viewport (its `scrollTop` is read and its `scroll` observed). */
  viewport: HTMLElement;
  /** Ascending layout indices that are section headers. */
  headerIndices: () => number[];
  /** Content-space top of a layout index — pass `VirtualList.getItemOffset`. */
  itemOffset: (index: number) => number;
  /** Fill `slot` with the content of header `ordinal` (0-based among headers). */
  renderHeader: (slot: HTMLElement, ordinal: number) => void;
  /**
   * Mounted element for a layout index — pass `VirtualList.getMountedElement`.
   * The pinned group's in-flow header is hidden while it's pinned so it doesn't
   * show twice (the floating pill plus its own row scrolling up behind it).
   */
  headerElement?: (index: number) => HTMLElement | null;
}

export interface StickyHeaders {
  /** Re-read the header index set (after items are added/removed). */
  refresh(): void;
  /** Turn the sticky overlay on/off (e.g. an "inline only" mode). */
  setEnabled(enabled: boolean): void;
  /** Remove the overlay and its scroll listener. */
  destroy(): void;
}

export function createStickyHeaders(
  config: StickyHeadersConfig,
): StickyHeaders {
  const {
    container,
    viewport,
    headerIndices,
    itemOffset,
    renderHeader,
    headerElement,
  } = config;

  const overlay = document.createElement("div");
  overlay.className = "vl-sticky-header";
  overlay.setAttribute("role", "presentation");
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.cssText =
    "position:absolute;top:0;left:0;right:0;overflow:hidden;" +
    "pointer-events:none;z-index:5;";

  const makeSlot = (z: number): HTMLElement => {
    const s = document.createElement("div");
    s.className = "sticky-group";
    s.style.cssText = `position:absolute;left:0;right:0;z-index:${z};`;
    return s;
  };
  // `incoming` stacks above `active` so the new header scrolls up over the old.
  const active = makeSlot(0);
  const incoming = makeSlot(1);
  overlay.append(active, incoming);
  container.appendChild(overlay);

  // Header layout indices (cached); offsets/heights are read live from them.
  let indices: number[] = [];
  let groupCount = 0;
  let activeGroup = -1;
  let incomingGroup = -1;
  let visible = false;
  let enabled = true;
  let hiddenInline: HTMLElement | null = null;

  const headerTop = (ordinal: number): number =>
    itemOffset(indices[ordinal] ?? 0);
  const headerHeight = (ordinal: number): number =>
    itemOffset((indices[ordinal] ?? 0) + 1) - headerTop(ordinal);

  const fillSlot = (slot: HTMLElement, ordinal: number): void => {
    renderHeader(slot, ordinal);
    slot.style.height = `${headerHeight(ordinal)}px`;
  };

  const setActive = (ordinal: number): void => {
    if (ordinal === activeGroup) return;
    activeGroup = ordinal;
    fillSlot(active, ordinal);
    overlay.style.height = `${headerHeight(ordinal)}px`;
    active.style.transform = "";
  };

  const setIncoming = (ordinal: number, top: number): void => {
    if (ordinal !== incomingGroup) {
      incomingGroup = ordinal;
      fillSlot(incoming, ordinal);
      incoming.style.display = "";
    }
    incoming.style.transform = `translateY(${Math.round(top)}px)`;
  };

  const clearIncoming = (): void => {
    if (incomingGroup === -1) return;
    incomingGroup = -1;
    incoming.replaceChildren();
    incoming.style.display = "none";
    incoming.style.transform = "";
  };

  const restoreInline = (): void => {
    if (hiddenInline) {
      hiddenInline.style.visibility = "";
      hiddenInline = null;
    }
  };

  // Hide the pinned group's in-flow header (if mounted) so it doesn't show
  // through the floating pill as it scrolls up behind the overlay.
  const hideInlineFor = (ordinal: number): void => {
    const el = headerElement?.(indices[ordinal] ?? -1) ?? null;
    if (el === hiddenInline) return;
    restoreInline();
    if (el) {
      el.style.visibility = "hidden";
      hiddenInline = el;
    }
  };

  const show = (): void => {
    if (visible) return;
    visible = true;
    overlay.style.display = "";
  };

  const hide = (): void => {
    restoreInline();
    clearIncoming();
    if (!visible) return;
    visible = false;
    overlay.style.display = "none";
    active.replaceChildren();
    activeGroup = -1;
  };

  const update = (scroll: number): void => {
    if (!enabled) return;
    if (groupCount === 0 || scroll < headerTop(0)) {
      hide();
      return;
    }

    // Largest group whose header has reached (scrolled up to) the top.
    let lo = 0;
    let hi = groupCount - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (headerTop(mid) <= scroll) lo = mid;
      else hi = mid - 1;
    }

    show();
    setActive(lo);
    hideInlineFor(lo);

    // While the next group's header is within one header-height of the top, ride
    // it up in the incoming slot (on top of the pinned one). The binary search
    // promotes it to `active` the moment it reaches the top.
    const nxt = lo + 1;
    const top =
      nxt < groupCount ? headerTop(nxt) - scroll : Number.POSITIVE_INFINITY;
    if (top > 0 && top < headerHeight(lo)) setIncoming(nxt, top);
    else clearIncoming();
  };

  const refresh = (): void => {
    indices = headerIndices();
    groupCount = indices.length;
    activeGroup = -1;
    clearIncoming();
    update(viewport.scrollTop);
  };

  let frame = 0;
  const onScroll = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      update(viewport.scrollTop);
    });
  };

  const setEnabled = (next: boolean): void => {
    if (next === enabled) return;
    enabled = next;
    if (next) update(viewport.scrollTop);
    else hide();
  };

  const destroy = (): void => {
    restoreInline();
    viewport.removeEventListener("scroll", onScroll);
    if (frame) cancelAnimationFrame(frame);
    overlay.remove();
  };

  overlay.style.display = "none";
  incoming.style.display = "none";
  viewport.addEventListener("scroll", onScroll, { passive: true });
  refresh();

  return { refresh, setEnabled, destroy };
}
