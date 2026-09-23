import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";

const engine = process.env.BROWSER_ENGINE ?? "webkit";
const browser = await { chromium, webkit }[engine].launch();
try {
  const page = await browser.newPage({
    hasTouch: true,
    isMobile: true,
    viewport:
      process.env.DEVICE === "tablet"
        ? { width: 820, height: 1180 }
        : { width: 390, height: 844 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await openStreamingDemo(page, base);
  // A touch-primary device can still hover with a Pencil or attached pointer.
  // Mouse movement exercises real CSS :hover in WebKit, but is not a physical
  // Pencil test. Chromium additionally supports pen input through CDP below.
  assert.equal(
    await page.evaluate(() => matchMedia("(hover: hover)").matches),
    false,
  );
  const hoveredRow = page.locator("#viewport .message.user").last();
  const actions = hoveredRow.locator(".message-user-actions");
  const actionState = () =>
    actions.evaluate((el) => ({
      opacity: getComputedStyle(el).opacity,
      pointerEvents: getComputedStyle(el).pointerEvents,
    }));
  await hoveredRow.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  assert.deepEqual(await actionState(), {
    opacity: "0",
    pointerEvents: "none",
  });
  const before = await hoveredRow.boundingBox();
  await hoveredRow
    .locator(".message-content")
    .hover({ position: { x: 12, y: 12 } });
  assert.deepEqual(await actionState(), {
    opacity: "1",
    pointerEvents: "auto",
  });
  assert.equal(
    await hoveredRow.getAttribute("data-actions-visible"),
    null,
    "hover needs no tap",
  );
  assert.ok(
    Math.abs((await hoveredRow.boundingBox()).height - before.height) < 0.1,
  );
  await hoveredRow.locator(".message-edit-btn").hover();
  assert.deepEqual(await actionState(), {
    opacity: "1",
    pointerEvents: "auto",
  });
  await page.mouse.move(0, 0);
  assert.deepEqual(await actionState(), {
    opacity: "0",
    pointerEvents: "none",
  });
  if (engine === "chromium") {
    await page.locator("#viewport").tap({ position: { x: 2, y: 2 } });
    assert.equal(
      await page.locator("#viewport").getAttribute("data-hover-input"),
      null,
    );
    await page.evaluate(() => {
      window.penHoverSeen = false;
      document.addEventListener("pointerover", (event) => {
        if (event.pointerType === "pen" && event.buttons === 0)
          window.penHoverSeen = true;
      });
    });
    const cdp = await page.context().newCDPSession(page);
    try {
      const bubble = await hoveredRow.locator(".message-content").boundingBox();
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: bubble.x + 12,
        y: bubble.y + 12,
        pointerType: "pen",
        buttons: 0,
      });
      assert.equal(await page.evaluate(() => window.penHoverSeen), true);
      assert.deepEqual(await actionState(), {
        opacity: "1",
        pointerEvents: "auto",
      });
      assert.equal(await hoveredRow.getAttribute("data-actions-visible"), null);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 0,
        y: 0,
        pointerType: "pen",
        buttons: 0,
      });
      assert.deepEqual(await actionState(), {
        opacity: "0",
        pointerEvents: "none",
      });
    } finally {
      await cdp.detach();
    }
  }
  await page.evaluate(() => {
    window.actionSamples = [];
    const sample = () => {
      for (const actions of document.querySelectorAll(
        "#viewport .message-user-actions",
      ))
        window.actionSamples.push(Number(getComputedStyle(actions).opacity));
    };
    // Observe both the press and release, not just the rebuilt row afterward.
    document.addEventListener("pointerdown", sample);
    document.addEventListener("pointerup", sample, true);
  });
  for (const direction of ["Next", "Previous", "Next", "Previous"]) {
    const row = page.locator("#viewport .message.user").last();
    const oldKey = await row.getAttribute("data-key");
    await row.getByRole("button", { name: `${direction} version` }).tap();
    await page.waitForTimeout(100);
    assert.notEqual(
      await page
        .locator("#viewport .message.user")
        .last()
        .getAttribute("data-key"),
      oldKey,
    );
    assert.equal(
      await page
        .locator("#viewport .message.user")
        .last()
        .locator(".message-user-actions")
        .evaluate((el) => getComputedStyle(el).opacity),
      "0",
    );
  }
  const samples = await page.evaluate(() => window.actionSamples);
  assert.ok(samples.length > 0);
  assert.ok(
    samples.every((opacity) => opacity === 0),
    `navigator revealed actions: ${JSON.stringify(samples)}`,
  );

  const row = page.locator("#viewport .message.user").last();
  await row.locator(".message-content").hover({ position: { x: 12, y: 12 } });
  assert.deepEqual(
    await actionState(),
    { opacity: "1", pointerEvents: "auto" },
    "hover resumes after touch navigation",
  );
  await page.mouse.move(0, 0);
  assert.deepEqual(await actionState(), {
    opacity: "0",
    pointerEvents: "none",
  });
  await row.locator(".message-content").tap({ position: { x: 12, y: 12 } });
  assert.equal(
    await row
      .locator(".message-user-actions")
      .evaluate((el) => getComputedStyle(el).opacity),
    "1",
  );
  await row.locator(".message-edit-btn").tap();
  await page
    .getByRole("textbox", { name: "Edit user message", exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      engine,
      device: process.env.DEVICE ?? "phone",
      touchPrimaryHover: "passed",
      penHover: engine === "chromium" ? "passed" : "not available",
      touchNavigation: "passed",
      bubbleActions: "passed",
      edit: "passed",
    }),
  );
} finally {
  await browser.close();
}
