import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [chromium, firefox, webkit]) {
  const browser = await engine.launch();
  try {
    for (const device of [
      { name: "desktop", width: 1200, height: 900, hasTouch: false },
      { name: "phone", width: 390, height: 844, hasTouch: true },
      { name: "tablet", width: 820, height: 1180, hasTouch: true },
    ]) {
      const page = await browser.newPage({
        viewport: { width: device.width, height: device.height },
        hasTouch: device.hasTouch,
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("dialog", (dialog) => dialog.accept());
      await page.route("https://api.openai.com/**", (route) => route.abort());
      await page.goto(`${base}/demos/streaming/`);
      await page.waitForFunction(
        () => !document.documentElement.classList.contains("booting"),
      );
      const row = page.locator(".message.user").last();
      const key = await row.getAttribute("data-key");
      const snapshot = () =>
        row.evaluate((message) => {
          const body = message.querySelector(".user-message-body");
          const markdown = body.querySelector(".markdown");
          const toggle = message.querySelector(".user-message-toggle");
          const versions = message.querySelector(".version-nav");
          const bubble = message.querySelector(".message-content");
          const rect = (el) => el.getBoundingClientRect();
          const center = (el) => rect(el).top + rect(el).height / 2;
          return {
            top: rect(message).top,
            bodyHeight: rect(body).height,
            fullHeight: rect(markdown).height,
            limit: Number.parseFloat(getComputedStyle(markdown).lineHeight) * 5,
            mask: getComputedStyle(body).maskImage,
            expanded: toggle.getAttribute("aria-expanded"),
            footerAlignment: Math.abs(center(toggle) - center(versions)),
            horizontalCenter: Math.abs(
              rect(toggle).left +
                rect(toggle).width / 2 -
                (rect(bubble).left + rect(bubble).width / 2),
            ),
            controlsGap: rect(versions).left - rect(toggle).right,
            text: markdown.textContent,
          };
        });
      const initial = await snapshot();
      assert.equal(initial.expanded, "false");
      assert.ok(initial.fullHeight > initial.limit + 1);
      assert.ok(Math.abs(initial.bodyHeight - initial.limit) < 1);
      assert.match(initial.mask, /linear-gradient/);
      assert.ok(
        initial.footerAlignment < 1,
        "toggle and versions share one row",
      );
      assert.ok(
        initial.horizontalCenter < 1,
        "toggle is centered in the full message bubble",
      );
      assert.ok(
        initial.controlsGap >= 0,
        "toggle does not overlap version controls",
      );
      assert.match(
        initial.text,
        /implementation details you would prioritize first/,
      );
      const toggle = row.locator(".user-message-toggle");
      const nextVersion = row.getByRole("button", {
        name: "Next version",
        exact: true,
      });
      const appearance = (button) =>
        button.evaluate((el) => {
          const style = getComputedStyle(el);
          const svg = el.querySelector("svg");
          const iconStyle = getComputedStyle(svg);
          return {
            width: style.width,
            height: style.height,
            color: style.color,
            background: style.backgroundColor,
            radius: style.borderRadius,
            iconWidth: iconStyle.width,
            iconHeight: iconStyle.height,
            viewBox: svg.getAttribute("viewBox"),
            path: svg.querySelector("path").getAttribute("d"),
            stroke: svg.querySelector("path").getAttribute("stroke-width"),
          };
        });
      for (const theme of ["Light", "Dark"]) {
        await page
          .getByRole("button", { name: `${theme} theme`, exact: true })
          .click();
        await page.mouse.move(0, 0);
        assert.deepEqual(
          await appearance(toggle),
          await appearance(nextVersion),
          `${theme} normal toggle styling matches version navigation`,
        );
        if (!device.hasTouch) {
          await toggle.hover();
          const hovered = await appearance(toggle);
          await nextVersion.hover();
          assert.deepEqual(
            hovered,
            await appearance(nextVersion),
            `${theme} hover toggle styling matches version navigation`,
          );
          const previous = row.getByRole("button", {
            name: "Previous version",
            exact: true,
          });
          const disabled = await appearance(previous);
          await previous.hover();
          assert.deepEqual(
            await appearance(previous),
            disabled,
            `${theme} disabled arrow has no hover ink`,
          );
          await page.mouse.move(0, 0);
          await row.locator(".message-content").hover();
          for (const selector of [".message-edit-btn", ".message-delete-btn"]) {
            const action = row.locator(selector);
            await action.hover();
            assert.equal(
              await action.evaluate(
                (el) => getComputedStyle(el).backgroundColor,
              ),
              "rgba(0, 0, 0, 0)",
              `${theme} edit/delete hover stays transparent`,
            );
          }
          await page.mouse.move(0, 0);
        }
      }

      // Edit first, before any disclosure has disengaged end-follow.
      await page.evaluate((key) => {
        window.editSamples = [];
        window.sampleEdit = true;
        const sample = () => {
          const message = document.querySelector(`.message[data-key="${key}"]`);
          if (message)
            window.editSamples.push(message.getBoundingClientRect().top);
          if (window.sampleEdit) requestAnimationFrame(sample);
        };
        sample();
      }, key);
      await row
        .locator(".message-edit-btn")
        .evaluate((button) => button.click());
      await page.waitForTimeout(650);
      assert.equal(await row.locator(".message-edit-input").count(), 1);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(350);
      const editTops = await page.evaluate(() => {
        window.sampleEdit = false;
        return window.editSamples;
      });
      assert.ok(editTops.length > 10);
      assert.ok(
        editTops.every((top) => Math.abs(top - initial.top) < 1),
        `opening/cancelling edit moved the prompt: ${JSON.stringify({ initial: initial.top, editTops })}`,
      );

      // Re-arm end-follow so the disclosure check still covers the boot policy.
      await page
        .locator("#scroll-bottom-btn")
        .evaluate((button) => button.click());
      await page.waitForTimeout(500);
      // Expansion must retain the prompt on every frame, not merely return
      // there afterward.
      await page.evaluate((key) => {
        window.collapseSamples = [];
        window.sampleCollapse = true;
        const sample = () => {
          const message = document.querySelector(`.message[data-key="${key}"]`);
          if (message)
            window.collapseSamples.push(message.getBoundingClientRect().top);
          if (window.sampleCollapse) requestAnimationFrame(sample);
        };
        sample();
      }, key);
      const expand = row.getByRole("button", {
        name: "Expand message",
        exact: true,
      });
      if (device.hasTouch) await expand.tap();
      else await expand.click();
      await page.waitForTimeout(750);
      const expanded = await snapshot();
      assert.equal(expanded.expanded, "true");
      assert.ok(Math.abs(expanded.bodyHeight - expanded.fullHeight) < 1);
      assert.equal(expanded.mask, "none");
      // Do not let automation scroll a below-screen collapse button into view.
      await row
        .getByRole("button", { name: "Collapse message", exact: true })
        .evaluate((button) => button.click());
      await page.waitForTimeout(500);
      const collapsed = await snapshot();
      assert.equal(collapsed.expanded, "false");
      assert.equal(
        collapsed.text,
        initial.text,
        "collapse never truncates stored text",
      );
      const tops = await page.evaluate(() => {
        window.sampleCollapse = false;
        return window.collapseSamples;
      });
      assert.ok(tops.length > 10);
      assert.ok(
        tops.every((top) => Math.abs(top - initial.top) < 1),
        `expansion/collapse moved the prompt: ${JSON.stringify({ initial: initial.top, tops })}`,
      );

      // Editing exposes the full source, then restores the collapsed display.
      await row
        .locator(".message-edit-btn")
        .evaluate((button) => button.click());
      const editor = page.getByRole("textbox", {
        name: "Edit user message",
        exact: true,
      });
      assert.match(
        await editor.textContent(),
        /implementation details you would prioritize first/,
      );
      assert.equal(
        await row.locator(".user-message-footer").isVisible(),
        false,
      );
      assert.equal(
        await row
          .locator(".user-message-body")
          .evaluate((el) => el.classList.contains("is-collapsed")),
        false,
      );
      await editor.press("Escape");
      assert.equal(
        await row
          .getByRole("button", { name: "Expand message", exact: true })
          .isVisible(),
        true,
      );

      // The control is absent for short and exactly-five-line text; only text
      // beyond the fifth line is faded. Version controls are independent.
      for (const lines of [1, 5, 6]) {
        await page.locator("#import-file").setInputFiles({
          name: "line-limit.md",
          mimeType: "text/markdown",
          buffer: Buffer.from(
            `**User**\n\n${Array.from({ length: lines }, (_, index) => `Line ${index + 1}`).join("  \n")}\n\n**Assistant**\n\nShort reply\n`,
          ),
        });
        await page.getByText("Short reply", { exact: true }).waitFor();
        const toggle = page.locator(".message.user .user-message-toggle");
        assert.equal(await toggle.isVisible(), lines > 5);
        const body = page.locator(".message.user .user-message-body");
        assert.equal(
          await body.evaluate((el) => el.classList.contains("is-collapsed")),
          lines > 5,
        );
      }
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          engine: engine.name(),
          device: device.name,
          collapse: "passed",
          anchor: "passed",
          footer: "passed",
          edit: "passed",
        }),
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
