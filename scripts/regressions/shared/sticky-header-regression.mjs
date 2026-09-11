import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
const artifacts = "browser-artifacts/sticky-headers";
await mkdir(artifacts, { recursive: true });
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 820 },
      deviceScaleFactor: 2,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem(
        "virtual-list:chat-options",
        JSON.stringify({ sticky: true, landing: "end" }),
      );
    });
    await page.goto(`${base}/demos/streaming/?instant`);
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    // The built-in sample itself must end yesterday, not just display a
    // hard-coded label. Verify its exported per-turn timestamps as well.
    const sampleDownload = page.waitForEvent("download");
    await page.click("#download-btn");
    const sampleText = await readFile(
      await (await sampleDownload).path(),
      "utf8",
    );
    const sampleTimes = [...sampleText.matchAll(/<!-- turn (.*?) -->/g)].map(
      (match) => JSON.parse(match[1]).sentAt,
    );
    assert.ok(sampleTimes.length >= 100);
    assert.ok(sampleTimes.every(Number.isFinite));
    assert.equal(
      await page.evaluate((last) => {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        return new Date(last).toDateString() === yesterday.toDateString();
      }, sampleTimes.at(-1)),
      true,
      "sample's final timestamp is yesterday",
    );
    assert.equal(
      await page
        .locator(".vl-sticky-header .sticky-group")
        .first()
        .textContent(),
      "Yesterday",
    );
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(12, 0, 0, 0);
    const transcript = [
      "# streaming-chat transcript",
      "",
      "<!-- day -->",
      "## Yesterday",
      "",
    ];
    for (let i = 0; i < 8; i++) {
      transcript.push(
        `**${i % 2 ? "Assistant" : "User"}**`,
        `<!-- turn {"sentAt":${yesterday.getTime() + i * 60000}} -->`,
        "",
        `Earlier message ${i}. ${"A previous day of conversation. ".repeat(20)}`,
        "",
      );
    }
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#import-file").setInputFiles({
      name: "yesterday.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(transcript.join("\n")),
    });
    await page.waitForFunction(() =>
      document
        .querySelector("#viewport")
        ?.textContent.includes("Earlier message 7"),
    );
    await page.fill(
      "#prompt",
      `A new message today.\n\n${"History boundary check.\n\n".repeat(30)}`,
    );
    await page.click("#send-btn");
    await page.waitForFunction(() =>
      document
        .querySelector("#viewport")
        ?.textContent.includes("A new message today."),
    );
    // Interrupt streaming and any follow glide, keeping the new day in place.
    await page.waitForTimeout(250);
    await page.locator("#send-btn").evaluate((button) => {
      if (button.textContent.trim() === "Stop") button.click();
    });
    await page.waitForTimeout(500);
    const sentDownload = page.waitForEvent("download");
    await page.click("#download-btn");
    const sentText = await readFile(await (await sentDownload).path(), "utf8");
    const sentTimes = [...sentText.matchAll(/<!-- turn (.*?) -->/g)].map(
      (match) => JSON.parse(match[1]).sentAt,
    );
    assert.equal(
      await page.evaluate(
        (last) => new Date(last).toDateString() === new Date().toDateString(),
        sentTimes.at(-1),
      ),
      true,
      "new simulated reply is dated today",
    );

    // This fixture must scroll the new day's header above the viewport, not
    // merely reach the keep-start reserve. Long prompts now collapse by
    // default; expand this one so the full handoff has real scroll range.
    await page
      .locator(".message.user")
      .filter({ hasText: "A new message today." })
      .getByRole("button", { name: "Expand message", exact: true })
      .evaluate((button) => button.click());
    await page.waitForTimeout(150);

    for (const distance of [
      100, 88, 87, 80, 60, 41, 40, 39, 33, 32, 31, 30, 10, 0.5, 0, -10, 0, 10,
      30, 31, 32, 33, 39, 40, 41, 60, 80, 87, 88, 100,
    ]) {
      const result = await page.evaluate(async (distance) => {
        const v = document.querySelector("#viewport");
        const today = [...v.querySelectorAll(".section-header")].find(
          (element) => element.textContent === "Today",
        );
        if (!today) throw new Error("Today's inline header is not mounted");
        v.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        v.scrollTop +=
          today.getBoundingClientRect().top -
          v.getBoundingClientRect().top -
          distance;
        v.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        v.dispatchEvent(new Event("scroll"));
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        const overlay = document.querySelector(".vl-sticky-header");
        const slots = [...overlay.querySelectorAll(".sticky-group")];
        const a = slots[0].getBoundingClientRect();
        const b = slots[1].getBoundingClientRect();
        const overlayBox = overlay.getBoundingClientRect();
        const top = overlayBox.top;
        const headerHeight = today.getBoundingClientRect().height;
        const incomingPill = slots[1]
          .querySelector(".section-header-pill")
          ?.getBoundingClientRect();
        return {
          requestedDistance: distance,
          scrollTop: v.scrollTop,
          scrollHeight: v.scrollHeight,
          viewportHeight: v.clientHeight,
          headerHeight,
          actualDistance:
            today.getBoundingClientRect().top - v.getBoundingClientRect().top,
          active: slots[0].textContent,
          activeVisibility: getComputedStyle(slots[0]).visibility,
          activeOffset: a.top - top,
          incoming: slots[1].textContent,
          incomingOffset: b.top - top,
          overlap: slots[1].textContent
            ? Math.max(
                0,
                Math.min(a.bottom, b.bottom, top + headerHeight) -
                  Math.max(a.top, b.top, top),
              )
            : 0,
          inlineVisibility: getComputedStyle(today).visibility,
          incomingClipped: incomingPill
            ? Math.max(0, incomingPill.bottom - overlayBox.bottom) +
              Math.max(0, overlayBox.top - incomingPill.top)
            : 0,
        };
      }, distance);
      assert.ok(
        Math.abs(result.actualDistance - distance) <= 1,
        `fixture reached handoff: ${JSON.stringify(result)}`,
      );
      assert.ok(
        result.overlap <= 0.5,
        `old and new sticky pills overlap: ${JSON.stringify(result)}`,
      );
      assert.ok(
        result.incomingClipped <= 0.5,
        `incoming pill was clipped: ${JSON.stringify(result)}`,
      );
      assert.equal(
        result.activeVisibility,
        "visible",
        `outgoing date must slide out, not disappear, at ${distance}`,
      );
      const expectedOffset =
        result.active === "Yesterday"
          ? Math.min(0, result.actualDistance - result.headerHeight)
          : 0;
      assert.ok(
        Math.abs(result.activeOffset - expectedOffset) <= 0.5,
        `date handoff must track scrolling in both directions: ${JSON.stringify(result)}`,
      );
      assert.equal(
        result.inlineVisibility,
        distance < result.headerHeight ? "hidden" : "visible",
        `overlay owns today's header at ${distance}`,
      );
      if (result.incoming === "Today") {
        assert.ok(
          Math.abs(result.incomingOffset - result.actualDistance) <= 0.5,
          `incoming date must stay attached to its message: ${JSON.stringify(result)}`,
        );
      }
      if (distance <= 0) {
        assert.equal(result.active, "Today");
        assert.equal(result.incoming, "");
      }
      if (distance === 40 || distance === 30 || distance === 0) {
        const box = await page.locator(".viewport-wrap").boundingBox();
        await page.screenshot({
          path: `${artifacts}/${engine.name()}-${distance}.png`,
          clip: { ...box, height: 130 },
        });
      }
    }
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: sending into a new day, nonoverlapping pill handoff and inline ownership passed`,
    );
  } finally {
    await browser.close();
  }
}
