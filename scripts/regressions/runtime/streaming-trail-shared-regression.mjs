import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, firefox, webkit } from "playwright";
import { compareTrailPixels } from "../shared/trail-pixels.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
const output = "browser-artifacts/streaming-trail/shared-comparison";
await mkdir(output, { recursive: true });
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 800, height: 1000 },
      deviceScaleFactor: 2,
    });
    await page.route("**/__shared-trail", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><body style="margin:30px"><div id="host" style="width:600px"></div>',
      }),
    );
    await page.goto(`${base}/__shared-trail`);
    await page.evaluate(async () => {
      const { initMarkdown, createMarkdownViewer } = await import(
        "/demos/shared/markdown.ts"
      );
      await initMarkdown();
      window.createFixture = (mode, theme) => {
        window.fixture?.viewer.destroy();
        const viewer = createMarkdownViewer(document.querySelector("#host"), {
          text: "",
          isStreaming: true,
          streamingTrail: {},
          throttleMs: 0,
          cursor: "none",
          focusOnStreamingStart: false,
        });
        const root = viewer.getContainer();
        root.style.cssText = `font:24px/2 Arial;--cursor-color:#f5a1ff;color-scheme:${theme};color:${theme === "dark" ? "white" : "black"}`;
        document.body.style.background = theme === "dark" ? "#111" : "white";
        window.fixture = {
          viewer,
          root,
          mode,
        };
      };
    });
    for (const theme of ["light", "dark"]) {
      const captures = [];
      for (const mode of ["baseline", "rebuilt"]) {
        await page.evaluate(
          ([mode, theme]) => window.createFixture(mode, theme),
          [mode, theme],
        );
        let text = "";
        for (const chunk of [
          "Paragraph with **colored** words that wrap over multiple lines, preserving their original background geometry.",
          "\n\n```js\nmessages[idx].markdown += tok;\nrefreshItem(idx);\n```",
          "\n\n| Approach | Result |\n|---|---|\n| Shared blending | **Same pixels** |\n| Existing overlay | Control |",
        ]) {
          text += chunk;
          await page.evaluate(async (text) => {
            window.fixture.viewer.update({ text });
            await new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            );
            for (const animation of document
              .querySelector("[data-streaming-trail]")
              .getAnimations({ subtree: true }))
              animation.pause();
          }, text);
          await page.waitForTimeout(160);
        }
        const bounds = await page.evaluate(async () => {
          if (window.fixture.mode === "rebuilt") {
            const root = window.fixture.root;
            root.replaceChildren(
              ...[...root.childNodes].map((node) => node.cloneNode(true)),
            );
            await new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            );
          }
          const groups = [...document.querySelectorAll("[data-trail-group]")];
          for (const [index, group] of groups.entries()) {
            const animation = group.getAnimations()[0];
            animation.currentTime = [900, 500, 150][index];
          }
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          const surface = document.querySelector("[data-trail-blend]");
          const rects = [
            ...document.querySelectorAll("[data-trail-group] > div"),
          ].map((e) => e.getBoundingClientRect());
          const union = [
            Math.min(...rects.map((r) => r.left)),
            Math.min(...rects.map((r) => r.top)),
            Math.max(...rects.map((r) => r.right)),
            Math.max(...rects.map((r) => r.bottom)),
          ];
          const box = surface?.getBoundingClientRect();
          return {
            groups: groups.length,
            union,
            surface: box ? [box.left, box.top, box.right, box.bottom] : null,
            blendingGroups: groups.filter(
              (e) => getComputedStyle(e).mixBlendMode !== "normal",
            ).length,
          };
        });
        assert.equal(bounds.groups, 3);
        assert.equal(bounds.blendingGroups, 0);
        if (mode === "rebuilt")
          for (let i = 0; i < 4; i++)
            assert.ok(
              Math.abs(bounds.union[i] - bounds.surface[i]) < 0.1,
              JSON.stringify(bounds),
            );
        captures.push(
          await page.locator("#host").screenshot({
            animations: "allow",
            path: `${output}/${engine.name()}-${theme}-${mode}.png`,
          }),
        );
        if (mode === "rebuilt") {
          const shrink = await page.evaluate(async () => {
            const surface = document.querySelector("[data-trail-blend]");
            const before = surface.getBoundingClientRect().height;
            document
              .querySelector("[data-trail-group]")
              .getAnimations()[0]
              .finish();
            await new Promise((resolve) => setTimeout(resolve, 100));
            return {
              before,
              after: surface.getBoundingClientRect().height,
              groups: document.querySelectorAll("[data-trail-group]").length,
            };
          });
          assert.equal(shrink.groups, 2);
          assert.ok(shrink.after < shrink.before, JSON.stringify(shrink));
        }
      }
      const pixels = compareTrailPixels(captures[0], captures[1]);
      assert.equal(
        pixels.differentPixels,
        0,
        `${engine.name()} ${theme}: ${JSON.stringify(pixels)}`,
      );
      console.log(
        `${engine.name()} ${theme}: stable pixels across DOM replacement; tight and shrinking blend bounds`,
      );
    }
  } finally {
    await browser.close();
  }
}
