import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import {
  importTranscript,
  openStreamingDemo,
  waitForBoot,
} from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";

for (const engine of [firefox, webkit, chromium]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    const openTree = async () => {
      if (!(await page.locator(".conversation-tree-panel").isVisible()))
        await page
          .getByRole("button", { name: "Conversation tree", exact: true })
          .click();
    };
    const jump = async (id) => {
      await openTree();
      await page
        .locator(`.conversation-tree-node[data-message-id="${id}"]`)
        .click();
      await page.waitForFunction(
        () =>
          !document
            .querySelector(".conversation-tree-panel")
            .hasAttribute("aria-busy"),
      );
    };
    const geometry = async (prompt, reply) =>
      page.evaluate(
        ([prompt, reply]) => {
          const viewport = document.querySelector("#viewport");
          const rect = viewport.getBoundingClientRect();
          const row = (id) => {
            const element = viewport.querySelector(`[data-key="${id}"]`);
            const bounds = element?.getBoundingClientRect();
            return bounds
              ? {
                  top: bounds.top - rect.top,
                  bottom: bounds.bottom - rect.top,
                  height: bounds.height,
                }
              : null;
          };
          return {
            endGap:
              viewport.scrollHeight -
              viewport.clientHeight -
              viewport.scrollTop,
            client: viewport.clientHeight,
            prompt: row(prompt),
            reply: row(reply),
          };
        },
        [prompt, reply],
      );
    // A tail restore can briefly reach the old window's bottom before the
    // final window commits and its native animation starts.
    const waitForBottom = () =>
      page.waitForFunction(() => {
        const viewport = document.querySelector("#viewport");
        const status = document.querySelector("#window-status").textContent;
        const range = /loaded [\d,]+-([\d,]+)\/([\d,]+)/.exec(status);
        return (
          range &&
          range[1] === range[2] &&
          !status.includes("loading") &&
          Math.abs(
            viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
          ) <= 2
        );
      });
    const matches = (actual, baseline, label) => {
      assert.ok(
        Math.abs(actual.endGap) <= 2,
        `${label}: not at end ${JSON.stringify(actual)}`,
      );
      for (const role of ["prompt", "reply"]) {
        assert.equal(
          Boolean(actual[role]),
          Boolean(baseline[role]),
          `${label}: ${role} mounted`,
        );
        if (actual[role])
          assert.ok(
            Math.abs(actual[role].top - baseline[role].top) <= 2,
            `${label}: ${role} differs ${JSON.stringify({ actual, baseline })}`,
          );
      }
    };
    const errors = await openStreamingDemo(page, base, { acceptDialogs: true });
    await page.locator("#prompt").fill("A new simulated message");
    await page.locator("#send-btn").click();
    await page.waitForTimeout(2000);
    await page.locator("#send-btn").click();
    await page.waitForFunction(
      () => document.querySelector("#send-btn").textContent === "Send",
    );
    await page.locator(".message-stopped").waitFor();
    await openTree();
    // Removing the last prompt's branch and returning through an earlier
    // node must restore reserve before any explicit bottom command.
    await jump(105);
    await jump(104);
    await page.locator("#viewport").evaluate((viewport) => {
      viewport.scrollTop = viewport.scrollHeight;
    });
    const manuallyReached = await geometry(107, 108);
    assert.ok(
      Math.abs(manuallyReached.prompt.top - 40) <= 2,
      `previous node then manual bottom must retain prompt pin: ${JSON.stringify(manuallyReached)}`,
    );
    await jump(1);
    await jump(108);
    const returned = await geometry(107, 108);
    await page.waitForFunction(async () => {
      const { loadSimulatedHistory } = await import(
        "/demos/streaming/openai.ts"
      );
      const history = await loadSimulatedHistory();
      return history?.tree?.nodes.some(
        (node) => node.id === 108 && node.message.stopped === true,
      );
    });
    await page.reload();
    await waitForBoot(page);
    await page.locator(".message-stopped").waitFor();
    const reloaded = await geometry(107, 108);
    matches(returned, reloaded, "stopped return vs reload");
    assert.ok(Math.abs(reloaded.prompt.top - 40) <= 2);
    await jump(1);
    await page.locator("#scroll-bottom-btn").click();
    await waitForBottom();
    matches(await geometry(107, 108), reloaded, "bottom arrow vs reload");
    for (const sticky of [false, true]) {
      await page.locator("#ai-settings-btn").click();
      await page.locator("#sticky-toggle").setChecked(sticky);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      await page
        .locator("#ai-settings-panel")
        .evaluate((panel) => panel.close());
      if (sticky) {
        // A viewport anchor retains old space beneath the reader until they
        // navigate away. Returning must use the updated pin, not that tail.
        await jump(1);
        await jump(108);
      } else {
        await page.locator("#viewport").evaluate((viewport) => {
          viewport.scrollTop = viewport.scrollHeight;
        });
      }
      await page
        .waitForFunction(
          (inset) => {
            const viewport = document.querySelector("#viewport");
            const prompt = viewport.querySelector('[data-key="107"]');
            return (
              prompt &&
              Math.abs(
                prompt.getBoundingClientRect().top -
                  viewport.getBoundingClientRect().top -
                  inset,
              ) <= 2
            );
          },
          sticky ? 40 : 0,
          { timeout: 5000 },
        )
        .catch(async (error) => {
          throw new Error(
            `${engine.name()} sticky=${sticky}: ${JSON.stringify(await geometry(107, 108))}`,
            { cause: error },
          );
        });
    }
    console.log(
      engine.name(),
      "two-second stop, return, reload, bottom arrow, and live sticky inset PASS",
    );

    for (const long of [false, true]) {
      await page.locator("#prompt").click();
      const label = `Final ${long ? "long" : "short"} response`;
      const ending = long
        ? `${label}\n\n${"A long response paragraph. ".repeat(800)}`
        : label;
      await importTranscript(
        page,
        `**User**\n\nEarlier prompt\n\n**Assistant**\n\n${"Earlier reply. ".repeat(200)}\n\n**User**\n\nFinal prompt\n\n**Assistant**\n\n${ending}\n`,
        { name: "bottom.md" },
      );
      await page
        .locator("#viewport")
        .getByText(label, { exact: true })
        .waitFor();
      const imported = await geometry(3, 4);
      await jump(1);
      await jump(4);
      const selected = await geometry(3, 4);
      if (long) assert.ok(Math.abs(selected.reply.top - 40) <= 2);
      else matches(selected, imported, `${label} clamped return vs load`);
      await jump(1);
      await page.locator("#scroll-bottom-btn").click();
      await waitForBottom();
      matches(await geometry(3, 4), imported, `${label} bottom arrow vs load`);
      if (long)
        assert.ok(
          imported.reply.top < 40 &&
            imported.reply.bottom <= imported.client + 2,
        );
      else assert.ok(Math.abs(imported.prompt.top - 40) <= 2);
      await page.reload();
      await waitForBoot(page);
      matches(await geometry(3, 4), imported, `${label} reload vs load`);
      console.log(engine.name(), label, "PASS");
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}
