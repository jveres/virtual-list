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
      `${engine.name()}: preparation waits for top landing; paging and replacement cancellation passed`,
    );
  } finally {
    await browser.close();
  }
}
