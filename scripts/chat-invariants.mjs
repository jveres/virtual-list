// Product-level invariants of the streaming chat, checked in a real engine:
// what a user would call "it moved". The unit suite drives the runtime
// against a harness and the lab counts contract violations from outside
// the runtime; this drives the chat itself — its data shapes (an undated
// simulated transcript, a dated imported one whose single day spans every
// page), its loader slot, its day headers — and measures the screen.
//
// Invariant A (scrollback): across a load of older messages, the row under
// a fixed viewport point keeps its screen position (within a pixel) and
// the viewport does not stay at the top of grown content.

const VIEWPORT = { width: 1200, height: 820 };
const PROBE_Y = 120;
const LOADS_MAX = 6;

function datedTranscript(turns) {
  const base = new Date(2026, 8, 2, 9, 0, 0).getTime();
  const lines = [
    "# streaming-chat transcript",
    "",
    "<!-- day -->",
    "## Day",
    "",
  ];
  for (let i = 1; i <= turns; i++) {
    lines.push(
      `**${i % 2 ? "User" : "Assistant"}**`,
      `<!-- turn {"sentAt":${base + i * 120_000}} -->`,
      "",
      `Message ${i} ${"lorem ipsum dolor sit amet ".repeat(8 + (i % 5) * 6)}`,
      "",
    );
  }
  return lines.join("\n");
}

async function importTranscript(page, markdown) {
  page.once("dialog", (dialog) => dialog.accept());
  await page.evaluate((md) => {
    const wrap = document.querySelector(".viewport-wrap");
    const dt = new DataTransfer();
    dt.items.add(new File([md], "chat.md", { type: "text/markdown" }));
    for (const type of ["dragenter", "dragover", "drop"]) {
      wrap.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        }),
      );
    }
  }, markdown);
  await page.waitForTimeout(800);
}

async function probe(page) {
  return page.evaluate((y) => {
    const viewport = document.getElementById("viewport");
    const rect = viewport.getBoundingClientRect();
    const element = document.elementFromPoint(rect.left + 200, rect.top + y);
    // The runtime's slot under the point: a message, a day header, or the
    // loader — identified by its text, which is what the user is reading.
    const slot = element?.closest("#viewport > div > div");
    return {
      scrollTop: Math.round(viewport.scrollTop * 10) / 10,
      key: slot ? (slot.textContent ?? "").trim().slice(0, 40) : null,
      top: slot
        ? Math.round((slot.getBoundingClientRect().top - rect.top) * 10) / 10
        : null,
      status: document.getElementById("window-status")?.textContent ?? "",
    };
  }, PROBE_Y);
}

async function flingToTop(page) {
  const box = await page.locator("#viewport").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -1500);
    await page.waitForTimeout(16);
  }
}

/**
 * Samples the row under the probe point from the last wheel event until the
 * load has landed. Once the scroll has come to rest (two equal positions),
 * no input follows: the row under the point may only change by the user's
 * hand, so a later sample showing the same row at another height, or
 * another row at the same scroll position, is a shift.
 */
async function watchLoad(page, label, load) {
  const samples = [];
  const deadline = Date.now() + 2_500;
  while (Date.now() < deadline) {
    samples.push(await probe(page));
    await page.waitForTimeout(30);
    const last = samples[samples.length - 1];
    if (samples.length > 8 && !last.status.includes("loading")) {
      // Landed (or nothing to load): a few more samples catch a late write.
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(30);
        samples.push(await probe(page));
      }
      break;
    }
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  const loaded = first.status.split(" · ")[0] !== last.status.split(" · ")[0];
  let rest = -1;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].scrollTop === samples[i - 1].scrollTop) {
      rest = i - 1;
      break;
    }
  }
  const violations = [];
  if (rest >= 0) {
    const ref = samples[rest];
    for (const sample of samples.slice(rest + 1)) {
      if (ref.key === null || sample.key === null) continue;
      const sameRowMoved =
        sample.key === ref.key && Math.abs(sample.top - ref.top) > 1;
      const rowSwappedInPlace =
        sample.key !== ref.key && sample.scrollTop === ref.scrollTop;
      if (sameRowMoved || rowSwappedInPlace) {
        violations.push(
          `${label} load ${load}: ${JSON.stringify(ref)} → ${JSON.stringify(sample)}`,
        );
        break;
      }
    }
  }
  return { loaded, violations };
}

/** Runs invariant A on the current conversation; returns violation strings. */
async function checkScrollback(page, label) {
  const violations = [];
  for (let load = 1; load <= LOADS_MAX; load++) {
    await flingToTop(page);
    const result = await watchLoad(page, label, load);
    violations.push(...result.violations);
    if (!result.loaded) break; // Nothing older: done.
  }
  return violations;
}

function mulberry32(seedValue) {
  let state = seedValue >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function metrics(page) {
  return page.evaluate(() => {
    const viewport = document.getElementById("viewport");
    const send = document.getElementById("send-btn");
    return {
      scrollTop: viewport.scrollTop,
      gapToEnd:
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      streaming: /stop/i.test(send?.textContent ?? ""),
      status: document.getElementById("window-status")?.textContent ?? "",
    };
  });
}

/** Screen tops of every mounted slot, keyed by its text. */
async function slotTops(page) {
  return page.evaluate(() => {
    const viewport = document.getElementById("viewport");
    const rect = viewport.getBoundingClientRect();
    const out = {};
    for (const slot of viewport.firstElementChild.children) {
      const key = (slot.textContent ?? "").trim().slice(0, 40);
      out[key] =
        Math.round((slot.getBoundingClientRect().top - rect.top) * 10) / 10;
    }
    return out;
  });
}

/** The jump buttons hide at their own edge: click only when shown. */
async function clickIfVisible(page, selector) {
  const element = await page.$(selector);
  if (element && (await element.isVisible())) await element.click();
}

async function send(page, text) {
  await page.fill("#prompt", text);
  await page.click("#send-btn");
}

async function waitStreamEnd(page, timeout = 15_000) {
  await page
    .waitForFunction(
      () =>
        !/stop/i.test(document.getElementById("send-btn")?.textContent ?? ""),
      null,
      { timeout },
    )
    .catch(() => {});
}

/**
 * Invariant B (send): the prompt lands at the viewport top and is never
 * pushed down by the reply streaming under it (the reserve, I5); when the
 * reply ends the viewport is at the end.
 */
async function checkSend(page, label) {
  const violations = [];
  await clickIfVisible(page, "#scroll-bottom-btn");
  await page.waitForTimeout(1_200);
  const prompt = `f ${label} prompt ${Date.now()}`;
  const needle = prompt.slice(0, 24);
  await send(page, prompt);
  // Sample while the reply streams: the prompt glides to the top, then may
  // only ever move up (following) — never down — until it scrolls out.
  let pinnedAt = null;
  let lowest = null;
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(40);
    const tops = await slotTops(page);
    const found = Object.keys(tops).find((k) => k.includes(needle));
    const top = found === undefined ? undefined : tops[found];
    if (top !== undefined) {
      if (pinnedAt === null && top <= 80) pinnedAt = top;
      if (pinnedAt !== null) {
        if (lowest === null || top < lowest) lowest = top;
        if (top > lowest + 1) {
          violations.push(
            `${label} send: prompt pushed down ${lowest} → ${top}`,
          );
          break;
        }
      }
    }
    if (!(await metrics(page)).streaming) break;
  }
  if (pinnedAt === null) {
    violations.push(`${label} send: prompt never reached the top`);
  }
  await waitStreamEnd(page);
  await page.waitForTimeout(900);
  const end = await metrics(page);
  if (Math.abs(end.gapToEnd) > 1) {
    violations.push(
      `${label} send: not at the end after the reply (gap ${end.gapToEnd})`,
    );
  }
  return violations;
}

/**
 * Invariant C (version switch) and D (tool panel): a discrete interaction
 * on a visible message changes nothing above it, and the message itself
 * stays at its top.
 */
async function checkInPlace(page, label, selector, describe) {
  const violations = [];
  await clickIfVisible(page, "#scroll-bottom-btn");
  await page.waitForTimeout(1_200);
  const handles = await page.$$(selector);
  let target = null;
  for (const h of handles) {
    const box = await h.boundingBox();
    if (box && box.y > 120 && box.y < 700) target = h;
  }
  if (!target) return violations; // Nothing of the kind on screen.
  const before = await slotTops(page);
  const targetTop = (await target.boundingBox()).y;
  await target.click();
  await page.waitForTimeout(700);
  const after = await slotTops(page);
  for (const [k, top] of Object.entries(before)) {
    // Rows above the interaction, and the interacted row's own top.
    const vpTop = await page.evaluate(
      () => document.getElementById("viewport").getBoundingClientRect().top,
    );
    if (
      top + vpTop <= targetTop + 1 &&
      after[k] !== undefined &&
      Math.abs(after[k] - top) > 1
    ) {
      violations.push(
        `${label} ${describe}: row "${k}" moved ${top} → ${after[k]}`,
      );
    }
  }
  return violations;
}

/**
 * Invariant E (jump buttons during a stream): scroll-to-top lands at 0 and
 * stays; scroll-to-bottom re-engages following and the stream's end is
 * reached.
 */
async function checkJumps(page, label) {
  const violations = [];
  await clickIfVisible(page, "#scroll-bottom-btn");
  await page.waitForTimeout(1_000);
  await send(page, `f ${label} jumps ${Date.now()}`);
  await page.waitForTimeout(1_800);
  if (!(await metrics(page)).streaming) return violations; // Reply too short to test.
  await clickIfVisible(page, "#scroll-top-btn");
  await page.waitForTimeout(2_500);
  for (let i = 0; i < 10; i++) {
    const m = await metrics(page);
    if (m.scrollTop > 1) {
      violations.push(
        `${label} jump-top: viewport at ${m.scrollTop} ${i * 100}ms after landing`,
      );
      break;
    }
    await page.waitForTimeout(100);
  }
  if ((await metrics(page)).streaming) {
    await clickIfVisible(page, "#scroll-bottom-btn");
    await page.waitForTimeout(2_500);
    let worst = 0;
    while ((await metrics(page)).streaming) {
      const m = await metrics(page);
      worst = Math.max(worst, m.gapToEnd);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(900);
    const end = await metrics(page);
    if (Math.abs(end.gapToEnd) > 1) {
      violations.push(
        `${label} jump-bottom: not following to the end (gap ${end.gapToEnd}, worst lag ${worst})`,
      );
    }
  }
  await waitStreamEnd(page);
  return violations;
}

/** Invariant F: a viewport height change during a load shifts nothing either. */
async function checkResizeDuringLoad(page, label) {
  const violations = [];
  await clickIfVisible(page, "#scroll-bottom-btn");
  await page.waitForTimeout(800);
  await flingToTop(page);
  await page.setViewportSize({
    width: VIEWPORT.width,
    height: VIEWPORT.height - 140,
  });
  const result = await watchLoad(page, `${label} resize`, 1);
  violations.push(...result.violations);
  await page.setViewportSize(VIEWPORT);
  await page.waitForTimeout(400);
  return violations;
}

/**
 * Chaos: random input bursts, sends, version and panel clicks. After every
 * burst the scroll comes to rest; with no stream running, the mounted rows
 * must then hold still for half a second.
 */
async function chaos(page, label, seed, seconds) {
  const random = mulberry32(seed);
  const violations = [];
  const log = [];
  const box = await page.locator("#viewport").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const deadline = Date.now() + seconds * 1_000;
  let step = 0;
  while (Date.now() < deadline && violations.length === 0) {
    step += 1;
    const roll = random();
    if (roll < 0.6) {
      const dir = random() < 0.5 ? -1 : 1;
      const n = 1 + Math.floor(random() * 8);
      const mag = 100 + Math.floor(random() * 1400);
      log.push(`wheel ${dir > 0 ? "down" : "up"} ${n}×${mag}`);
      for (let i = 0; i < n; i++) {
        await page.mouse.wheel(0, dir * mag);
        await page.waitForTimeout(8 + Math.floor(random() * 40));
      }
    } else if (roll < 0.72) {
      log.push("send");
      await send(page, `${random() < 0.5 ? "f " : ""}chaos ${step}`);
    } else if (roll < 0.84) {
      const buttons = await page.$$(".version-nav-btn:not([disabled])");
      const b = buttons[Math.floor(random() * buttons.length)];
      if (b) {
        log.push("version");
        await b.click({ force: true }).catch(() => {});
      }
    } else if (roll < 0.92) {
      const panels = await page.$$(".tool-call-summary");
      const p = panels[Math.floor(random() * panels.length)];
      if (p) {
        log.push("panel");
        await p.click({ force: true }).catch(() => {});
      }
    } else {
      log.push(random() < 0.5 ? "jump-top" : "jump-bottom");
      await clickIfVisible(
        page,
        log[log.length - 1] === "jump-top"
          ? "#scroll-top-btn"
          : "#scroll-bottom-btn",
      );
    }
    // Come to rest — past the settle cooldown, where a command to the end
    // legitimately catches up with growth that outran its glide.
    let previous = -1;
    let still = 0;
    for (let i = 0; i < 80 && still < 10; i++) {
      await page.waitForTimeout(50);
      const m = await metrics(page);
      still = m.scrollTop === previous ? still + 1 : 0;
      previous = m.scrollTop;
    }
    if ((await metrics(page)).streaming) continue;
    const ref = await slotTops(page);
    const refTop = (await metrics(page)).scrollTop;
    await page.waitForTimeout(500);
    const now = await slotTops(page);
    const nowTop = (await metrics(page)).scrollTop;
    if ((await metrics(page)).streaming) continue;
    for (const [k, top] of Object.entries(ref)) {
      if (now[k] !== undefined && Math.abs(now[k] - top) > 1) {
        violations.push(
          `${label} chaos seed ${seed} step ${step}: row "${k}" moved ${top} → ${now[k]} at rest (scrollTop ${refTop} → ${nowTop}); last ops: ${log.slice(-6).join(", ")}`,
        );
        break;
      }
    }
  }
  return violations;
}

/** Where the last prompt sits relative to the viewport top, and where a
 * landed conversation should put it (under the day pill when it is on) —
 * unless its reply outgrows the viewport, when the landing is the end and
 * the prompt sits above the top. */
async function promptLanding(page) {
  return page.evaluate(() => {
    const viewport = document.getElementById("viewport");
    const rect = viewport.getBoundingClientRect();
    const gapToEnd =
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    // Slots are reused, so document order is not visual order: the last
    // prompt is the lowest one on screen.
    let last = null;
    for (const prompt of viewport.querySelectorAll("article.message.user")) {
      if (
        !last ||
        prompt.getBoundingClientRect().top > last.getBoundingClientRect().top
      )
        last = prompt;
    }
    const sticky = document.getElementById("sticky-toggle")?.checked ?? true;
    return {
      top: last ? last.getBoundingClientRect().top - rect.top : null,
      expected: sticky ? 44 : 0,
      gapToEnd,
    };
  });
}

function landingViolation(label, landing) {
  if (landing.top === null) return `${label}: no prompt mounted after landing`;
  const pinned = Math.abs(landing.top - landing.expected) <= 1;
  const atEndWithPromptAbove =
    Math.abs(landing.gapToEnd) <= 1 && landing.top < landing.expected;
  if (!pinned && !atEndWithPromptAbove)
    return `${label}: last prompt at ${landing.top}, expected ${landing.expected} (or the end with the prompt above; gap ${landing.gapToEnd})`;
  return null;
}

/** Invariant G: an import landing mid-stream cancels the stream cleanly and
 * lands the new conversation on its last prompt; the restore action brings
 * the built-in conversation back the same way. */
async function checkImportMidStream(page, label) {
  const violations = [];
  await clickIfVisible(page, "#scroll-bottom-btn");
  await page.waitForTimeout(800);
  await send(page, `f ${label} mid-stream ${Date.now()}`);
  await page.waitForTimeout(600);
  await importTranscript(page, datedTranscript(40));
  await page.waitForTimeout(600);
  let m = await metrics(page);
  if (m.streaming)
    violations.push(`${label} import: stream still running after import`);
  const importLanding = landingViolation(
    `${label} import`,
    await promptLanding(page),
  );
  if (importLanding) violations.push(importLanding);
  if (!m.status.includes("/40"))
    violations.push(`${label} import: status "${m.status}"`);
  // Restore the built-in conversation through the settings dialog.
  await page.click("#ai-settings-btn");
  await page.waitForTimeout(200);
  const restore = await page.$("#ai-restore-conversation");
  if (!restore || !(await restore.isVisible())) {
    violations.push(`${label} restore: action not shown after an import`);
  } else {
    await restore.click();
    await page.waitForTimeout(800);
    m = await metrics(page);
    if (!m.status.includes("/104") && !m.status.includes("/102")) {
      violations.push(`${label} restore: status "${m.status}"`);
    }
    const restoreLanding = landingViolation(
      `${label} restore`,
      await promptLanding(page),
    );
    if (restoreLanding) violations.push(restoreLanding);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  return violations;
}

/** Invariant H (bounded autoscroll): under "keep-start" a long reply is
 * followed only until its top reaches the viewport top (below the sticky
 * header), then left there; switching back to "end" catches up. */
async function checkKeepStart(page, label) {
  const violations = [];
  await page.click("#ai-settings-btn");
  await page.waitForTimeout(200);
  await page.selectOption("#autoscroll-mode", "keep-start");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await clickIfVisible(page, "#scroll-bottom-btn");
  await page.waitForTimeout(1_000);
  await send(page, `f ${label} keep-start ${Date.now()}`);
  await waitStreamEnd(page);
  await page.waitForTimeout(1_200);
  const reply = await page.evaluate(() => {
    const viewport = document.getElementById("viewport");
    const rect = viewport.getBoundingClientRect();
    const slots = [...viewport.firstElementChild.children];
    const last = slots.reduce((a, b) =>
      a.getBoundingClientRect().top > b.getBoundingClientRect().top ? a : b,
    );
    const inset = viewport.parentElement.classList.contains("sticky-on")
      ? 44
      : 0;
    return {
      top: Math.round((last.getBoundingClientRect().top - rect.top) * 10) / 10,
      height: Math.round(last.getBoundingClientRect().height),
      viewportHeight: rect.height,
      inset,
      gapToEnd:
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
    };
  });
  if (
    reply.height > reply.viewportHeight &&
    Math.abs(reply.top - reply.inset) > 1
  ) {
    violations.push(
      `${label} keep-start: reply top at ${reply.top}, expected ${reply.inset} (height ${reply.height}, end gap ${reply.gapToEnd})`,
    );
  }
  await page.click("#ai-settings-btn");
  await page.waitForTimeout(200);
  await page.selectOption("#autoscroll-mode", "end");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1_500);
  const end = await metrics(page);
  if (Math.abs(end.gapToEnd) > 1) {
    violations.push(
      `${label} keep-start → end: not caught up (gap ${end.gapToEnd})`,
    );
  }
  return violations;
}

/** The scrollback invariant under the page's other loader and header modes. */
async function checkModes(page, baseUrl) {
  const violations = [];
  for (const [options, label] of [
    [{ edge: "pill" }, "pill-loader"],
    [{ sticky: false }, "sticky-off"],
  ]) {
    // General options live in the settings store, not the URL.
    await page.evaluate((next) => {
      localStorage.setItem("virtual-list:chat-options", JSON.stringify(next));
    }, options);
    await page.goto(`${baseUrl}/demos/streaming/index.html?instant`);
    await page.waitForSelector("#viewport > div");
    await page.waitForTimeout(400);
    violations.push(...(await checkScrollback(page, label)));
    await importTranscript(page, datedTranscript(60));
    violations.push(...(await checkScrollback(page, `${label} dated-60`)));
  }
  return violations;
}

export async function runChatCase(engine, browser, baseUrl, options = {}) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`PAGEERROR ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error")
      errors.push(`CONSOLE error ${message.text()}`);
  });
  const violations = [];
  const seed = options.seed ?? 7;
  try {
    await page.goto(`${baseUrl}/demos/streaming/index.html?instant`);
    await page.waitForSelector("#viewport > div");
    await page.waitForTimeout(400);
    violations.push(...(await checkScrollback(page, "simulated")));
    violations.push(...(await checkSend(page, "simulated")));
    violations.push(
      ...(await checkInPlace(
        page,
        "simulated",
        ".version-nav-btn:not([disabled])",
        "version switch",
      )),
    );
    violations.push(
      ...(await checkInPlace(
        page,
        "simulated",
        ".tool-call-summary",
        "tool panel",
      )),
    );
    violations.push(...(await checkJumps(page, "simulated")));
    violations.push(...(await checkResizeDuringLoad(page, "simulated")));
    violations.push(...(await checkImportMidStream(page, "simulated")));
    violations.push(...(await checkKeepStart(page, "simulated")));

    await importTranscript(page, datedTranscript(34));
    violations.push(...(await checkScrollback(page, "dated-34")));
    violations.push(...(await checkSend(page, "dated-34")));

    await importTranscript(page, datedTranscript(120));
    violations.push(...(await checkScrollback(page, "dated-120")));
    violations.push(...(await checkResizeDuringLoad(page, "dated-120")));
    if (options.chaosSeconds > 0) {
      violations.push(
        ...(await chaos(page, "dated-120", seed, options.chaosSeconds)),
      );
    }
    violations.push(...(await checkModes(page, baseUrl)));
  } finally {
    await page.close();
  }
  return { engine, suite: "chat", seed, violations, errors };
}
