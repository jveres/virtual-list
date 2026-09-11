// Clipboard choices stay offline; FileReader and attachment validation are real.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
const draft = "Before SELECT after";
const text = `${"Long pasted text 🌻\n".repeat(35)}<script>window.pasteExecuted = true</script>`;
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    for (const width of [1200, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("https://api.openai.com/**", (route) => route.abort());
      await page.addInitScript(() => {
        const read = FileReader.prototype.readAsDataURL;
        FileReader.prototype.readAsDataURL = function (blob) {
          window.lastAttachment = blob;
          return read.call(this, blob);
        };
      });
      await page.goto(`${base}/demos/streaming/`);
      await page.waitForFunction(
        () => !document.documentElement.classList.contains("booting"),
      );
      const input = page.locator("#prompt");
      const dialog = page.getByRole("dialog", {
        name: "Attach this text instead?",
      });
      const paste = (value) =>
        input.evaluate((el, value) => {
          el.focus();
          if (value.length > 500) {
            window.largePasteClosed = false;
            document.getElementById("large-paste-dialog").addEventListener(
              "close",
              () => {
                window.largePasteClosed = true;
              },
              { once: true },
            );
          }
          const data = new DataTransfer();
          data.setData("text/plain", value);
          const event = new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
          });
          // Firefox discards data supplied to the ClipboardEvent constructor.
          Object.defineProperty(event, "clipboardData", { value: data });
          return el.dispatchEvent(event);
        }, value);
      const select = () => input.evaluate((el) => el.setSelectionRange(7, 13));
      const selection = () =>
        input.evaluate((el) => [el.selectionStart, el.selectionEnd]);
      const stored = () =>
        page.evaluate(() => localStorage.getItem("virtual-list:chat-draft"));
      // Native dialogs hide before their close event restores the selection.
      const closed = () =>
        page.waitForFunction(() => window.largePasteClosed === true);

      await input.fill(draft);
      await select();
      // Synthetic pastes have no native insertion; these assert pass-through.
      for (const length of [0, 499, 500]) {
        assert.equal(await paste("x".repeat(length)), true);
        assert.equal(await dialog.count(), 0);
      }
      assert.equal(await paste("x".repeat(501)), false);
      await dialog.waitFor();
      assert.equal(await input.inputValue(), draft);
      assert.equal(await stored(), draft);
      const box = await dialog.boundingBox();
      assert.ok(
        box.x >= 0 && box.x + box.width <= width,
        "dialog fits the viewport",
      );
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await closed();
      assert.equal(await input.inputValue(), draft);
      assert.deepEqual(await selection(), [7, 13]);
      assert.equal(
        await input.evaluate((el) => el === document.activeElement),
        true,
      );

      await paste(text);
      await dialog
        .getByRole("button", { name: "Paste text", exact: true })
        .click();
      await closed();
      const inserted = `Before ${text} after`;
      assert.equal(await input.inputValue(), inserted);
      assert.equal(await stored(), inserted);
      assert.deepEqual(await selection(), [7 + text.length, 7 + text.length]);
      assert.equal(await page.evaluate(() => window.pasteExecuted), undefined);
      assert.ok(
        await input.evaluate((el) => el.clientHeight > 60),
        "pasted draft autosizes",
      );

      // Escape after a previous Paste choice must not reuse returnValue.
      await paste(text);
      await page.keyboard.press("Escape");
      await closed();
      assert.equal(await input.inputValue(), inserted);

      await input.fill(draft);
      await select();
      await paste(text);
      await dialog
        .getByRole("button", { name: "Attach as .txt", exact: true })
        .click();
      await page.locator("#pending-attachments .attachment-name").waitFor();
      assert.equal(
        await page
          .locator("#pending-attachments .attachment-name")
          .textContent(),
        "pasted-text.txt",
      );
      assert.equal(
        await page.evaluate(() => window.lastAttachment.text()),
        text,
      );
      assert.equal(
        await page.evaluate(() => window.lastAttachment.type),
        "text/plain",
      );
      assert.equal(await input.inputValue(), draft);
      assert.equal(await stored(), draft);
      assert.deepEqual(await selection(), [7, 13]);
      assert.match(
        await page.locator("#attachment-status").textContent(),
        /stay local until you send/,
      );

      // Image clipboard handling retains precedence over its text fallback.
      await page
        .getByRole("button", { name: "Remove pasted-text.txt", exact: true })
        .click();
      await input.evaluate((el, text) => {
        const data = new DataTransfer();
        data.items.add(
          new File(
            [
              Uint8Array.from(
                atob(
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                ),
                (c) => c.charCodeAt(0),
              ),
            ],
            "clipboard",
            { type: "image/png" },
          ),
        );
        data.setData("text/plain", text);
        const event = new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(event, "clipboardData", { value: data });
        el.dispatchEvent(event);
      }, text);
      await page
        .getByRole("button", { name: "Remove pasted-image.png", exact: true })
        .waitFor();
      assert.equal(await dialog.count(), 0);
      await page
        .getByRole("button", { name: "Remove pasted-image.png", exact: true })
        .click();

      // The attachment choice uses the same ten-file limit as the picker.
      await page.locator("#attachment-files").setInputFiles(
        Array.from({ length: 10 }, (_, index) => ({
          name: `file-${index}.txt`,
          mimeType: "text/plain",
          buffer: Buffer.from("Local text"),
        })),
      );
      await page.waitForFunction(
        () =>
          document.querySelectorAll("#pending-attachments .attachment-chip")
            .length === 10,
      );
      await paste(text);
      await dialog
        .getByRole("button", { name: "Attach as .txt", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          document.getElementById("attachment-status").textContent ===
          "Attach up to 10 files per message.",
      );
      assert.equal(
        await page.locator("#pending-attachments .attachment-chip").count(),
        10,
      );
      assert.equal(await input.inputValue(), draft);
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          engine: engine.name(),
          width,
          largePaste: "passed",
          selection: "passed",
          attachmentBytes: "passed",
          limits: "passed",
        }),
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
