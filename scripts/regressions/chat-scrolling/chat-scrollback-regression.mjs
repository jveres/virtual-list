// Offline scrollback scheduling: preparation must not run under a top glide.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, webkit, chromium]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1900, height: 965 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(`${base}/demos/streaming/index.html`);
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    const image = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 600;
      canvas.height = 400;
      canvas.getContext("2d").fillRect(0, 0, 600, 400);
      return canvas.toDataURL();
    });
    const transcript = (name) =>
      Array.from({ length: 48 }, (_, index) => {
        const role = index % 2 ? "Assistant" : "User";
        return `**${role}**\n<!-- turn {"sentAt":1788772464423} -->\n\n${name} turn ${index + 1}. ${"Text for the scrolling fixture. ".repeat(12)}\n\n${index % 2 ? `![Fixture image](${image})\n\n` : ""}`;
      }).join("\n");
    const importChat = async (name) => {
      await page.locator("#import-file").setInputFiles({
        name: `${name}.md`,
        mimeType: "text/markdown",
        buffer: Buffer.from(transcript(name)),
      });
      await page
        .locator("#viewport article.message")
        .filter({ hasText: `${name} turn 48.` })
        .waitFor();
    };
    const initialStart = () =>
      page.locator("#window-status").evaluate((element) => {
        const match = /loaded (\d+)-48\/48/.exec(element.textContent);
        return match ? Number(match[1]) : null;
      });
    await importChat("Initial");
    const first = await initialStart();
    assert.ok(first > 1, "fixture has unloaded scrollback");
    await page.evaluate((first) => {
      const viewport = document.querySelector("#viewport");
      const probe = { first, landed: false, measurements: [], writes: [] };
      window.scrollbackProbe = probe;
      const rect = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function (...args) {
        if (
          this.matches("article.message[data-key]") &&
          Number(this.dataset.key) < probe.first
        ) {
          probe.measurements.push({
            key: this.dataset.key,
            landed: probe.landed,
          });
        }
        return rect.apply(this, args);
      };
      const top = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "scrollTop",
      );
      Object.defineProperty(viewport, "scrollTop", {
        ...top,
        set(value) {
          probe.writes.push(value);
          if (value === 0) probe.landed = true;
          top.set.call(this, value);
        },
      });
    }, first);
    await page.locator("#scroll-top-btn").click();
    await page.waitForFunction(
      () =>
        window.scrollbackProbe.measurements.length > 0 &&
        !document
          .querySelector("#window-status")
          .textContent.includes("loading"),
    );
    const prepared = await page.evaluate(() => window.scrollbackProbe);
    assert.ok(prepared.measurements.length > 0);
    assert.ok(
      prepared.measurements.every((entry) => entry.landed),
      "older rows are not prepared before the top glide lands",
    );
    assert.equal(await initialStart(), 1);
    assert.ok(
      prepared.writes.at(-1) > 0,
      "the committed prepend preserves the old top's reading position",
    );

    // With all history loaded, returning across the top slot must hand the
    // pinned date pill back to its inline row in the glide's own frame.
    await page.locator("#scroll-top-btn").click();
    await page.waitForFunction(
      () => document.querySelector("#viewport").scrollTop === 0,
    );
    for (const distance of [250, 600]) {
      await page.locator("#viewport").evaluate((viewport, distance) => {
        viewport.scrollTop = distance;
        viewport.dispatchEvent(new Event("scroll"));
      }, distance);
      await page.waitForTimeout(250);
      const handoff = await page.evaluate(async () => {
        const viewport = document.querySelector("#viewport");
        const inline = viewport.querySelector(".section-header");
        const inlineVisual = inline.querySelector(".section-header-pill");
        const overlay = document.querySelector(".vl-sticky-header");
        const boundary =
          inline.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top +
          viewport.scrollTop;
        const originalFrame = window.requestAnimationFrame;
        const descriptor = Object.getOwnPropertyDescriptor(
          viewport,
          "scrollTop",
        );
        let writes = 0;
        const samples = [];
        Object.defineProperty(viewport, "scrollTop", {
          ...descriptor,
          set(value) {
            writes++;
            descriptor.set.call(this, value);
          },
        });
        window.requestAnimationFrame = (callback) =>
          originalFrame.call(window, (time) => {
            const before = writes;
            callback(time);
            if (writes !== before) {
              samples.push({
                top: viewport.scrollTop,
                pinned: overlay.style.display !== "none",
                inlineHidden: inlineVisual.classList.contains(
                  "vl-sticky-inline-hidden",
                ),
                rowVisible: getComputedStyle(inline).visibility === "visible",
              });
            }
          });
        try {
          document.querySelector("#scroll-top-btn").click();
          await new Promise((resolve, reject) => {
            const deadline = performance.now() + 3000;
            const poll = () => {
              if (viewport.scrollTop === 0) resolve();
              else if (performance.now() > deadline)
                reject(new Error("return-to-top glide did not land"));
              else originalFrame.call(window, poll);
            };
            originalFrame.call(window, poll);
          });
          return { boundary, samples };
        } finally {
          window.requestAnimationFrame = originalFrame;
          Object.defineProperty(viewport, "scrollTop", descriptor);
        }
      });
      assert.ok(handoff.boundary > 0, "fixture retains its top slot");
      // WebKit may deliver fewer callbacks for a short glide. Coverage is
      // established by crossing the boundary below, not assuming 60 Hz.
      assert.ok(handoff.samples.length >= 4, "sampled the moving glide");
      assert.ok(
        handoff.samples.some(({ top }) => top > 1 && top < handoff.boundary),
        "glide crossed the header release before landing",
      );
      for (const sample of handoff.samples) {
        const pinned = sample.top >= handoff.boundary;
        assert.equal(
          sample.pinned,
          pinned,
          `same-frame overlay: ${JSON.stringify(sample)}`,
        );
        assert.equal(
          sample.inlineHidden,
          pinned,
          `same-frame inline header: ${JSON.stringify(sample)}`,
        );
        assert.equal(
          sample.rowVisible,
          true,
          "the measured header row stays visible",
        );
      }
      assert.equal(await initialStart(), 1, "return glide did not page");
    }

    // Replacing a chat while its fetch/window update is pending cancels it;
    // the replacement still gets its own working loader.
    await importChat("Cancelled");
    await page.locator("#scroll-top-btn").click();
    await page.waitForFunction(() =>
      document.querySelector("#window-status").textContent.includes("loading"),
    );
    await importChat("Replacement");
    assert.equal(await initialStart(), first);
    await page.locator("#scroll-top-btn").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#window-status")
        .textContent.includes("loaded 1-48/48 · load none"),
    );
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: scrollback scheduling, same-frame header release and replacement cancellation passed`,
    );
  } finally {
    await browser.close();
  }
}
