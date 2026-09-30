import assert from "node:assert/strict";
import type { Plugin } from "vite";

type Mode =
  | "normal"
  | "retained"
  | "paused"
  | "scroll-off"
  | "input-off"
  | "disabled";
type Band = { top: number; bottom: number; height: number; rows: number };
type Host = {
  viewport: HTMLElement;
  ready(): boolean;
  prepare(): void;
  band(): Band;
  resume(): void;
};

/** Serialized into opt-in development pages; no per-frame work or recording. */
export function installScrollIsolation(): void {
  let host: Host | undefined;
  let mode: Mode = "normal";
  let band: Band | undefined;
  let preparing = false;
  let generation = 0;
  let blockedScrolls = 0;
  let lastReason = "Ready";
  let panel: HTMLElement;
  let status: HTMLElement;
  const buttons = new Map<Mode, HTMLButtonElement>();
  const mutation = new MutationObserver(() => restore("Content changed"));
  const inputEvents = new Set([
    "scroll",
    "scrollend",
    "wheel",
    "touchstart",
    "touchmove",
    "touchend",
    "touchcancel",
    "pointerdown",
    "pointerup",
    "pointercancel",
    "keydown",
    "pointermove",
    "pointerover",
  ]);
  const scrollEvents = new Set(["scroll", "scrollend"]);
  function listenerEnabled(type: string): boolean {
    if (mode === "disabled") return false;
    if (mode === "scroll-off") return !scrollEvents.has(type);
    if (mode === "input-off") return scrollEvents.has(type);
    return true;
  }
  type Listener = {
    target: EventTarget;
    type: string;
    callback: EventListenerOrEventListenerObject;
    installed: EventListenerOrEventListenerObject;
    options: boolean | AddEventListenerOptions | undefined;
    capture: boolean;
    attached: boolean;
    signal?: AbortSignal;
    abort?: EventListener;
  };
  const listeners = new Set<Listener>();
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const captureOf = (options?: boolean | EventListenerOptions): boolean =>
    typeof options === "boolean" ? options : options?.capture === true;
  const tracked = (target: EventTarget, type: string): boolean =>
    inputEvents.has(type) &&
    (target === window ||
      target === document ||
      (target instanceof HTMLElement && target.id === "viewport"));
  function forget(listener: Listener): void {
    listeners.delete(listener);
    if (listener.signal && listener.abort)
      remove.call(listener.signal, "abort", listener.abort);
  }
  // Keep original callbacks for ordinary listeners: no dispatch wrappers.
  // Tracking is restricted to the three long-lived scroll/input targets.
  // Retired message elements and their closures cannot enter this registry.
  EventTarget.prototype.addEventListener = function (type, callback, options) {
    if (!callback || !tracked(this, type)) {
      add.call(this, type, callback, options);
      return;
    }
    const capture = captureOf(options);
    if (
      [...listeners].some(
        (entry) =>
          entry.target === this &&
          entry.type === type &&
          entry.callback === callback &&
          entry.capture === capture,
      )
    )
      return;
    const settings = typeof options === "object" ? { ...options } : options;
    const signal = typeof settings === "object" ? settings.signal : undefined;
    if (signal?.aborted) return;
    const entry: Listener = {
      target: this,
      type,
      callback,
      installed: callback,
      options: settings,
      capture,
      attached: false,
      signal,
    };
    if (typeof settings === "object" && settings.once) {
      entry.installed = function (event) {
        forget(entry);
        if (typeof callback === "function") callback.call(this, event);
        else callback.handleEvent(event);
      };
    }
    if (signal) {
      entry.abort = () => forget(entry);
      add.call(signal, "abort", entry.abort, { once: true });
    }
    listeners.add(entry);
    if (listenerEnabled(type)) {
      add.call(this, type, entry.installed, settings);
      entry.attached = true;
    }
  };
  EventTarget.prototype.removeEventListener = function (
    type,
    callback,
    options,
  ) {
    if (!tracked(this, type)) {
      remove.call(this, type, callback, options);
      return;
    }
    const capture = captureOf(options);
    const entry = [...listeners].find(
      (value) =>
        value.target === this &&
        value.type === type &&
        value.callback === callback &&
        value.capture === capture,
    );
    if (entry) {
      remove.call(this, type, entry.installed, capture);
      forget(entry);
    } else remove.call(this, type, callback, options);
  };
  function syncListeners(): void {
    for (const entry of listeners) {
      const enabled = listenerEnabled(entry.type);
      if (entry.attached === enabled) continue;
      if (enabled)
        add.call(entry.target, entry.type, entry.installed, entry.options);
      else
        remove.call(entry.target, entry.type, entry.installed, entry.capture);
      entry.attached = enabled;
    }
  }
  function modeNote(): string {
    return mode === "disabled" || mode === "scroll-off"
      ? "No boundary recovery: stay in this region; use Normal to restore"
      : "Compare within this region; leaving it restores normal";
  }

  function show(): void {
    if (!status) return;
    status.textContent = preparing
      ? "Preparing a bounded region…"
      : `${mode === "normal" ? "Normal recycling" : mode === "retained" ? "Rows retained; handlers active" : mode === "disabled" ? "All scroll/input listeners removed" : mode === "scroll-off" ? "Only scroll/scrollend listeners removed" : mode === "input-off" ? "Only wheel/touch/pointer/key listeners removed" : "Rows retained; scroll handlers paused"}. ${lastReason}${band ? ` · ${band.rows} rows · ${Math.round((band.bottom - band.top) / band.height)} screens` : ""}`;
    for (const [value, button] of buttons) {
      button.setAttribute("aria-pressed", String(mode === value));
      button.disabled = preparing || !host;
    }
  }

  function restore(reason: string, reconcile = true): void {
    generation++;
    const changed = preparing || mode !== "normal";
    preparing = false;
    mode = "normal";
    syncListeners();
    band = undefined;
    mutation.disconnect();
    lastReason = reason;
    // Remove the guard before reconciling. Host callbacks may replace the list.
    if (changed && reconcile) host?.resume();
    show();
  }

  async function setMode(next: Mode): Promise<void> {
    if (
      ![
        "normal",
        "retained",
        "paused",
        "scroll-off",
        "input-off",
        "disabled",
      ].includes(next)
    )
      throw new Error("Unknown scroll isolation mode");
    if (next === "normal") {
      restore("Restored");
      return;
    }
    const current = host;
    if (!current || preparing || !current.ready())
      throw new Error("Wait for scrolling, loading, and streaming to finish");
    if (mode !== "normal") {
      if (
        band &&
        next !== "disabled" &&
        (current.viewport.scrollTop < band.top + 160 ||
          current.viewport.scrollTop + band.height > band.bottom - 160)
      ) {
        restore("Left the prepared region");
        return setMode(next);
      }
      mode = next;
      syncListeners();
      lastReason = modeNote();
      show();
      // The next native scroll updates the retained region. A synthetic scroll
      // has no matching native scrollend and can leave the runtime busy.
      return;
    }
    const token = ++generation;
    preparing = true;
    show();
    try {
      current.prepare();
      // New mounts and image resources settle outside the comparison.
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (token !== generation || current !== host) return;
      if (!current.ready())
        throw new Error(
          "Content is still changing; try again after it settles",
        );
      for (const image of current.viewport.querySelectorAll("img")) {
        if (image.closest('[aria-hidden="true"]')) continue;
        if (!image.complete)
          throw new Error("Wait for the retained images to finish loading");
      }
      band = current.band();
      if (band.bottom - band.top < band.height * 2)
        throw new Error(
          "Scroll to a longer section before preparing the region",
        );
      blockedScrolls = 0;
      preparing = false;
      mode = next;
      syncListeners();
      lastReason = modeNote();
      mutation.observe(current.viewport, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      show();
    } catch (error) {
      if (token === generation) restore(String(error));
      throw error;
    }
  }

  function guard(event: Event): void {
    const viewport = host?.viewport;
    if (!viewport || (mode === "normal" && !preparing)) return;
    if (!(event.target instanceof Node) || !viewport.contains(event.target))
      return;
    if (preparing) {
      // A real gesture during preparation cancels it without consuming input.
      if (event.type !== "scroll" && event.type !== "scrollend")
        restore("Preparation cancelled by input");
      return;
    }
    if (event.type === "scroll" && event.target === viewport && band) {
      const top = viewport.scrollTop;
      const margin = Math.min(160, band.height / 4);
      if (top < band.top + margin || top + band.height > band.bottom - margin) {
        restore("Reached the edge of the prepared region");
        return;
      }
      if (mode === "paused") blockedScrolls++;
    }
    // Window capture observers (including the profiler) still see events.
    // This never calls preventDefault: native input and scrolling continue.
    if (mode === "paused") event.stopPropagation();
  }

  for (const event of [
    "scroll",
    "scrollend",
    "wheel",
    "touchstart",
    "touchmove",
    "touchend",
    "touchcancel",
    "pointerdown",
    "pointerup",
    "pointercancel",
    "keydown",
  ])
    document.addEventListener(event, guard, { capture: true, passive: true });
  document.addEventListener(
    "click",
    (event) => {
      if (
        event.target instanceof Element &&
        !panel?.contains(event.target) &&
        event.target.closest(
          "button, a, input, textarea, summary, [role=button]",
        )
      )
        restore("Interaction restored normal scrolling");
    },
    true,
  );
  window.addEventListener("resize", () => restore("Viewport resized"));

  const api = {
    setMode,
    reapplyStyles: () => {
      const style = document.querySelector<HTMLStyleElement>(
        'style[data-vite-dev-id$="/demos/shared/styles.css"]',
      );
      if (!style) throw new Error("The development stylesheet is not loaded");
      // Match Vite's stylesheet refresh without changing any rule, replacing
      // the page, or restoring the listeners. No work continues afterward.
      const css = style.textContent;
      style.textContent = css;
      lastReason = "Reapplied the same CSS; listener mode unchanged";
      show();
    },
    ready: () => !preparing && !!host?.ready(),
    snapshot: () => ({
      mode,
      preparing,
      band,
      blockedScrolls,
      lastReason,
      listeners: {
        registered: listeners.size,
        attached: [...listeners].filter((entry) => entry.attached).length,
        scroll: [...listeners].filter(
          (entry) => entry.attached && scrollEvents.has(entry.type),
        ).length,
        input: [...listeners].filter(
          (entry) => entry.attached && !scrollEvents.has(entry.type),
        ).length,
      },
    }),
    attach(next: Host): () => void {
      if (next.viewport.id !== "viewport") return () => {};
      restore("List replaced", false);
      host = next;
      show();
      return () => {
        if (host !== next) return;
        restore("List disposed", false);
        host = undefined;
        show();
      };
    },
  };
  Object.assign(globalThis, { __scrollIsolation: api });

  document.addEventListener(
    "DOMContentLoaded",
    () => {
      panel = document.createElement("aside");
      panel.id = "scroll-isolation";
      panel.setAttribute("aria-label", "Scroll isolation experiment");
      panel.style.cssText =
        "position:fixed;z-index:10000;left:12px;top:8px;max-width:calc(100vw - 24px);padding:8px;background:Canvas;color:CanvasText;border:1px solid GrayText;border-radius:6px;font:12px system-ui;";
      for (const [value, label] of [
        ["normal", "Normal"],
        ["retained", "Retain rows"],
        ["paused", "Pause scroll work"],
        ["scroll-off", "Remove scroll events"],
        ["input-off", "Remove input events"],
        ["disabled", "Remove all listeners"],
      ] as const) {
        const button = document.createElement("button");
        button.textContent = label;
        button.dataset.mode = value;
        button.addEventListener("click", () => {
          void setMode(value).catch((error) => {
            lastReason = String(error);
            show();
          });
        });
        buttons.set(value, button);
        panel.append(button);
      }
      const reapply = document.createElement("button");
      reapply.textContent = "Reapply same CSS";
      reapply.dataset.action = "reapply-css";
      reapply.addEventListener("click", () => {
        try {
          api.reapplyStyles();
        } catch (error) {
          lastReason = String(error);
          show();
        }
      });
      panel.append(reapply);
      status = document.createElement("div");
      status.setAttribute("role", "status");
      panel.append(status);
      document.body.append(panel);
      show();
    },
    { once: true },
  );
}

/** Assertions prevent a changed runtime from silently invalidating the control. */
export function instrumentScrollIsolation(source: string): string {
  const replace = (needle: string, replacement: string): void => {
    assert.equal(
      source.split(needle).length,
      2,
      `Isolation hook changed: ${needle}`,
    );
    source = source.replace(needle, replacement);
  };
  replace("  const overscanPx =", "  let overscanPx =");
  replace(
    "  let lastReconcile =",
    "  let isolationHeld = false;\n  let lastReconcile =",
  );
  replace(
    "  function reconcileWindow(vp: GeometryViewport): GeometryWindow {",
    "  function reconcileWindow(vp: GeometryViewport): GeometryWindow {\n    if (isolationHeld) return lastRange;",
  );
  replace(
    "  let cancelRepaint: (() => void) | undefined;",
    `
  const isolationOverscan = overscanPx;
  const detachIsolation = globalThis.__scrollIsolation?.attach({
    viewport,
    ready: () => !disposed && idle() && glide === null && pending === null &&
      dirtyRows.size === 0 && staleRows.size === 0 && windowJobs.size === 0 &&
      remeasurePolicy === undefined &&
      !document.querySelector('#send-btn.stop-btn') &&
      !/loading/.test(document.querySelector('#window-status')?.textContent ?? ''),
    prepare: () => {
      const vp = viewportState();
      const extra = vp.height * 6;
      const range = geometry.window(vp, extra);
      if (declared || range.indices || range.end - range.start > 64)
        throw new Error('Diagnostic region exceeds the 64-row measured-list limit');
      overscanPx = extra;
      lastReconcile = { top: NaN, height: NaN, epoch: -1 };
      pass(() => { reconcileWindow(vp); commitMounted(); });
      isolationHeld = true;
    },
    band: () => {
      const [first, last] = mountedSpan();
      const lastKey = geometry.keyAt(last);
      return {
        top: geometry.offsetOf(geometry.keyAt(first)),
        bottom: geometry.offsetOf(lastKey) + geometry.heightOf(lastKey),
        height: viewport.clientHeight,
        rows: mountedRows.size,
      };
    },
    resume: () => {
      isolationHeld = false;
      overscanPx = isolationOverscan;
      lastReconcile = { top: NaN, height: NaN, epoch: -1 };
      if (!disposed) pass(onScrolled);
    },
  });
  let cancelRepaint: (() => void) | undefined;`,
  );
  replace(
    "    disposed = true;",
    "    disposed = true;\n    detachIsolation?.();",
  );
  return source;
}

/** Development only. Normal pages do not install the diagnostic controller. */
export function scrollIsolationPlugin(): Plugin {
  return {
    name: "scroll-isolation-experiment",
    apply: "serve",
    enforce: "pre",
    transform(source, id) {
      if (!id.endsWith("/src/virtual-list.ts")) return null;
      return { code: instrumentScrollIsolation(source), map: null };
    },
    transformIndexHtml(_html, context) {
      if (
        !new URL(
          context.originalUrl ?? context.path,
          "http://localhost",
        ).searchParams.has("scroll-isolation")
      )
        return;
      return [
        {
          tag: "script",
          children: `(${installScrollIsolation.toString()})();`,
          injectTo: "head-prepend",
        },
      ];
    },
  };
}
