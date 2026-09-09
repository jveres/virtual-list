import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
const userText = `A **long prompt** with the full source preserved.\n\n${Array.from({ length: 20 }, (_, index) => `Requirement ${index + 1}: preserve this text when copying.`).join("\n\n")}`;
const assistantText =
  "## Answer\n\nKeep **formatting** and `code` intact.\n\n```ts\nconst answer = 42;\n```";

for (const engine of [chromium, firefox, webkit]) {
  const browser = await engine.launch();
  try {
    for (const mode of ["clipboard", "fallback", "denied"]) {
      const page = await browser.newPage({
        viewport: { width: 1200, height: 900 },
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("dialog", (dialog) => dialog.accept());
      await page.addInitScript((mode) => {
        window.copiedMessages = [];
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value:
            mode === "fallback"
              ? undefined
              : {
                  async writeText(text) {
                    if (mode === "denied")
                      throw new DOMException("Denied", "NotAllowedError");
                    window.copiedMessages.push(text);
                  },
                },
        });
        document.execCommand = (command) => {
          if (command !== "copy" || mode === "denied") return false;
          window.copiedMessages.push(document.activeElement.value);
          return true;
        };
      }, mode);
      await page.goto(`${base}/demos/streaming/`);
      await page.waitForFunction(
        () => !document.documentElement.classList.contains("booting"),
      );
      await page.locator("#import-file").setInputFiles({
        name: "copy-messages.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(
          `**User**\n\n${userText}\n\n**Assistant**\n\n${assistantText}\n`,
        ),
      });
      await page.getByText("Answer", { exact: true }).waitFor();
      const user = page.locator(".message.user").last();
      const assistant = page.locator(".message.assistant").last();
      const classes = (buttons) =>
        buttons.evaluateAll((elements) => elements.map((el) => el.className));
      assert.deepEqual(
        await classes(user.locator(".message-user-actions button")),
        ["message-delete-btn", "message-copy-btn", "message-edit-btn"],
      );
      assert.deepEqual(
        await classes(assistant.locator(".message-actions > button")),
        ["message-refresh-btn", "message-copy-btn"],
      );
      assert.equal(
        await user
          .locator(".user-message-body")
          .evaluate((el) => el.classList.contains("is-collapsed")),
        true,
      );
      await page.locator("#prompt").fill("Keep my draft");
      for (const [row, text] of [
        [user, userText],
        [assistant, assistantText],
      ]) {
        await row.locator(".message-content").hover();
        const button = row.locator(".message-copy-btn");
        const top = await row.evaluate((el) => el.getBoundingClientRect().top);
        await button.click();
        const status = page.locator("#message-copy-status");
        await page.waitForFunction(
          () =>
            document.getElementById("message-copy-status").textContent !== "",
        );
        if (mode === "denied") {
          assert.match(await status.textContent(), /Could not copy/);
          assert.equal(
            await button.getAttribute("aria-label"),
            "Could not copy message",
          );
          assert.deepEqual(
            await page.evaluate(() => window.copiedMessages),
            [],
          );
        } else {
          assert.equal(
            await status.textContent(),
            "Message copied to clipboard.",
          );
          assert.equal(await button.getAttribute("aria-label"), "Copied");
          assert.equal(
            await page.evaluate(() => window.copiedMessages.at(-1)),
            text,
          );
        }
        assert.ok(
          Math.abs(
            (await row.evaluate((el) => el.getBoundingClientRect().top)) - top,
          ) < 1,
          "copying does not move the message",
        );
        assert.equal(
          await page.locator("#prompt").inputValue(),
          "Keep my draft",
        );
        assert.equal(
          await page.locator("textarea[readonly]").count(),
          0,
          "fallback input is removed",
        );
      }
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          engine: engine.name(),
          mode,
          copy: "passed",
          toolbarOrder: "passed",
        }),
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
