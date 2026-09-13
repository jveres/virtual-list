// Correctness only: synthetic scrolling here is not native performance evidence.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";

async function smoothBottom(page) {
  const result = await page.evaluate(async () => {
    const viewport = document.querySelector("#viewport");
    let lastTop = viewport.scrollTop;
    const positions = [];
    const capture = () => {
      lastTop = viewport.scrollTop;
    };
    viewport.addEventListener("scroll", capture, { passive: true });
    let frame;
    const sample = () => {
      positions.push(lastTop);
      frame = requestAnimationFrame(sample);
    };
    try {
      document.querySelector("#scroll-bottom-btn").click();
      const initial = viewport.scrollTop;
      const maximum = viewport.scrollHeight - viewport.clientHeight;
      lastTop = initial;
      frame = requestAnimationFrame(sample);
      await new Promise((resolve) => setTimeout(resolve, 2200));
      return {
        initial,
        maximum,
        positions,
        final: viewport.scrollTop,
        finalMaximum: viewport.scrollHeight - viewport.clientHeight,
      };
    } finally {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("scroll", capture);
    }
  });
  assert.ok(
    result.maximum - result.initial > 100,
    "restoration must not land at the end before the glide",
  );
  const intermediate = new Set(
    result.positions.filter(
      (top) => top > result.initial + 1 && top < result.maximum - 1,
    ),
  );
  assert.ok(
    intermediate.size >= 5,
    `expected animated progress, got ${intermediate.size} intermediate positions`,
  );
  assert.ok(
    Math.abs(result.finalMaximum - result.final) <= 1,
    "smooth navigation must reach the end",
  );
}

for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 850 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(`${base}/demos/streaming/`);
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    const transcript = Array.from(
      { length: 124 },
      (_, index) =>
        `**${index % 2 ? "Assistant" : "User"}**\n\nHistory turn ${index + 1}. ${"Synthetic paging content. ".repeat(index < 96 ? 100 : 20)}\n`,
    ).join("\n");
    await page.locator("#import-file").setInputFiles({
      name: "paged-history.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(transcript),
    });
    await page.locator('#viewport [data-key="124"]').waitFor();
    const readRange = () =>
      page.locator("#window-status").evaluate((node) => {
        const match = /loaded ([\d,]+)-([\d,]+)\/([\d,]+)/.exec(
          node.textContent,
        );
        return match
          ?.slice(1)
          .map((value) => Number(value.replaceAll(",", "")));
      });
    for (const first of [73, 49]) {
      await page.locator("#scroll-top-btn").click();
      await page.waitForFunction(
        (first) =>
          document
            .querySelector("#window-status")
            .textContent.includes(`loaded ${first}-`),
        first,
      );
    }
    const afterTwoPages = await readRange();
    assert.equal(
      afterTwoPages[1],
      96,
      "two page loads must evict the latest page",
    );
    await smoothBottom(page);
    assert.equal((await readRange())[1], 124);

    for (let step = 0; step < 9; step++) {
      await page.locator("#viewport").evaluate((node) => {
        node.scrollTop = 0;
        node.dispatchEvent(new Event("scrollend"));
      });
      await page.waitForTimeout(800);
    }
    const [first, last, total] = await readRange();
    assert.equal(total, 124);
    assert.equal(first, 1);
    assert.ok(last < 123, "latest prompt page must be evictable");
    assert.ok(
      last - first + 1 <= 72,
      `retained ${last - first + 1} source messages`,
    );
    await smoothBottom(page);
    await page.locator('#viewport [data-key="124"]').waitFor();
    await page.waitForFunction(() => {
      const node = document.querySelector("#viewport");
      return (
        Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) <= 1
      );
    });
    const restored = await readRange();
    assert.equal(restored[1], 124);
    assert.ok(restored[1] - restored[0] + 1 <= 72);
    assert.match(
      await page.locator('#viewport [data-key="124"]').innerText(),
      /History turn 124/,
    );
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: bounded full-demo history, offscreen pin eviction, and explicit tail restoration passed`,
    );
  } finally {
    await browser.close();
  }
}
