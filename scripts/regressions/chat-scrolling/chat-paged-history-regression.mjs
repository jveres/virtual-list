// Correctness only: synthetic scrolling here is not native performance evidence.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import {
  importTranscript,
  openStreamingDemo,
  pagingTranscript,
  waitForBoot,
} from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";

async function smoothBottom(page) {
  const result = await page.evaluate(async () => {
    const viewport = document.querySelector("#viewport");
    let lastTop = viewport.scrollTop;
    let initial = null;
    let maximum = null;
    const status = () =>
      document
        .querySelector("#window-status")
        .textContent.match(/loaded [\d,-]+\/[\d,]+/)?.[0];
    const initialWindow = status();
    let firstRequestWindow;
    const legs = [];
    const interruptions = [];
    const scrollTo = viewport.scrollTo;
    viewport.scrollTo = function (options) {
      if (options.behavior === "smooth" && initial === null) {
        // The destination must be ready before the one native animation.
        firstRequestWindow = status();
        initial = viewport.scrollTop;
        maximum = viewport.scrollHeight - viewport.clientHeight;
        lastTop = initial;
      }
      if (options.behavior === "smooth")
        legs.push({ from: viewport.scrollTop, to: options.top, positions: [] });
      else if (legs.length) interruptions.push(options);
      return scrollTo.call(this, options);
    };
    const capture = () => {
      lastTop = viewport.scrollTop;
    };
    viewport.addEventListener("scroll", capture, { passive: true });
    let frame;
    const sample = () => {
      legs.at(-1)?.positions.push(lastTop);
      frame = requestAnimationFrame(sample);
    };
    try {
      document.querySelector("#scroll-bottom-btn").click();
      const tailRenderedSynchronously =
        viewport.querySelector('[data-key="124"]') !== null;
      frame = requestAnimationFrame(sample);
      await new Promise((resolve) => setTimeout(resolve, 2200));
      return {
        initial,
        maximum,
        legs,
        interruptions,
        tailRenderedSynchronously,
        initialWindow,
        firstRequestWindow,
        final: viewport.scrollTop,
        finalMaximum: viewport.scrollHeight - viewport.clientHeight,
      };
    } finally {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("scroll", capture);
      viewport.scrollTo = scrollTo;
    }
  });
  assert.equal(
    result.tailRenderedSynchronously,
    false,
    "restoration yields before rendering the evicted tail",
  );
  assert.notEqual(result.initial, null, "restoration starts native animation");
  assert.notEqual(
    result.firstRequestWindow,
    result.initialWindow,
    "tail preparation finishes before native movement starts",
  );
  assert.equal(result.legs.length, 1, "bottom navigation has one easing curve");
  assert.deepEqual(result.interruptions, [], "no mid-animation cancellation");
  assert.ok(
    result.maximum - result.initial > 100,
    "restoration must not land at the end before the glide",
  );
  const intermediate = result.legs.reduce(
    (count, leg) =>
      count +
      new Set(
        leg.positions.filter((top) => top > leg.from + 1 && top < leg.to - 1),
      ).size,
    0,
  );
  assert.ok(
    intermediate >= 5,
    `expected animated progress, got ${intermediate} intermediate positions`,
  );
  assert.ok(
    Math.abs(result.finalMaximum - result.final) <= 1,
    "smooth navigation must reach the end",
  );
}

const engines = { firefox, chromium, webkit };
const selected = process.env.BROWSER_ENGINE;
if (selected && !engines[selected]) throw new Error("Unknown BROWSER_ENGINE");
for (const engine of selected ? [engines[selected]] : Object.values(engines)) {
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
    await openStreamingDemo(page, base, { acceptDialogs: true });
    await importTranscript(page, pagingTranscript(), {
      name: "paged-history.md",
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
    // A newer top command cancels restoration before it can replace history.
    await page.evaluate(() => {
      document.querySelector("#scroll-bottom-btn").click();
      document.querySelector("#scroll-top-btn").click();
    });
    await page.waitForFunction((before) => {
      const status = document.querySelector("#window-status").textContent;
      const first = Number(
        /loaded ([\d,]+)-/.exec(status)?.[1].replaceAll(",", ""),
      );
      return first < before && !status.includes("loading");
    }, afterTwoPages[0]);
    assert.ok(
      (await readRange())[1] < 124,
      "cancelled restoration cannot replace the newer top command",
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
    await page.locator("#scroll-top-btn").click();
    await page.waitForFunction((before) => {
      const first = /loaded ([\d,]+)-/.exec(
        document.querySelector("#window-status").textContent,
      )?.[1];
      return Number(first?.replaceAll(",", "")) < before;
    }, restored[0]);
    await page.locator("#prompt").fill("Keep this send after loading history");
    await page.locator("#send-btn").click();
    await page.waitForFunction(() => {
      const prompt = document.querySelector('#viewport [data-key="125"]');
      const viewport = document.querySelector("#viewport");
      if (!prompt) return false;
      const top =
        prompt.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top;
      return top >= 0 && top < 80;
    });
    await page.locator("#send-btn.stop-btn").click();
    const saved = await page.evaluate(async () => {
      const { loadSimulatedHistory } = await import(
        "/demos/streaming/openai.ts"
      );
      const history = await loadSimulatedHistory();
      return {
        count: history.tree.nodes.length,
        prompt: history.tree.nodes.find((node) => node.id === 125).message
          .markdown,
      };
    });
    assert.equal(saved.count, 126);
    assert.equal(saved.prompt, "Keep this send after loading history");
    await page.reload();
    await waitForBoot(page);
    assert.equal(
      await page.locator('#viewport [data-key="125"] .markdown').innerText(),
      "Keep this send after loading history",
    );
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: bounded history, tail restoration, and send after loading older history survives reload`,
    );
  } finally {
    await browser.close();
  }
}
