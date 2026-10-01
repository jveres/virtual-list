// Default chat, fresh profile; use profile:firefox with --idle-seconds=16.
// Records requests and completion geometry, never layout in a frame sampler.
(() => {
  const viewport = document.querySelector("#viewport");
  const status = () => document.querySelector("#window-status")?.textContent;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const record = (kind, extra = {}) =>
    window.__ffProfile.bursts.push({
      kind,
      time: performance.now(),
      top: viewport.scrollTop,
      height: viewport.scrollHeight,
      status: status(),
      ...extra,
    });
  const run = async () => {
    while (!window.__ffProfile) await sleep(50);
    const original = viewport.scrollTo;
    viewport.scrollTo = function (options) {
      record("request", {
        behavior: options.behavior,
        destination: options.top,
      });
      return original.call(this, options);
    };
    const onEnd = () => record("end");
    viewport.addEventListener("scrollend", onEnd);
    try {
      for (let step = 0; step < 4; step++) {
        window.__ffProfile.phase = `top-${step}`;
        document.querySelector("#scroll-top-btn").click();
        await sleep(2500);
      }
      window.__ffProfile.phase = "bottom";
      record("bottom-click");
      document.querySelector("#scroll-bottom-btn").click();
      await sleep(4000);
      record("bottom-finished");
    } finally {
      viewport.scrollTo = original;
      viewport.removeEventListener("scrollend", onEnd);
    }
  };
  void run();
  return {
    workload: "default chat, four top clicks then bottom",
    status: status(),
  };
})();
