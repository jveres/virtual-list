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

export async function runChatCase(engine, browser, baseUrl) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`PAGEERROR ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error")
      errors.push(`CONSOLE error ${message.text()}`);
  });
  const violations = [];
  try {
    await page.goto(`${baseUrl}/demos/streaming/index.html?instant`);
    await page.waitForSelector("#viewport > div");
    await page.waitForTimeout(400);
    violations.push(...(await checkScrollback(page, "simulated")));

    await importTranscript(page, datedTranscript(34));
    violations.push(...(await checkScrollback(page, "dated-34")));

    await importTranscript(page, datedTranscript(120));
    violations.push(...(await checkScrollback(page, "dated-120")));
  } finally {
    await page.close();
  }
  return { engine, suite: "chat", violations, errors };
}
