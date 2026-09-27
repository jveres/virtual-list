import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
const output = "browser-artifacts/streaming-trail/renderer";
await mkdir(output, { recursive: true });
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 900, height: 800 },
      deviceScaleFactor: 2,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/__trail-probe", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><body style="margin:30px;background:white"><div id="host" style="width:600px"></div>',
      }),
    );
    await page.goto(`${base}/__trail-probe`);
    await page.evaluate(async () => {
      const { initMarkdown, createMarkdownViewer } = await import(
        "/demos/shared/markdown.ts"
      );
      await initMarkdown();
      const viewer = createMarkdownViewer(document.querySelector("#host"), {
        text: "",
        isStreaming: true,
        throttleMs: 0,
        cursor: "none",
        focusOnStreamingStart: false,
      });
      const createStreamingTrail = (_root, mode) => {
        viewer.update({
          streamingTrail: { durationMs: mode === "long" ? 1200 : 600 },
        });
        return {
          finish: () => viewer.update({ isStreaming: false }),
          destroy: () => viewer.update({ streamingTrail: false }),
        };
      };
      const root = viewer.getContainer();
      root.style.cssText = "font:24px/2 Arial;--cursor-color:#f5a1ff";
      window.probe = {
        root,
        viewer,
        createStreamingTrail,
        trail: createStreamingTrail(root, "long"),
      };
      // Each trail group fades on its own; the groups needn't sit inside the
      // [data-streaming-trail] layer element.
      window.trailFades = () =>
        document
          .getAnimations()
          .filter((a) => a.effect?.target?.matches?.("[data-trail-group]"));
      window.covered = (expected, scope = root) => {
        const nodes = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
        for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
          const start = node.data.indexOf(expected);
          if (start < 0) continue;
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + expected.length);
          const overlays = [
            ...document.querySelectorAll("[data-trail-group] > div"),
          ].map((e) => e.getBoundingClientRect());
          return [...range.getClientRects()]
            .filter((r) => r.width > 0)
            .every((r) =>
              overlays.some(
                (b) =>
                  b.left <= r.left + 1 &&
                  b.right >= r.right - 1 &&
                  Math.abs(b.top - r.top) < 0.5 &&
                  Math.abs(b.bottom - r.bottom) < 0.5,
              ),
            );
        }
        return false;
      };
    });
    const update = async (text) => {
      await page.evaluate((text) => window.probe.viewer.update({ text }), text);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
    };
    let text = "";
    for (const [append, expected] of [
      ["Paragraph", "Paragraph"],
      [" paragraph_tail", "paragraph_tail"],
      ["\n\n- First", "First"],
      [" list_tail", "list_tail"],
      ["\n  - Nested nested_tail", "nested_tail"],
      ["\n\n1. Ordered ordered_tail", "ordered_tail"],
      ["\n\n## Heading heading_tail", "heading_tail"],
      ["\n\n> Quoted quote_tail", "quote_tail"],
      ["\n\nText with **bold", "bold"],
      [" bold_tail** and plain_tail", "plain_tail"],
      ["\n\n```ts\nconst value = 'code_tail", "code_tail"],
    ]) {
      text += append;
      await update(text);
      assert.equal(
        await page.evaluate((expected) => window.covered(expected), expected),
        true,
        `${engine.name()}: missing ${expected}`,
      );
    }
    // Each visual line gets a tight rectangle, including source line breaks.
    await page.evaluate(() => window.probe.trail.destroy());
    await update("");
    await page.evaluate(
      () =>
        (window.probe.trail = window.probe.createStreamingTrail(
          window.probe.root,
          "long",
        )),
    );
    text =
      "If those remain stable, the demo is covering the failure modes that are easy to\nmiss with very short responses.";
    await update(text);
    assert.equal(
      await page.evaluate(() =>
        window.covered("miss with very short responses."),
      ),
      true,
    );
    assert.equal(await page.evaluate(() => CSS.highlights?.size ?? 0), 0);
    const geometry = await page.evaluate(() => {
      const { root } = window.probe;
      const glyphs = [];
      const nodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
        if (!node.data.trim()) continue;
        const r = document.createRange();
        r.selectNodeContents(node);
        glyphs.push(...r.getClientRects());
      }
      return [...document.querySelectorAll("[data-trail-group] > div")].map(
        (e) => {
          const b = e.getBoundingClientRect();
          return glyphs.some(
            (g) =>
              Math.abs(b.top - g.top) < 0.5 &&
              Math.abs(b.bottom - g.bottom) < 0.5,
          );
        },
      );
    });
    assert.ok(geometry.length >= 3 && geometry.every(Boolean));
    // Each streamed chunk starts its own fade, and finish() only waits for
    // the running ones: pause the newest before anything slow can end it.
    const animation = await page.evaluate(() => {
      const a = window.trailFades().at(-1);
      if (!a) throw new Error("no running fade after the wrapped text");
      a.pause();
      a.currentTime = 0;
      window.probe.fade = a;
      return a.effect.getKeyframes().map((f) => f.opacity);
    });
    assert.deepEqual(animation, ["0.65", "0"]);
    await page.screenshot({ path: `${output}/${engine.name()}-wrapped.png` });
    await page.evaluate((text) => {
      window.probe.viewer.update({ text, isStreaming: false });
      window.probe.trail.finish();
    }, text);
    const opacity = [];
    for (const time of [0, 600, 1100]) {
      opacity.push(
        await page.evaluate((time) => {
          const a = window.probe.fade;
          a.currentTime = time;
          return Number(getComputedStyle(a.effect.target).opacity);
        }, time),
      );
      await page.screenshot({
        path: `${output}/${engine.name()}-fade-${time}.png`,
      });
    }
    assert.ok(
      opacity[0] > opacity[1] && opacity[1] > opacity[2] && opacity[2] < 0.02,
    );
    await page.evaluate(() => {
      document.querySelector("#host").style.width = "300px";
      window.probe.fade.currentTime = 250;
    });
    await page.waitForFunction(() =>
      window.covered("miss with very short responses."),
    );
    assert.equal(await page.evaluate(() => window.probe.fade.currentTime), 250);
    await page.evaluate(() => {
      const paragraph = window.probe.root.querySelector("p");
      paragraph.replaceWith(paragraph.cloneNode(true));
    });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(
      await page.evaluate(() =>
        window.covered("miss with very short responses."),
      ),
      true,
    );
    assert.equal(await page.evaluate(() => window.probe.fade.currentTime), 250);
    await page.evaluate(() => {
      const { root } = window.probe;
      root.style.colorScheme = "dark";
      root.style.color = "white";
      document.body.style.background = "#111";
      document.querySelector("#host").style.width = "450px";
    });
    await page.waitForFunction(() =>
      [...document.querySelectorAll("[data-trail-blend]")].every(
        (e) => getComputedStyle(e).mixBlendMode === "lighten",
      ),
    );
    await page.screenshot({ path: `${output}/${engine.name()}-dark.png` });
    await page.evaluate(() => {
      const { root } = window.probe;
      root.style.colorScheme = "light";
      root.style.color = "";
      document.body.style.background = "white";
      document.querySelector("#host").style.width = "600px";
      window.probe.fade.currentTime = 1100;
    });
    await page.waitForFunction(() =>
      window.covered("miss with very short responses."),
    );
    // Idle fade must not keep measuring ranges.
    await page.evaluate(() => {
      window.probe.fade.currentTime = 300;
      window.probe.fade.play();
      window.probe.reads = 0;
      window.probe.originalRects = Range.prototype.getClientRects;
      Range.prototype.getClientRects = function () {
        window.probe.reads++;
        return window.probe.originalRects.call(this);
      };
    });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.probe.reads), 0);
    await page.evaluate(() => {
      Range.prototype.getClientRects = window.probe.originalRects;
      window.probe.fade.play();
    });
    await page.waitForFunction(
      () => !document.querySelector("[data-streaming-trail]"),
    );
    // Reduced motion: no trail; it resumes once motion is allowed again.
    // (Since markdown-viewer v0.5.0 the trail follows appended text only;
    // an edit mid-source, such as a table cell, animates formulas alone.)
    await page.evaluate(() => window.probe.trail.destroy());
    await page.evaluate(() =>
      window.probe.viewer.update({ text: "", isStreaming: true }),
    );
    await page.evaluate(
      () =>
        (window.probe.trail = window.probe.createStreamingTrail(
          window.probe.root,
          "long",
        )),
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await update("Reduced motion start");
    assert.equal(await page.locator("[data-trail-group]").count(), 0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForTimeout(100);
    await update("Reduced motion start resumed");
    assert.equal(await page.evaluate(() => window.covered("resumed")), true);
    await page.evaluate(() => window.probe.trail.destroy());
    await update("```text\n");
    await page.evaluate(
      () =>
        (window.probe.trail = window.probe.createStreamingTrail(
          window.probe.root,
          "long",
        )),
    );
    await update(`\`\`\`text\n${"wide ".repeat(80)}scroll_target`);
    await page.evaluate(() => {
      for (const a of window.trailFades()) {
        a.pause();
        a.currentTime = 250;
      }
      const pre = window.probe.root.querySelector("pre");
      pre.scrollLeft = pre.scrollWidth;
    });
    await page.waitForFunction(() => window.covered("scroll_target"));
    await page.evaluate(() => window.probe.trail.destroy());
    await update("bounded");
    // 400 streamed tokens stay within a bounded number of groups and rects.
    // (The trail follows appended source, not DOM edits, since v0.5.0.)
    await page.evaluate(async () => {
      const { root, createStreamingTrail, viewer } = window.probe;
      window.probe.trail = createStreamingTrail(root, "long");
      let text = "bounded";
      for (let i = 0; i < 400; i++) {
        text += ` token-${i}`;
        viewer.update({ text });
        await Promise.resolve();
      }
    });
    await page.waitForFunction(
      () => document.querySelectorAll("[data-trail-group] > div").length > 0,
    );
    assert.ok((await page.locator("[data-trail-group]").count()) <= 8);
    assert.ok((await page.locator("[data-trail-group] > div").count()) <= 128);
    assert.equal(
      await page.evaluate(() =>
        window.probe.root.querySelector("[data-streaming-trail]"),
      ),
      null,
    );
    await page.evaluate(() => {
      window.probe.trail.destroy();
      window.probe.trail.destroy();
      window.probe.viewer.destroy();
    });
    assert.equal(await page.locator("[data-streaming-trail]").count(), 0);
    const lifecycle = await page.evaluate(async () => {
      const { createMessageContent } = await import(
        "/demos/streaming/message-content.ts"
      );
      const host = document.querySelector("#host");
      const content = createMessageContent(host, "none", "long");
      const update = async (markdown) => {
        content.update({ markdown }, markdown, true);
        const deadline = performance.now() + 2000;
        while (host.querySelector(".markdown")?.textContent !== markdown) {
          if (performance.now() > deadline)
            throw new Error("Renderer did not flush the lifecycle fixture");
          await new Promise(requestAnimationFrame);
        }
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      };
      const count = () => host.querySelectorAll("[data-trail-group]").length;
      await update("existing");
      const hidden = host.querySelectorAll("[data-streaming-trail]").length;
      content.setMounted(true);
      const initial = count();
      await update("existing added");
      const active = count();
      content.setMounted(false);
      await update("existing added offscreen");
      content.setTrail("short");
      const unmounted = host.querySelectorAll("[data-streaming-trail]").length;
      content.setMounted(true);
      const remounted = count();
      await update("existing added offscreen resumed");
      const resumed = count();
      content.destroy();
      content.destroy();
      return {
        hidden,
        initial,
        active,
        unmounted,
        remounted,
        resumed,
        destroyed: host.querySelectorAll("[data-streaming-trail]").length,
      };
    });
    assert.deepEqual(lifecycle, {
      hidden: 0,
      initial: 0,
      active: 1,
      unmounted: 0,
      remounted: 0,
      resumed: 1,
      destroyed: 0,
    });
    // A stream whose status change and first text arrive in one update
    // builds its row with that text; the text is still new and fades in.
    const fresh = await page.evaluate(async () => {
      const { createMessageContent } = await import(
        "/demos/streaming/message-content.ts"
      );
      const host = document.querySelector("#host");
      const content = createMessageContent(host, "none", "long", true);
      const markdown = "First words";
      content.update({ markdown }, markdown, true);
      content.setMounted(true);
      const deadline = performance.now() + 2000;
      while (host.querySelector(".markdown")?.textContent !== markdown) {
        if (performance.now() > deadline)
          throw new Error("Renderer did not flush the fresh-stream fixture");
        await new Promise(requestAnimationFrame);
      }
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      const covered = window.covered("First words", host);
      const groups = host.querySelectorAll("[data-trail-group]").length;
      content.destroy();
      return { covered, groups };
    });
    assert.deepEqual(fresh, { covered: true, groups: 1 });
    await page.goto(`${base}/demos/streaming/?trail=${"long"}&fast-long`);
    await page.waitForFunction(
      (value) => document.querySelector("#trail-mode")?.value === value,
      "long",
    );
    await page.locator("#prompt").fill("fast trail prototype");
    await page.locator("#send-btn").click();
    await page.waitForFunction(
      () => document.querySelectorAll("[data-trail-group] > div").length > 0,
    );
    assert.equal(await page.locator("[data-trail-blend]").count(), 1);
    await page.waitForFunction(() =>
      document
        .getAnimations()
        .some(
          (animation) =>
            animation.effect?.pseudoElement === "::marker" &&
            animation.effect.target.closest("article.message.assistant"),
        ),
    );
    await page.screenshot({ path: `${output}/${engine.name()}-demo.png` });
    await page.evaluate(() => {
      const select = document.querySelector("#trail-mode");
      select.value = "off";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForFunction(
      () => !document.querySelector("[data-streaming-trail]"),
    );
    assert.equal(
      await page.evaluate(() =>
        document
          .getAnimations()
          .some((animation) => animation.effect?.pseudoElement === "::marker"),
      ),
      false,
      "turning the trail off also clears native list-marker animations",
    );
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: content coverage, wrapped geometry, final fade, idle reads, bounds, reduced motion, cleanup and demo toggle passed`,
    );
  } finally {
    await browser.close();
  }
}
