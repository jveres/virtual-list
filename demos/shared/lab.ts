// Helpers the two labs share: deterministic content, the trace log (a ring
// for export plus a trimmed DOM view), and the edge pill.

import { setTextIfChanged } from "./utils";

export function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type LogClass = "mark" | "good" | "warn" | "bad";

const LOG_RING_MAX = 4000;
const LOG_DOM_MAX = 350;

interface TraceLog {
  /** The full recent trace, oldest first (what "copy trace" exports). */
  readonly ring: string[];
  log(message: string, cls?: LogClass): void;
  clear(): void;
}

export function createTraceLog(element: HTMLElement): TraceLog {
  const ring: string[] = [];
  const startedAt = performance.now();
  const pending: [string, LogClass | undefined][] = [];
  let frame = 0;
  const flush = (): void => {
    frame = 0;
    const fragment = document.createDocumentFragment();
    for (const [line, cls] of pending.splice(0)) {
      const span = document.createElement("span");
      if (cls) span.className = cls;
      span.textContent = `${line}\n`;
      fragment.appendChild(span);
    }
    element.appendChild(fragment);
    while (element.childNodes.length > LOG_DOM_MAX) {
      element.firstChild?.remove();
    }
    // Follow the log once per frame, not once per native input event.
    element.scrollTop = element.scrollHeight;
  };
  return {
    ring,
    log(message, cls) {
      const line = `+${(performance.now() - startedAt).toFixed(0)}ms ${message}`;
      ring.push(line);
      if (ring.length > LOG_RING_MAX) ring.shift();
      // Export/diagnostic consumers see the trace immediately; only its DOM
      // view is batched. Keep pending work bounded if rendering is suspended.
      pending.push([line, cls]);
      if (pending.length > LOG_DOM_MAX) pending.shift();
      if (!frame) frame = requestAnimationFrame(flush);
    },
    clear() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      pending.length = 0;
      element.replaceChildren();
      ring.length = 0;
    },
  };
}

const PILL_STICKY_MS = 1400;

/** Copy a lab's trace to the clipboard, logging the outcome. */
export function bindCopyTrace(
  button: HTMLElement,
  text: () => string,
  log: (message: string, cls: LogClass) => void,
): void {
  button.addEventListener("click", () => {
    void navigator.clipboard?.writeText(text()).then(
      () => log("trace copied", "good"),
      () => log("clipboard unavailable — select the log manually", "warn"),
    );
  });
}

/**
 * A chunk landed at an edge: hide the loader pill, or, with nothing left to
 * load there, pin the "at the top/bottom" notice.
 */
export function settleEdgePill(
  pill: EdgePill,
  atBottom: boolean,
  chunksLeft: number,
): void {
  if (chunksLeft > 0) pill.hide(true);
  else pill.show(atBottom ? "at the bottom" : "at the top", atBottom, true);
}

interface EdgePill {
  /** Shows the pill at the top or bottom edge; sticky pills fade on their own. */
  show(text: string, atBottom: boolean, sticky?: boolean): void;
  /** Hides the pill; a sticky pill ("at the top/bottom") survives unless forced. */
  hide(force?: boolean): void;
}

export function createEdgePill(
  pill: HTMLElement,
  label: HTMLElement,
): EdgePill {
  let timer = 0;
  let sticky = false;
  return {
    show(text, atBottom, stickyFlag = false) {
      window.clearTimeout(timer);
      sticky = stickyFlag;
      pill.classList.toggle("bottom", atBottom);
      setTextIfChanged(label, text);
      pill.classList.toggle("visible", true);
      if (sticky) {
        timer = window.setTimeout(() => {
          sticky = false;
          pill.classList.toggle("visible", false);
        }, PILL_STICKY_MS);
      }
    },
    hide(force = false) {
      if (sticky && !force) return;
      window.clearTimeout(timer);
      sticky = false;
      pill.classList.toggle("visible", false);
    },
  };
}
