// Which structural changes does each engine's CSS scroll anchoring
// compensate? A canvas shaped like next's native surface (spacer, clip
// slots, spacer) is scrolled into its slots, then one change adds 300 px
// above the reader. "moved" is how far the engine moved scrollTop on its
// own; 300 means it anchored, 0 means the change suppressed anchoring.
//   node scripts/anchoring-structure-probe.mjs
// Playwright engine builds, at rest; this says nothing about momentum.
import { chromium, firefox, webkit } from "playwright";

const cases = [
  "spacer grows",
  "slot inserted above",
  "slot above grows",
  "zero-height slot revealed",
  "absolute slot revealed in flow",
  "hidden absolute slot removed",
  "canvas min-height changes",
  "anchor slot replaced",
];

const engines = { chromium, firefox, webkit };
for (const [name, type] of Object.entries(engines)) {
  const browser = await type.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const moved = {};
    for (const change of cases) {
      await page.setContent(
        '<div id="v" style="height:400px;overflow:auto"></div>',
      );
      moved[change] = await page.evaluate(async (change) => {
        const frame = () => new Promise((done) => requestAnimationFrame(done));
        const viewport = document.getElementById("v");
        const canvas = document.createElement("div");
        canvas.style.cssText = "position:relative;width:100%";
        const spacer = (height) => {
          const element = document.createElement("div");
          element.style.cssText = `overflow-anchor:none;height:${height}px`;
          return element;
        };
        const slot = (label, css = "position:relative;height:300px") => {
          const element = document.createElement("div");
          element.style.cssText = `overflow:clip;${css}`;
          const row = document.createElement("div");
          row.style.overflowAnchor = "none";
          row.textContent = label;
          element.append(row);
          return element;
        };
        const top = spacer(1000);
        const slots = Array.from({ length: 12 }, (_, i) => slot(`row ${i}`));
        const hidden = slot(
          "staged",
          "position:absolute;top:-100000px;left:0;right:0;height:300px;visibility:hidden;overflow-anchor:none",
        );
        canvas.append(top, hidden, ...slots, spacer(2000));
        viewport.append(canvas);
        // Reader inside slot 2 (1600–1900).
        viewport.scrollTop = 1700;
        const zero = slot(
          "staged",
          "position:relative;height:0px;visibility:hidden;overflow-anchor:none",
        );
        zero.firstElementChild.style.translate = "0 -100000px";
        if (change === "zero-height slot revealed")
          canvas.insertBefore(zero, slots[0]);
        await frame();
        await frame();
        const before = viewport.scrollTop;
        switch (change) {
          case "spacer grows":
            top.style.height = "1300px";
            break;
          case "slot inserted above":
            canvas.insertBefore(slot("new"), slots[0]);
            break;
          case "slot above grows":
            slots[0].style.height = "600px";
            break;
          case "zero-height slot revealed":
            zero.style.cssText = "position:relative;overflow:clip;height:300px";
            zero.firstElementChild.style.translate = "";
            break;
          case "absolute slot revealed in flow":
            hidden.style.cssText =
              "position:relative;overflow:clip;height:300px";
            break;
          case "hidden absolute slot removed":
            hidden.remove();
            top.style.height = "1300px";
            break;
          case "canvas min-height changes":
            canvas.style.minHeight = "calc(100% + 5000px)";
            top.style.height = "1300px";
            break;
          case "anchor slot replaced":
            slots[2].replaceWith(slot("row 2 again"));
            top.style.height = "1300px";
            break;
        }
        await frame();
        await frame();
        return Math.round(viewport.scrollTop - before);
      }, change);
    }
    console.log(JSON.stringify({ engine: name, moved }));
  } finally {
    await browser.close();
  }
}
