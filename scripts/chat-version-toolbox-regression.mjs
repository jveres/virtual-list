import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [chromium, firefox, webkit]) {
  const browser = await engine.launch();
  try {
    for (const hasTouch of [false, true]) {
      const page = await browser.newPage({
        hasTouch,
        viewport: hasTouch
          ? { width: 390, height: 844 }
          : { width: 1200, height: 900 },
      });
      page.on("dialog", (dialog) => dialog.accept());
      await page.goto(`${base}/demos/streaming/`);
      await page.waitForFunction(
        () => !document.documentElement.classList.contains("booting"),
      );
      const fixture = await page.evaluate(async () => {
        const { branchingTranscriptMarkdown } = await import(
          "/demos/streaming/branching-transcript.ts"
        );
        const turns = [
          [1, 0, 2, "user", "Question"],
          [2, 1, 4, "assistant", "First version"],
          [3, 1, 6, "assistant", "Second version"],
          [4, 2, 5, "user", "Follow up one"],
          [5, 4, null, "assistant", "Latest one"],
          [6, 3, 7, "user", "Follow up two"],
          [7, 6, null, "assistant", "Latest two"],
        ];
        return branchingTranscriptMarkdown(
          {
            selectedRootId: 1,
            nodes: turns.map(
              ([id, parentId, selectedChildId, role, markdown]) => ({
                id,
                parentId,
                selectedChildId,
                message: { role, markdown },
              }),
            ),
          },
          { dayOf: () => 0, dayLabel: () => "Today" },
        );
      });
      await page.locator("#import-file").setInputFiles({
        name: "toolbox-versions.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(fixture),
      });
      for (const text of ["First version", "Second version"]) {
        const row = page
          .locator(".message.assistant")
          .filter({ has: page.getByText(text, { exact: true }) });
        await row.waitFor();
        await page.mouse.move(0, 0);
        await page.locator("#prompt").focus();
        const state = await row.evaluate((message) => {
          const actions = message.querySelector(".message-actions");
          const style = getComputedStyle(actions);
          const bounds = actions.getBoundingClientRect();
          return {
            latest: actions.hasAttribute("data-latest"),
            opacity: style.opacity,
            visibility: style.visibility,
            pointerEvents: style.pointerEvents,
            bottom: bounds.bottom - message.getBoundingClientRect().bottom,
            gap:
              bounds.top -
              message.querySelector(".message-content").getBoundingClientRect()
                .bottom,
          };
        });
        assert.equal(state.latest, false);
        assert.equal(state.opacity, "1");
        assert.equal(state.visibility, "visible");
        assert.equal(state.pointerEvents, "auto");
        assert.ok(Math.abs(state.bottom) < 1, JSON.stringify(state));
        assert.ok(state.gap >= -1, JSON.stringify(state));
        if (text === "First version")
          await row
            .getByRole("button", { name: "Next version" })
            .evaluate((button) => button.click());
      }
      await page.close();
      console.log(
        JSON.stringify({ engine: engine.name(), hasTouch, passed: true }),
      );
    }
  } finally {
    await browser.close();
  }
}
