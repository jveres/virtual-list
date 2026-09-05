// Run against Vite with BROWSER_MATRIX_URL (default: http://127.0.0.1:4193).
import assert from "node:assert/strict";
import { firefox } from "playwright";

const baseUrl = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:4193";
const browser = await firefox.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 800 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://picsum.photos/**", (route) => route.abort());
  await page.goto(new URL("/demos/gallery/", baseUrl).href);
  await page.locator("#status").filter({ hasText: "120" }).waitFor();
  const initialHeight = await page.evaluate(() => {
    const viewport = document.querySelector("#viewport");
    // Replay a protected edge with no release. Native automation cannot
    // reproduce a motionless two-finger hold, so suppress native scrollend.
    viewport.addEventListener(
      "scrollend",
      (event) => event.stopImmediatePropagation(),
      true,
    );
    viewport.scrollTop = viewport.scrollHeight;
    viewport.dispatchEvent(new Event("scroll"));
    viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 20 }));
    return viewport.scrollHeight;
  });
  await page.locator("#status").filter({ hasText: "240" }).waitFor();
  assert.equal(
    await page.locator("#viewport").evaluate((element) => element.scrollHeight),
    initialHeight,
    "background page must remain held before an explicit action",
  );

  const layoutResult = await page.evaluate(() => {
    document.querySelector('[data-layout="masonry"]').click();
    return {
      bands: document.querySelectorAll("#viewport .band").length,
      rows: document.querySelectorAll("#viewport .photo-row").length,
    };
  });
  assert.ok(layoutResult.bands > 0, "masonry must mount in the click handler");
  assert.equal(layoutResult.rows, 0);

  const sizeResult = await page.evaluate(() => {
    const viewport = document.querySelector("#viewport");
    const before = document.querySelector("#viewport .tile").style.width;
    viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 20 }));
    document.querySelector('[data-size="s"]').click();
    return {
      before,
      after: document.querySelector("#viewport .tile").style.width,
    };
  });
  assert.notEqual(
    sizeResult.before,
    sizeResult.after,
    "size must change in the click handler",
  );

  const rows = await page.evaluate(() => {
    document
      .querySelector("#viewport")
      .dispatchEvent(new WheelEvent("wheel", { deltaY: 20 }));
    document.querySelector('[data-layout="rows"]').click();
    return document.querySelectorAll("#viewport .photo-row").length;
  });
  assert.ok(rows > 0, "switching back to rows must also be immediate");
  assert.deepEqual(errors, []);
  console.log(
    "Firefox: background page deferred; layout, size, and return to rows applied synchronously",
  );
} finally {
  await browser.close();
}
