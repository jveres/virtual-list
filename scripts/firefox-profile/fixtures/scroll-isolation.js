// Same loaded default chat and native-input band in all three modes.
// The profiler waits its normal warmup after this synchronous setup expression.
(() => {
  const api = globalThis.__scrollIsolation;
  const viewport = document.querySelector("#viewport");
  const mode =
    new URL(location.href).searchParams.get("isolation-mode") ?? "normal";
  if (!api || !viewport || !["normal", "retained", "paused"].includes(mode))
    throw new Error("Open the streaming demo with ?scroll-isolation");
  const height = viewport.clientHeight;
  const maximum = viewport.scrollHeight - height;
  const top = Math.floor((maximum - 2880) / 2);
  if (top < height * 2) throw new Error("Not enough loaded interior content");
  viewport.scrollTop = top;
  let failure;
  setTimeout(() => {
    api.setMode(mode).catch((error) => {
      failure = String(error);
    });
  }, 600);
  let initial;
  globalThis.__runtimeAudit = {
    start() {
      initial = api.snapshot();
      if (failure || initial.mode !== mode || initial.preparing)
        throw new Error(failure ?? "Scroll isolation was not ready");
    },
    stop() {
      const final = api.snapshot();
      if (final.mode !== mode || final.preparing)
        throw new Error("Scroll isolation left the comparison mode");
      if (mode === "paused" && final.blockedScrolls === 0)
        throw new Error("No list scroll handlers were bypassed");
      return { initial, final, expectedTravelEachWay: 2880 };
    },
  };
  return {
    workload: "default simulated chat, fixed interior band",
    mode,
    top,
    height,
    maximum,
  };
})();
