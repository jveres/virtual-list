import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [chromium, firefox, webkit]) {
  const browser = await engine.launch();
  try {
    for (const device of [
      { name: "desktop", hasTouch: false, width: 1200, height: 900 },
      { name: "phone", hasTouch: true, width: 390, height: 844 },
      { name: "tablet", hasTouch: true, width: 820, height: 1180 },
    ]) {
      const { hasTouch } = device;
      const page = await browser.newPage({
        hasTouch,
        viewport: { width: device.width, height: device.height },
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
            actionGap: style.gap,
            buttons: [...actions.querySelectorAll("button")].map((button) => {
              const buttonStyle = getComputedStyle(button);
              const rect = button.getBoundingClientRect();
              return {
                width: rect.width,
                height: rect.height,
                version: button.classList.contains("version-nav-btn"),
                tapHighlight: buttonStyle.webkitTapHighlightColor,
              };
            }),
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
        assert.equal(state.actionGap, "4px");
        assert.ok(state.buttons.length >= 3);
        for (const button of state.buttons) {
          assert.equal(button.height, 24);
          assert.equal(button.width, button.version ? 22 : 32);
          if (engine !== firefox)
            assert.equal(button.tapHighlight, "rgba(0, 0, 0, 0)");
        }
        assert.ok(Math.abs(state.bottom) < 1, JSON.stringify(state));
        assert.ok(state.gap >= -1, JSON.stringify(state));
        const disabled = row.getByRole("button", {
          name: text === "First version" ? "Previous version" : "Next version",
          exact: true,
        });
        assert.equal(await disabled.isDisabled(), true);
        const appearance = () =>
          disabled.evaluate((button) => {
            const style = getComputedStyle(button);
            return { color: style.color, background: style.backgroundColor };
          });
        const normal = await appearance();
        await disabled.hover();
        assert.deepEqual(
          await appearance(),
          normal,
          "disabled arrows have no hover ink",
        );
        for (const theme of ["Light", "Dark"]) {
          await page
            .getByRole("button", { name: `${theme} theme`, exact: true })
            .click();
          for (const selector of [
            ".message-refresh-btn",
            ".message-copy-btn",
          ]) {
            const action = row.locator(selector);
            const background = () =>
              action.evaluate(
                (button) => getComputedStyle(button).backgroundColor,
              );
            await action.hover();
            assert.equal(
              await background(),
              "rgba(0, 0, 0, 0)",
              `${theme} assistant hover stays transparent`,
            );
            await page.mouse.down();
            try {
              assert.equal(
                await background(),
                "rgba(0, 0, 0, 0)",
                `${theme} assistant press stays transparent`,
              );
            } finally {
              // Release away from the button: styling checks must not activate it.
              await page.mouse.move(0, 0);
              await page.mouse.up();
            }
          }
        }
        if (text === "First version") {
          const next = row.getByRole("button", { name: "Next version" });
          if (hasTouch) await next.tap();
          else await next.click();
        }
      }
      await page.close();
      console.log(
        JSON.stringify({
          engine: engine.name(),
          device: device.name,
          passed: true,
        }),
      );
    }
  } finally {
    await browser.close();
  }
}
