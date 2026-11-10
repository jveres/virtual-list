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
 * changes only at commits (docs/core-contract.md; some land mid-gesture:
 * rows below the anchor, or native anchoring), each of which publishes,
 * where the host calls `refresh()` (from onState). Committed header
 * positions stay stable between commits. Headers are identified by stable
 * keys rather than row indexes.
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
  let ordinals: number[] = [];
  let groupCount = 0;
  let activeGroup = -1;
  let incomingGroup = -1;
  let visible = false;
  let enabled = true;
  let disposed = false;
  let hiddenActive: HTMLElement | null = null;
  let hiddenIncoming: HTMLElement | null = null;
  let lastScroll: number | undefined;

  const headerTop = (ordinal: number): number => tops[ordinal] ?? 0;
  const headerHeight = (ordinal: number): number => heights[ordinal] ?? 0;

  const fillSlot = (slot: HTMLElement, ordinal: number): void => {
    renderHeader(slot, ordinals[ordinal] ?? ordinal);
    slot.style.height = `${headerHeight(ordinal)}px`;
  };

  const setActive = (ordinal: number): void => {
    if (ordinal === activeGroup) return;
    fillSlot(active, ordinal);
    if (disposed || !enabled) return;
    activeGroup = ordinal;
    overlay.style.height = `${headerHeight(ordinal)}px`;
    active.style.transform = "";
  };

  const setIncoming = (ordinal: number, top: number): void => {
    if (ordinal !== incomingGroup) {
      fillSlot(incoming, ordinal);
      if (disposed || !enabled) return;
      incomingGroup = ordinal;
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
    if (hiddenActive) {
      hiddenActive.classList.remove("vl-sticky-inline-hidden");
      hiddenActive = null;
    }
    if (hiddenIncoming) {
      hiddenIncoming.classList.remove("vl-sticky-inline-hidden");
      hiddenIncoming = null;
    }
  };

  // Hide the pinned group's in-flow header (if mounted) so it doesn't show
  // through the floating pill as it scrolls up behind the overlay.
  // Paint-only styling leaves visibility, opacity and row geometry untouched.
  const hideInlineFor = (ordinal: number, next = -1): void => {
    const activeElement = elementOf?.(keys[ordinal] ?? "") ?? null;
    const incomingElement =
      next >= 0 ? (elementOf?.(keys[next] ?? "") ?? null) : null;
    if (disposed || !enabled) return;
    if (activeElement === hiddenActive && incomingElement === hiddenIncoming)
      return;
    if (
      hiddenActive &&
      hiddenActive !== activeElement &&
      hiddenActive !== incomingElement
    )
      hiddenActive.classList.remove("vl-sticky-inline-hidden");
    if (
      hiddenIncoming &&
      hiddenIncoming !== activeElement &&
      hiddenIncoming !== incomingElement
    )
      hiddenIncoming.classList.remove("vl-sticky-inline-hidden");
    if (activeElement) activeElement.classList.add("vl-sticky-inline-hidden");
    if (incomingElement)
      incomingElement.classList.add("vl-sticky-inline-hidden");
    hiddenActive = activeElement;
    hiddenIncoming = incomingElement;
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
    if (disposed || !enabled) return;
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
    if (disposed || !enabled) return;

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
      if (disposed || !enabled) return;
      hideInlineFor(lo, nxt);
    } else {
      active.style.transform = "";
      overlay.style.height = `${headerHeight(lo)}px`;
      clearIncoming();
      hideInlineFor(lo);
    }
  };

  const updatePosition = (scrollTop: number, refresh = false): void => {
    if (disposed) return;
    // A runtime publication is newer than a queued native scroll sample.
    // In particular, a glide can advance again before that rAF executes.
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    if (!refresh && scrollTop === lastScroll) return;
    try {
      update(scrollTop);
      lastScroll = scrollTop;
    } catch (error) {
      // A renderer can mutate a slot before failing. Expose the real headers
      // and retry from a clean overlay, even when scrolling back to the last
      // successful offset rather than retrying the failed destination.
      lastScroll = undefined;
      hide();
      throw error;
    }
  };

  const refresh = (scrollTop?: number): void => {
    if (disposed) return;
    const scroll = scrollTop ?? viewport.scrollTop;
    // Missing runtime keys have no position. Keep them out of the ordered
    // search while preserving the host's original rendering ordinals. Allocate
    // replacement arrays only once a key, ordinal, or box actually differs.
    const sourceKeys = headerKeys();
    let nextKeys: string[] | null = null;
    let nextTops: number[] | null = null;
    let nextHeights: number[] | null = null;
    let nextOrdinals: number[] | null = null;
    let count = 0;
    for (let ordinal = 0; ordinal < sourceKeys.length; ordinal++) {
      const key = sourceKeys[ordinal] as string;
      const position = positionOf(key);
      if (!position) continue;
      if (
        nextKeys === null &&
        (count >= keys.length ||
          key !== keys[count] ||
          ordinal !== ordinals[count] ||
          position.top !== tops[count] ||
          position.height !== heights[count])
      ) {
        nextKeys = keys.slice(0, count);
        nextTops = tops.slice(0, count);
        nextHeights = heights.slice(0, count);
        nextOrdinals = ordinals.slice(0, count);
      }
      if (nextKeys !== null) {
        nextKeys.push(key);
        (nextTops as number[]).push(position.top);
        (nextHeights as number[]).push(position.height);
        (nextOrdinals as number[]).push(ordinal);
      }
      count += 1;
    }
    if (nextKeys === null && count !== keys.length) {
      nextKeys = keys.slice(0, count);
      nextTops = tops.slice(0, count);
      nextHeights = heights.slice(0, count);
      nextOrdinals = ordinals.slice(0, count);
    }
    if (nextKeys !== null) {
      // Own fresh arrays so the host can reuse and mutate its key array.
      keys = nextKeys;
      tops = nextTops as number[];
      heights = nextHeights as number[];
      ordinals = nextOrdinals as number[];
      activeGroup = -1;
      clearIncoming();
    }
    groupCount = keys.length;
    // A mounted-range publication need not change geometry. Still update the
    // position and hidden inline node, but retain the existing header content.
    // A refresh must reconcile replaced inline nodes even at the same offset.
    // The matching onViewport publication that follows can then be a no-op.
    updatePosition(scroll, true);
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
    if (disposed || next === enabled) return;
    enabled = next;
    if (next) updatePosition(viewport.scrollTop, true);
    else hide();
  };

  const destroy = (): void => {
    if (disposed) return;
    disposed = true;
    restoreInline();
    viewport.removeEventListener("scroll", onScroll, true);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
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
  try {
    refresh();
  } catch (error) {
    destroy();
    throw error;
  }

  return { update: updatePosition, refresh, setEnabled, destroy };
}
