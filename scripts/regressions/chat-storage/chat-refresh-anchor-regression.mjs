// Refresh always glides before replacing the old reply or requesting a new one.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
const layouts = [
  { name: "desktop", width: 1420, height: 950, sticky: true },
  { name: "tall", width: 1420, height: 1200, sticky: true },
  { name: "narrow", width: 600, height: 900, sticky: true },
  { name: "no-pill", width: 1420, height: 950, sticky: false },
].filter(
  (layout) =>
    !process.env.REFRESH_LAYOUT || layout.name === process.env.REFRESH_LAYOUT,
);
const placements = process.env.REFRESH_PLACEMENT
  ? [process.env.REFRESH_PLACEMENT]
  : [
      "pinned",
      "below",
      "partial",
      "under-pill",
      "edge-visible",
      "above",
      "footer",
    ];
const scenarios = [
  { name: "last-unpinned", landing: "end", earlier: false },
  { name: "last-pinned", landing: "prompt", earlier: false },
  { name: "earlier-reply", landing: "prompt", earlier: true },
  { name: "stopped-version", landing: "prompt", earlier: true, short: true },
].filter(
  (scenario) =>
    !process.env.REFRESH_SCENARIO ||
    scenario.name === process.env.REFRESH_SCENARIO,
);
const failures = [];
let passedCases = 0;
const browser = await { firefox, chromium, webkit }[engine].launch({
  headless: process.env.BROWSER_MATRIX_HEADED !== "1",
});
try {
  for (const layout of layouts) {
    for (const scenario of scenarios) {
      for (const placement of placements) {
        if (scenario.short && placement === "footer") continue;
        const page = await browser.newPage({ viewport: layout });
        page.setDefaultTimeout(6000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("dialog", (dialog) => dialog.accept());
        try {
          await page.addInitScript(() => {
            localStorage.setItem(
              "virtual-list:ai-settings",
              JSON.stringify({
                provider: "openai",
                apiKey: "offline-test",
                model: "gpt-5-mini",
              }),
            );
            const original = window.fetch;
            window.fetch = (input, init) => {
              if (!String(input).startsWith("https://api.openai.com/"))
                return original(input, init);
              window.refreshRequests = (window.refreshRequests ?? 0) + 1;
              return new Promise((_resolve, reject) => {
                init.signal.addEventListener(
                  "abort",
                  () => reject(new DOMException("Cancelled", "AbortError")),
                  { once: true },
                );
              });
            };
          });
          await page.goto(`${base}/demos/streaming/`);
          await page.waitForFunction(
            () => !document.documentElement.classList.contains("booting"),
          );
          await page.locator("#landing-mode").evaluate((element, value) => {
            element.value = value;
            element.dispatchEvent(new Event("change", { bubbles: true }));
          }, scenario.landing);
          await page.locator("#sticky-toggle").evaluate((element, checked) => {
            if (element.checked !== checked) element.click();
          }, layout.sticky);
          const turns = Array.from(
            { length: 20 },
            (_, index) =>
              `**${index % 2 ? "Assistant" : "User"}**\n\nHistory ${index}\n\n`,
          );
          const reply = Array.from(
            { length: 65 },
            (_, index) => `Long reply paragraph ${index}.`,
          ).join("\n\n");
          turns.push(
            `**User**\n\nRefresh anchor prompt\n\n**Assistant**\n\n${reply}\n`,
          );
          if (scenario.earlier)
            turns.push(
              "\n**User**\n\nLater prompt\n\n**Assistant**\n\nLater reply\n",
            );
          const fixture = scenario.short
            ? await page.evaluate(async () => {
                const { branchingTranscriptMarkdown } = await import(
                  "/demos/streaming/branching-transcript.ts"
                );
                const sentAt = Date.now();
                const nodes = Array.from({ length: 20 }, (_, index) => ({
                  id: index + 1,
                  parentId: index,
                  selectedChildId: index + 2,
                  message: {
                    role: index % 2 ? "assistant" : "user",
                    markdown: `History ${index}`,
                    sentAt,
                  },
                }));
                nodes.push({
                  id: 21,
                  parentId: 20,
                  selectedChildId: 24,
                  message: {
                    role: "user",
                    markdown:
                      "Refresh anchor prompt. This is looking fantastic! One last thing — can you show me some inline formatting combinations? Bold + italic + code + links all mixed together.",
                    sentAt,
                  },
                });
                for (let id = 22; id <= 25; id++)
                  nodes.push({
                    id,
                    parentId: 21,
                    selectedChildId: id === 24 ? 26 : null,
                    message: {
                      role: "assistant",
                      markdown:
                        id === 24 ? "Good question." : `Version ${id - 21}`,
                      stopped: id === 24,
                      sentAt,
                      toolCalls:
                        id === 24
                          ? ["inspect_layout", "rank_options"].map((name) => ({
                              name,
                              status: "done",
                              durationMs: 55,
                              input: "",
                              output: "",
                            }))
                          : [],
                    },
                  });
                nodes.push({
                  id: 26,
                  parentId: 24,
                  selectedChildId: 27,
                  message: { role: "user", markdown: "fast", sentAt },
                });
                nodes.push({
                  id: 27,
                  parentId: 26,
                  selectedChildId: null,
                  message: {
                    role: "assistant",
                    markdown: "Later reply",
                    sentAt,
                  },
                });
                return branchingTranscriptMarkdown(
                  { selectedRootId: 1, nodes },
                  {
                    dayOf: (message) => message.sentAt,
                    dayLabel: () => "Today",
                  },
                );
              })
            : turns.join("");
          await page.locator("#import-file").setInputFiles({
            name: "refresh-anchor.md",
            mimeType: "text/markdown",
            buffer: Buffer.from(fixture),
          });
          const refresh = page
            .locator(".message.assistant")
            .filter({
              hasText: scenario.short
                ? "Good question."
                : "Long reply paragraph 0.",
            })
            .locator(".message-refresh-btn");
          await refresh.waitFor({ state: "attached" });
          const inset = layout.sticky
            ? await page
                .locator(".section-header")
                .first()
                .evaluate((el) => el.getBoundingClientRect().height)
            : 0;
          if (placement === "footer") {
            await refresh.scrollIntoViewIfNeeded();
            await refresh.evaluate((button) => {
              const vp = document.getElementById("viewport");
              vp.scrollTop +=
                button.getBoundingClientRect().top -
                vp.getBoundingClientRect().top -
                vp.clientHeight * 0.65;
            });
            await page.waitForTimeout(150);
            const box = await refresh.boundingBox();
            // Earlier replies reveal their controls when the content is hovered.
            await page.mouse.move(box.x + 8, box.y - 8);
            await refresh.hover();
          } else {
            // Start just above the long reply so its prompt is mounted.
            await refresh.evaluate((button) => {
              const vp = document.getElementById("viewport");
              vp.scrollTop +=
                button.closest(".message").getBoundingClientRect().top -
                vp.getBoundingClientRect().top -
                300;
            });
            const prompt = page
              .locator(".message.user")
              .filter({ hasText: "Refresh anchor prompt" });
            await prompt.waitFor({ state: "attached" });
            await prompt.evaluate(
              (el, { inset, placement }) => {
                const vp = document.getElementById("viewport");
                const offset =
                  placement === "above" ||
                  placement === "edge-visible" ||
                  placement === "under-pill"
                    ? -Math.ceil(el.getBoundingClientRect().height) +
                      (placement === "edge-visible"
                        ? 1
                        : placement === "under-pill"
                          ? 20
                          : 0)
                    : placement === "partial"
                      ? -24
                      : inset + (placement === "below" ? 120 : 0);
                vp.scrollTop +=
                  el.getBoundingClientRect().top -
                  vp.getBoundingClientRect().top -
                  offset;
              },
              { inset, placement },
            );
          }
          await page.waitForTimeout(250);
          if (scenario.short) {
            const box = await refresh.boundingBox();
            await page.mouse.move(box.x + 8, box.y - 8);
            await refresh.hover();
          }
          const before = await page.evaluate((short) => {
            const vp = document.getElementById("viewport");
            const row = [...vp.querySelectorAll(".message.assistant")].find(
              (el) =>
                el.textContent.includes(
                  short ? "Good question." : "Long reply paragraph 0.",
                ),
            );
            const prompt = [...vp.querySelectorAll(".message.user")].find(
              (el) => el.textContent.includes("Refresh anchor prompt"),
            );
            return {
              scrollTop: vp.scrollTop,
              promptTop: prompt
                ? prompt.getBoundingClientRect().top -
                  vp.getBoundingClientRect().top
                : null,
              promptBottom: prompt
                ? prompt.getBoundingClientRect().bottom -
                  vp.getBoundingClientRect().top
                : null,
              replyTop:
                row.getBoundingClientRect().top -
                vp.getBoundingClientRect().top,
              height: vp.clientHeight,
            };
          }, !!scenario.short);
          if (placement === "footer") {
            assert.ok(
              before.replyTop < -before.height,
              "the long reply starts more than a viewport above the visible refresh control",
            );
            assert.ok(
              before.promptTop === null || before.promptTop < -before.height,
              "the prompt starts far above the viewport",
            );
          }
          if (placement === "above") {
            assert.ok(
              before.promptBottom <= 0,
              "the boundary fixture is fully above the viewport",
            );
          }
          await page.evaluate(() => {
            window.refreshAnchorSamples = [];
            window.sampleRefreshAnchor = true;
            window.refreshActivated = false;
            const capture = () => {
              const vp = document.getElementById("viewport");
              const prompt = [...vp.querySelectorAll(".message.user")].find(
                (el) => el.textContent.includes("Refresh anchor prompt"),
              );
              window.refreshAnchorSamples.push({
                afterClick: window.refreshActivated,
                scrollTop: vp.scrollTop,
                generating: !!vp.querySelector(
                  ".message.assistant.is-streaming",
                ),
                requested: (window.refreshRequests ?? 0) > 0,
                top: prompt
                  ? prompt.getBoundingClientRect().top -
                    vp.getBoundingClientRect().top
                  : null,
              });
            };
            document.addEventListener("click", (event) => {
              if (!event.target.closest(".message-refresh-btn")) return;
              window.refreshActivated = true;
              capture();
            });
            const sample = () => {
              capture();
              if (window.sampleRefreshAnchor) requestAnimationFrame(sample);
            };
            sample();
          });
          if (placement === "footer" || scenario.short) {
            // A physical click without Playwright scrolling the prompt into view.
            const box = await refresh.boundingBox();
            await page.mouse.click(
              box.x + box.width / 2,
              box.y + box.height / 2,
            );
          } else {
            await refresh.evaluate((button) => button.click());
          }
          await page.waitForFunction(
            () => window.refreshRequests === 1,
            undefined,
            { timeout: 4000 },
          );
          await page.waitForTimeout(100);
          const samples = await page.evaluate(() => {
            window.sampleRefreshAnchor = false;
            return window.refreshAnchorSamples.filter(
              (sample) => sample.afterClick,
            );
          });
          const positions = samples
            .map((sample) => sample.top)
            .filter((top) => top !== null);
          console.log(
            JSON.stringify({
              engine,
              layout: layout.name,
              scenario: scenario.name,
              placement,
              inset,
              before,
              first: positions[0],
              last: positions.at(-1),
              samples: positions.length,
            }),
          );
          const start = before.promptTop ?? -Infinity;
          assert.ok(
            positions.length > 1,
            "the refreshed prompt is observed during its scroll",
          );
          assert.ok(
            samples.every(
              (sample) =>
                !(sample.generating || sample.requested) ||
                (sample.top !== null && Math.abs(sample.top - inset) < 1),
            ),
            "the old reply is replaced and generation starts only after landing",
          );
          assert.ok(
            positions.every((top) => top <= Math.max(inset, start) + 1),
            "refresh must never teleport the prompt below both its old coordinate and its destination",
          );
          assert.ok(
            Math.abs(positions.at(-1) - inset) < 1,
            "refresh lands at the prompt inset",
          );
          if (placement === "pinned")
            assert.ok(
              positions.every((top) => Math.abs(top - inset) < 1),
              "an already pinned prompt remains stationary",
            );
          if (placement !== "pinned") {
            assert.ok(
              Math.abs(samples[0].scrollTop - before.scrollTop) < 1,
              "refresh starts at the exact old scroll coordinate",
            );
            // Virtualization can rebase absolute scrollTop when the reply is
            // replaced. Check the visible prompt coordinate, not that origin.
            const direction = positions[0] < inset ? 1 : -1;
            assert.ok(
              positions.every(
                (top, index) =>
                  index === 0 || direction * (top - positions[index - 1]) >= -1,
              ),
              "refresh motion must be monotonic toward the inset",
            );
            assert.ok(
              positions.some(
                (top) =>
                  Math.abs(top - inset) > 2 && Math.abs(top - positions[0]) > 2,
              ),
              "both visible and offscreen prompts animate rather than snap",
            );
          }
          assert.deepEqual(errors, []);
          passedCases++;
        } catch (error) {
          failures.push(
            `${layout.name}/${scenario.name}/${placement}: ${error.message}`,
          );
        } finally {
          await page.close();
        }
      }
    }
  }
  assert.deepEqual(failures, []);
  console.log(
    JSON.stringify({
      engine,
      refreshAnchors: "passed",
      cases: passedCases,
    }),
  );
} finally {
  await browser.close();
}
