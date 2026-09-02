// Helpers the two labs share: deterministic content, the trace log (a ring
// for export plus a trimmed DOM view), and the edge pill.

export function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type LogClass = "mark" | "good" | "warn" | "bad";

const LOG_RING_MAX = 4000;
const LOG_DOM_MAX = 350;

export interface TraceLog {
  /** The full recent trace, oldest first (what "copy trace" exports). */
  readonly ring: string[];
  log(message: string, cls?: LogClass): void;
  clear(): void;
}

export function createTraceLog(element: HTMLElement): TraceLog {
  const ring: string[] = [];
  const startedAt = performance.now();
  return {
    ring,
    log(message, cls) {
      const line = `+${(performance.now() - startedAt).toFixed(0)}ms ${message}`;
      ring.push(line);
      if (ring.length > LOG_RING_MAX) ring.shift();
      const span = document.createElement("span");
      if (cls) span.className = cls;
      span.textContent = `${line}\n`;
      element.appendChild(span);
      while (element.childNodes.length > LOG_DOM_MAX) {
        element.firstChild?.remove();
      }
      element.scrollTop = element.scrollHeight;
    },
    clear() {
      element.replaceChildren();
      ring.length = 0;
    },
  };
}

const PILL_STICKY_MS = 1400;

export interface EdgePill {
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
      label.textContent = text;
      pill.classList.add("visible");
      if (sticky) {
        timer = window.setTimeout(() => {
          sticky = false;
          pill.classList.remove("visible");
        }, PILL_STICKY_MS);
      }
    },
    hide(force = false) {
      if (sticky && !force) return;
      window.clearTimeout(timer);
      sticky = false;
      pill.classList.remove("visible");
    },
  };
}
