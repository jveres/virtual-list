import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, webkit, chromium]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    const dialogs = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.accept();
    });
    await page.goto(`${base}/demos/streaming/index.html`);
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    const results = await page.evaluate(async () => {
      const wrap = document.querySelector(".viewport-wrap");
      const source = document.createElement("img");
      document.body.append(source); // Also guard sources outside the drop target.
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(
        new File(["image"], "image.png", { type: "image/png" }),
      );
      const send = (target, type) =>
        target.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer,
          }),
        );
      const highlighted = () => wrap.classList.contains("drop-target");
      const results = [];
      for (const end of [
        "dragend",
        "drop",
        "outside-drop",
        "cancelled-start",
      ]) {
        if (end === "cancelled-start")
          source.addEventListener(
            "dragstart",
            (event) => {
              event.preventDefault();
              event.stopPropagation();
            },
            { once: true },
          );
        send(source, "dragstart");
        if (end !== "cancelled-start") {
          results.push(send(wrap, "dragenter"), !highlighted());
          results.push(send(wrap, "dragover"), !highlighted());
          send(wrap, "dragleave");
          results.push(send(wrap, "dragenter"), !highlighted());
          if (end === "outside-drop") {
            source.addEventListener(
              "drop",
              (event) => event.stopPropagation(),
              { once: true },
            );
            send(source, "drop");
          } else {
            results.push(send(end === "drop" ? wrap : source, end));
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        // Every termination path must allow the next external file drag.
        results.push(!send(wrap, "dragenter"), highlighted());
        results.push(!send(wrap, "dragover"));
        send(wrap, "dragleave");
        results.push(!highlighted());
      }
      // Nested external enters/leaves retain the highlight until the last leave.
      send(wrap, "dragenter");
      send(wrap, "dragenter");
      send(wrap, "dragleave");
      results.push(highlighted());
      send(wrap, "dragleave");
      results.push(!highlighted());
      source.remove();
      return results;
    });
    assert.deepEqual(
      results,
      results.map(() => true),
    );
    assert.deepEqual(
      dialogs,
      [],
      "internal file drags must not invoke import alerts",
    );
    await page.evaluate(() => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(
        new File(
          ["**User**\n\nExternal transcript drag regression marker\n"],
          "external.md",
          { type: "text/markdown" },
        ),
      );
      const wrap = document.querySelector(".viewport-wrap");
      for (const type of ["dragenter", "dragover", "drop"]) {
        wrap.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer,
          }),
        );
      }
    });
    await page
      .getByText("External transcript drag regression marker", { exact: true })
      .waitFor();
    assert.equal(await page.locator(".viewport-wrap.drop-target").count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: internal drag exclusion and external transcript import passed`,
    );
  } finally {
    await browser.close();
  }
}
