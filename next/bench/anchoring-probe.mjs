// Does each engine anchor natively? A flow list, scrolled to the middle,
// gets content inserted above the viewport and an above-viewport row grown,
// with no script scroll write. Native CSS scroll anchoring keeps the first
// visible row in place by moving scrollTop itself.
//   node next/bench/anchoring-probe.mjs
// Playwright engine builds only; this says nothing about native momentum.
import process from "node:process";
import { chromium, firefox, webkit } from "playwright";

const engines = { chromium, firefox, webkit };
for (const [name, type] of Object.entries(engines)) {
  const browser = await type.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<div id="v" style="height:400px;overflow:auto"></div>',
    );
    const result = await page.evaluate(async () => {
      const frame = () => new Promise((done) => requestAnimationFrame(done));
      const viewport = document.getElementById("v");
      const row = (label, height) => {
        const element = document.createElement("div");
        element.textContent = label;
        element.style.height = `${height}px`;
        return element;
      };
      for (let i = 0; i < 50; i++) viewport.append(row(`row ${i}`, 100));
      viewport.scrollTop = 2000;
      await frame();
      const before = viewport.scrollTop;
      for (let i = 0; i < 5; i++) viewport.prepend(row(`prepended ${i}`, 100));
      await frame();
      const afterPrepend = viewport.scrollTop;
      viewport.children[10].style.height = "300px";
      await frame();
      const afterGrowth = viewport.scrollTop;
      return {
        supports: CSS.supports("overflow-anchor", "auto"),
        before,
        afterPrepend,
        afterGrowth,
        anchored: afterPrepend === before + 500 && afterGrowth === before + 700,
      };
    });
    process.stdout.write(
      `${JSON.stringify({ engine: name, version: browser.version(), ...result })}\n`,
    );
  } finally {
    await browser.close();
  }
}
