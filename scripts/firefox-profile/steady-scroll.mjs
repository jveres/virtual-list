// Fixed native gesture plan; no reply, paging, or runtime behavior changes.
export const steadyScrollPlan = Object.freeze({
  history: 20,
  down: 3,
  up: 3,
  ticks: 90,
  delta: 16,
  intervalMs: 16.667,
  settleMs: 700,
  oneWayPx: 4320,
  minimumMounts: 4,
});

// Same interior band, three times the input speed. Both plans keep each
// gesture's release separate from the next gesture and exclude paging.
export const fastSteadyScrollPlan = Object.freeze({
  ...steadyScrollPlan,
  ticks: 30,
  delta: 48,
});

export function scrollPlan(speed = "normal") {
  if (speed === "normal") return steadyScrollPlan;
  if (speed === "fast") return fastSteadyScrollPlan;
  throw new Error("Invalid steady scroll speed");
}

// Serialized into the existing Firefox setup hook before measurement. Geometry
// is read once here, never from the animation-frame sampler.
export function prepareSteadyScroll(plan) {
  const viewport = document.querySelector("#viewport");
  const profile = globalThis.__chatProfile;
  if (!viewport || !profile?.ready())
    throw new Error("Steady scrolling requires the initialized chat profiler");
  const status = document.querySelector("#window-status")?.textContent;
  if (status !== `loaded 1-${plan.history}/${plan.history} · load none`)
    throw new Error("Steady scrolling requires the whole history loaded");
  if (document.querySelector("#send-btn")?.classList.contains("stop-btn"))
    throw new Error("Steady scrolling cannot start during a reply");
  const height = viewport.clientHeight;
  const maximum = viewport.scrollHeight - height;
  const top = (maximum - plan.oneWayPx) / 2;
  if (!(height > 0) || top < height)
    throw new Error("Steady scrolling needs more interior scroll space");
  viewport.scrollTop = top;
  const visibilityChanges = [];
  // This event reports browser skipping without a geometry read. A timing
  // capture without content-visibility:auto generates no such events.
  viewport.addEventListener(
    "contentvisibilityautostatechange",
    (event) => {
      if (typeof event.skipped !== "boolean") return;
      if (visibilityChanges.length >= 1000) return;
      visibilityChanges.push([performance.now(), event.skipped]);
    },
    { capture: true, passive: true },
  );
  const setup = {
    plan,
    top: viewport.scrollTop,
    maximum,
    height,
    status,
    visibilityChanges,
  };
  profile.steady = setup;
  return setup;
}

export function steadyScrollSetup(speed = "normal") {
  return `(${prepareSteadyScroll.toString()})(${JSON.stringify(scrollPlan(speed))})`;
}

export function steadyScrollArguments(setupPath, speed = "normal") {
  const plan = scrollPlan(speed);
  return [
    `--setup=${setupPath}`,
    `--down=${plan.down}`,
    `--up=${plan.up}`,
    `--ticks=${plan.ticks}`,
    `--delta=${plan.delta}`,
    `--interval-ms=${plan.intervalMs}`,
    `--settle-ms=${plan.settleMs}`,
  ];
}

export function analyzeSteadyScroll(recording) {
  const reasons = [];
  const speed = recording.steady?.plan?.delta === 48 ? "fast" : "normal";
  const plan = scrollPlan(speed);
  if (
    !recording.steady?.plan ||
    Object.keys(plan).some((key) => recording.steady.plan[key] !== plan[key])
  )
    reasons.push("Steady scroll must use a supported native input plan");
  const status = `loaded 1-${steadyScrollPlan.history}/${steadyScrollPlan.history} · load none`;
  const states = [
    recording.initial.state,
    ...recording.states.map((entry) => entry[1]),
    recording.final.state,
  ];
  const count = states[0]?.count;
  const totalSize = states[0]?.totalSize;
  if (
    !Number.isFinite(totalSize) ||
    states.some((state) => state?.totalSize !== totalSize) ||
    recording.frames.some((frame) => frame[7] !== totalSize) ||
    recording.final.height !== recording.initial.height ||
    recording.final.scrollHeight !== recording.initial.scrollHeight
  )
    reasons.push(
      "Steady scroll geometry changed during the loaded-history run",
    );
  if (
    recording.workload.history !== steadyScrollPlan.history ||
    recording.initial.status !== status ||
    recording.final.status !== status ||
    !Number.isInteger(count) ||
    count < steadyScrollPlan.history ||
    states.some(
      (state) =>
        !state ||
        state.count !== count ||
        state.loadedStart !== 0 ||
        state.loadedEnd !== steadyScrollPlan.history ||
        state.loading !== false ||
        state.latestLoaded !== true ||
        state.navigationPending !== false,
    )
  )
    reasons.push("Steady scroll history changed or paging was active");
  if (
    states.some((state) => state?.held) ||
    recording.frames.some((frame) => frame[8])
  )
    reasons.push("Steady scroll contained held paging states");
  if (
    recording.steady?.responseRequests !== 0 ||
    recording.deliveries.length !== 0 ||
    recording.stream.done ||
    recording.stream.characters !== 0 ||
    recording.stream.chunks !== 0 ||
    recording.stream.events !== 0
  )
    reasons.push("Steady scroll must not send or stream a reply");
  const bursts = plan.down + plan.up;
  const minimumWheels = Math.ceil(bursts * plan.ticks * 0.75);
  if (
    !Number.isInteger(recording.scroll.wheels) ||
    recording.scroll.wheels < minimumWheels ||
    !Number.isInteger(recording.scroll.ends) ||
    recording.scroll.ends < bursts
  )
    reasons.push(
      `Steady scroll needs at least ${minimumWheels} wheel events and ${bursts} scroll-end events`,
    );
  const rangeChanges = states.filter(
    (state, index) =>
      index > 0 &&
      state &&
      (state.start !== states[index - 1]?.start ||
        state.end !== states[index - 1]?.end),
  ).length;
  let downPx = 0;
  let upPx = 0;
  for (let index = 1; index < recording.frames.length; index++) {
    const delta = recording.frames[index][1] - recording.frames[index - 1][1];
    if (delta > 0) downPx += delta;
    else upPx -= delta;
  }
  const minimumTravel = steadyScrollPlan.oneWayPx * 0.75;
  if (downPx < minimumTravel || upPx < minimumTravel || rangeChanges < 4)
    reasons.push(
      "Steady scroll needs bidirectional movement and mounted-range churn",
    );
  const maximum = recording.initial.scrollHeight - recording.initial.height;
  const margin = recording.initial.height;
  if (
    !recording.steady ||
    recording.initial.top < margin ||
    maximum - recording.initial.top < steadyScrollPlan.oneWayPx + margin ||
    recording.frames.some(
      (frame) => frame[1] < margin / 2 || frame[1] > maximum - margin / 2,
    )
  )
    reasons.push("Steady scroll left the required interior range");
  const calls = (name) =>
    recording.operations
      .filter((operation) => operation.name === `src/virtual-list.ts:${name}`)
      .reduce((sum, operation) => sum + operation.count, 0);
  const mounts = recording.mode === "diagnostic" ? calls("mountRow") : null;
  const unmounts = recording.mode === "diagnostic" ? calls("unmountRow") : null;
  if (
    recording.mode === "diagnostic" &&
    (mounts < steadyScrollPlan.minimumMounts ||
      unmounts < steadyScrollPlan.minimumMounts)
  )
    reasons.push("Steady scroll needs at least four mounts and four unmounts");
  let imageBoundaries;
  if (recording.workload.historyContent === "images") {
    const size = recording.workload.historyImageSize;
    imageBoundaries = [recording.initial, recording.final].map((boundary) => ({
      mounted: boundary.images?.length ?? 0,
      // Preserve the saved field name; these DOM properties report readiness,
      // not img.decode() completion, GPU readiness, or physical presentation.
      decoded: (boundary.images ?? []).filter(
        (image) =>
          image.complete &&
          image.width === size?.width &&
          image.height === size?.height &&
          image.width > 0 &&
          image.height > 0,
      ).length,
    }));
    if (
      imageBoundaries.some(
        (boundary) =>
          boundary.mounted === 0 || boundary.decoded !== boundary.mounted,
      )
    )
      reasons.push(
        "Steady image history needs decoded mounted images at both boundaries",
      );
  }
  const { visibilityChanges = [], ...setup } = recording.steady ?? {};
  if (visibilityChanges.length >= 1000)
    reasons.push("Steady browser-skipping telemetry reached its event limit");
  const measuredVisibility = visibilityChanges.filter(
    ([time]) =>
      time >= recording.startTime &&
      time <= recording.startTime + recording.durationMs,
  );
  const visibilityAvailable = Array.isArray(
    recording.steady?.visibilityChanges,
  );
  return {
    ...setup,
    browserSkipping: {
      available: visibilityAvailable,
      skipped: visibilityAvailable
        ? measuredVisibility.filter(([, skipped]) => skipped).length
        : null,
      rendered: visibilityAvailable
        ? measuredVisibility.filter(([, skipped]) => !skipped).length
        : null,
      eventLimitReached: visibilityAvailable
        ? visibilityChanges.length >= 1000
        : null,
    },
    rangeChanges,
    downPx,
    upPx,
    mounts,
    unmounts,
    ...(imageBoundaries
      ? {
          imageBoundaries,
          imageReadinessLimit:
            "The decoded count checks complete and natural dimensions only; img.decode() completion, GPU readiness, and physical presentation are not measured.",
        }
      : {}),
    reasons,
  };
}
