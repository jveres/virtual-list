/**
 * Sticky group/section headers for a VirtualList — a companion, not a runtime
 * feature: the app interleaves header rows into its items, then points this
 * at the same viewport plus the header keys and the list's read queries.
 *
 * A floating header pins the current group to the top. As the next group's
 * header scrolls up, its incoming pill pushes the active pill out of the
 * clipped overlay; when it reaches the top it becomes the pinned header.
 * Both represented in-flow headers are hidden during the handoff, so neither
 * pill is duplicated and a wider old label cannot peek behind the new one.
 *
 * Positions come from `positionOf` — the runtime's committed geometry, which
 * changes only at commits (docs/core-contract.md; under "live" some land
 * mid-gesture), each of which publishes, where the host calls `refresh()`
 * (from onState). Committed header positions stay stable between commits.
 * Headers are identified by stable keys rather than row indexes.
 */

export interface StickyHeadersConfig {
  /** A `position: relative` ancestor of the viewport; the overlay pins to its top. */
  container: HTMLElement;
  /** The scroll viewport (its `scrollTop` is read and its `scroll` observed). */
  viewport: HTMLElement;
  /** Legacy standalone use only. Runtime onState/onViewport wiring needs no listener. */
  observeScroll?: boolean;
  /** Keys of the header rows, in list order. */
  headerKeys: () => string[];
  /** Committed top and height of a key — pass `VirtualList.positionOf`. */
  positionOf: (key: string) => { top: number; height: number } | null;
  /** Fill `slot` with the content of header `ordinal` (0-based among headers). */
  renderHeader: (slot: HTMLElement, ordinal: number) => void;
  /**
   * Mounted inline visual for a key (for example, the date pill inside
   * `VirtualList.elementOf`). The companion toggles `vl-sticky-inline-hidden`;
   * style that class to suppress duplicate paint without hiding the row.
   */
  elementOf?: (key: string) => HTMLElement | null;
}

export interface StickyHeaders {
  /** Move against cached geometry using the runtime's current scroll snapshot. */
  update(scrollTop: number): void;
  /** Re-read committed geometry; reuse the host's scroll snapshot when available. */
  refresh(scrollTop?: number): void;
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
    headerKeys,
    positionOf,
    renderHeader,
    elementOf,
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
    s.style.cssText = `position:absolute;top:0;left:0;right:0;z-index:${z};`;
    return s;
  };
  // Separate slots let the incoming header push the active header out.
  const active = makeSlot(0);
  const incoming = makeSlot(1);
  overlay.append(active, incoming);
  container.appendChild(overlay);

  // Geometry is immutable between refreshes, so cache positions as compact
  // arrays instead of allocating query results inside every scroll frame.
  let keys: string[] = [];
  let tops: number[] = [];
  let heights: number[] = [];
  let groupCount = 0;
  let activeGroup = -1;
  let incomingGroup = -1;
  let visible = false;
  let enabled = true;
  let hiddenInline: HTMLElement[] = [];
  let lastScroll: number | undefined;

  const headerTop = (ordinal: number): number => tops[ordinal] ?? 0;
  const headerHeight = (ordinal: number): number => heights[ordinal] ?? 0;

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
    incoming.style.transform = `translateY(${top}px)`;
  };

  const clearIncoming = (): void => {
    if (incomingGroup === -1) return;
    incomingGroup = -1;
    incoming.replaceChildren();
    incoming.style.display = "none";
    incoming.style.transform = "";
  };

  const restoreInline = (): void => {
    for (const element of hiddenInline)
      element.classList.remove("vl-sticky-inline-hidden");
    hiddenInline = [];
  };

  // Hide the pinned group's in-flow header (if mounted) so it doesn't show
  // through the floating pill as it scrolls up behind the overlay.
  // Paint-only styling leaves visibility, opacity and row geometry untouched.
  const hideInlineFor = (ordinal: number, next = -1): void => {
    const activeElement = elementOf?.(keys[ordinal] ?? "") ?? null;
    const incomingElement =
      next >= 0 ? (elementOf?.(keys[next] ?? "") ?? null) : null;
    if (
      activeElement === (hiddenInline[0] ?? null) &&
      incomingElement === (hiddenInline[1] ?? null)
    )
      return;
    const elements = [activeElement, incomingElement].filter(
      (element): element is HTMLElement => element !== null,
    );
    for (const element of hiddenInline) {
      if (!elements.includes(element))
        element.classList.remove("vl-sticky-inline-hidden");
    }
    for (const element of elements)
      element.classList.add("vl-sticky-inline-hidden");
    hiddenInline = elements;
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

    // Keep the incoming pill attached to its in-flow row until it reaches
    // the top. Within the sticky band it pushes the old pill out 1:1 with
    // scrolling; reversing direction follows the same positions.
    const nxt = lo + 1;
    const top =
      nxt < groupCount ? headerTop(nxt) - scroll : Number.POSITIVE_INFINITY;
    if (top > 0 && top < headerHeight(lo)) {
      active.style.transform = `translateY(${top - headerHeight(lo)}px)`;
      // Clip the outgoing pill at the viewport top, but keep the entire
      // incoming pill visible while its in-flow copy is hidden. A fixed
      // one-header clip would make that pill disappear below the top band.
      overlay.style.height = `${Math.max(headerHeight(lo), top + headerHeight(nxt))}px`;
      setIncoming(nxt, top);
      hideInlineFor(lo, nxt);
    } else {
      active.style.transform = "";
      overlay.style.height = `${headerHeight(lo)}px`;
      clearIncoming();
      hideInlineFor(lo);
    }
  };

  const updatePosition = (scrollTop: number, refresh = false): void => {
    // A runtime publication is newer than a queued native scroll sample.
    // In particular, a glide can advance again before that rAF executes.
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    if (!refresh && scrollTop === lastScroll) return;
    lastScroll = scrollTop;
    update(scrollTop);
  };

  const refresh = (scrollTop = viewport.scrollTop): void => {
    const nextKeys = headerKeys();
    const positions = nextKeys.map(positionOf);
    const changed =
      nextKeys.length !== keys.length ||
      nextKeys.some(
        (key, index) =>
          key !== keys[index] ||
          (positions[index]?.top ?? 0) !== tops[index] ||
          (positions[index]?.height ?? 0) !== heights[index],
      );
    if (changed) {
      keys = nextKeys;
      tops = positions.map((position) => position?.top ?? 0);
      heights = positions.map((position) => position?.height ?? 0);
      activeGroup = -1;
      clearIncoming();
    }
    groupCount = keys.length;
    // A mounted-range publication need not change geometry. Still update the
    // position and hidden inline node, but retain the existing header content.
    // A refresh must reconcile replaced inline nodes even at the same offset.
    // The matching onViewport publication that follows can then be a no-op.
    updatePosition(scrollTop, true);
  };

  let frame = 0;
  let pendingScroll = 0;
  const onScroll = (): void => {
    // Don't even schedule a frame while disabled (inline-only mode).
    if (!enabled) return;
    // Capture runs before the list's bubbling listener reconciles its window.
    // Neither the later listeners nor our rAF need a post-write layout read.
    pendingScroll = viewport.scrollTop;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      updatePosition(pendingScroll);
    });
  };

  const setEnabled = (next: boolean): void => {
    if (next === enabled) return;
    enabled = next;
    if (next) updatePosition(viewport.scrollTop, true);
    else hide();
  };

  const destroy = (): void => {
    restoreInline();
    viewport.removeEventListener("scroll", onScroll, true);
    if (frame) cancelAnimationFrame(frame);
    overlay.remove();
  };

  overlay.style.display = "none";
  incoming.style.display = "none";
  if (config.observeScroll) {
    viewport.addEventListener("scroll", onScroll, {
      passive: true,
      capture: true,
    });
  }
  refresh();

  return { update: updatePosition, refresh, setEnabled, destroy };
}
