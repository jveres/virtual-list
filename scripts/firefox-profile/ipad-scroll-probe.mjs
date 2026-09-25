/** Serialized into the inspected page. Keep this function self-contained. */
export function installIpadScrollProbe(id) {
  const vp = document.getElementById("viewport");
  const top = document.getElementById("scroll-top-btn");
  const bottom = document.getElementById("scroll-bottom-btn");
  if (
    !vp ||
    !top ||
    !bottom ||
    !/^\/demos\/streaming\/(?:index\.html)?$/.test(location.pathname)
  )
    throw new Error("Not the streaming demo");
  if (window.__pencilTrace)
    throw new Error("A device trace is already installed");
  // Do not silently bypass another tool's accessor or discard its writes.
  if (Object.hasOwn(vp, "scrollTop"))
    throw new Error("scrollTop is already instrumented");
  const accessor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollTop",
  );
  if (!accessor?.get || !accessor.set)
    throw new Error("Missing scrollTop accessor");
  const metadata = {
    path: location.pathname,
    size: [innerWidth, innerHeight, devicePixelRatio],
    top: vp.scrollTop,
    touchAction: getComputedStyle(top).touchAction,
    browser: navigator.userAgent,
    anchoring: vp.firstElementChild?.dataset.anchoring ?? null,
  };
  const records = [];
  const start = performance.now();
  const cleanups = [];
  let dropped = 0;
  let disposed = false;
  let lease;
  const record = (type, ...values) => {
    if (disposed) return;
    if (records.length >= 20000) {
      dropped++;
      return;
    }
    records.push([performance.now() - start, type, ...values]);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(lease);
    const errors = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (window.__pencilTrace?.id === id) delete window.__pencilTrace;
    if (errors.length) throw new AggregateError(errors, "Probe cleanup failed");
  };
  const renew = () => {
    clearTimeout(lease);
    // A lost USB bridge or terminated runner must not leave hooks installed.
    lease = setTimeout(dispose, 30000);
  };
  const listen = (target, type, listener) => {
    if (!target) return;
    target.addEventListener(type, listener, { capture: true, passive: true });
    cleanups.push(() => target.removeEventListener(type, listener, true));
  };
  try {
    const input = (e) =>
      record(
        e.type,
        e.target instanceof Element && e.target.closest("#scroll-top-btn")
          ? "top"
          : e.target instanceof Element &&
              e.target.closest("#scroll-bottom-btn")
            ? "bottom"
            : e.target instanceof Node && vp.contains(e.target)
              ? "viewport"
              : "outside",
        e.pointerType ?? null,
        e.pointerId ?? null,
        e.detail ?? null,
        e.isTrusted,
      );
    for (const type of [
      "pointerdown",
      "pointerup",
      "pointercancel",
      "click",
      "dblclick",
      "touchstart",
      "touchend",
      "touchcancel",
    ])
      listen(document, type, input);
    listen(vp, "scroll", () => record("scroll", vp.scrollTop));
    listen(vp, "scrollend", () => record("scrollend", vp.scrollTop));
    const status = document.getElementById("window-status");
    let previousStatus;
    const paging = () => {
      const value = status?.textContent;
      if (!value || value === previousStatus) return;
      previousStatus = value;
      record("paging", value, vp.scrollTop, vp.scrollHeight, vp.clientHeight);
    };
    if (status) {
      const observer = new MutationObserver(paging);
      cleanups.push(() => observer.disconnect());
      observer.observe(status, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      paging();
    }
    const get = () => accessor.get.call(vp);
    const set = (value) => {
      record("write", value);
      accessor.set.call(vp, value);
    };
    Object.defineProperty(vp, "scrollTop", { configurable: true, get, set });
    cleanups.push(() => {
      const current = Object.getOwnPropertyDescriptor(vp, "scrollTop");
      if (current?.get === get && current.set === set)
        Reflect.deleteProperty(vp, "scrollTop");
    });
    const observer = new MutationObserver((entries) => {
      for (const e of entries)
        record(
          "overflow",
          e.oldValue?.match(/(?:^|;)\s*overflow-y:\s*([^;]+)/)?.[1] ?? "",
          vp.style.overflowY,
        );
    });
    cleanups.push(() => observer.disconnect());
    observer.observe(vp, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["style"],
    });
    const resized = () =>
      record(
        "viewport",
        innerWidth,
        innerHeight,
        window.visualViewport?.scale ?? 1,
      );
    listen(window.visualViewport, "resize", resized);
    listen(window, "pagehide", dispose);
    resized();
    window.__pencilTrace = {
      id,
      record,
      dispose,
      snapshot: () => {
        renew();
        return {
          ...metadata,
          current: {
            top: vp.scrollTop,
            height: vp.scrollHeight,
            viewport: vp.clientHeight,
          },
          records,
          dropped,
        };
      },
    };
    renew();
    return metadata;
  } catch (error) {
    try {
      dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Probe setup and cleanup failed",
      );
    }
    throw error;
  }
}
