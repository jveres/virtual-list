// Shared setup for next's browser regressions: a dated transcript imported
// into the streaming demo through its file input.

/** A markdown transcript of `turns` alternating turns, two minutes apart. */
export function datedTranscript(turns) {
  const start = new Date(2026, 8, 2, 9, 0, 0).getTime();
  const lines = [
    "# streaming-chat transcript",
    "",
    "<!-- day -->",
    "## Day",
    "",
  ];
  for (let i = 1; i <= turns; i++) {
    lines.push(
      `**${i % 2 ? "User" : "Assistant"}**`,
      `<!-- turn {"sentAt":${start + i * 120_000}} -->`,
      "",
      `Message ${i} ${"lorem ipsum dolor sit amet ".repeat(8 + (i % 5) * 6)}`,
      "",
    );
  }
  return lines.join("\n");
}

/**
 * Open the streaming demo, import `turns` dated turns, and wait until the
 * window status matches `loaded`. Returns the page errors, collected from
 * here on. Init scripts must be added before this call.
 */
export async function openTranscript(page, base, turns, loaded) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(`${base}/demos/streaming/index.html`);
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("booting"),
  );
  await page.locator("#import-file").setInputFiles({
    name: "chat.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(datedTranscript(turns)),
  });
  await page.waitForFunction(
    (pattern) =>
      new RegExp(pattern).test(
        document.getElementById("window-status")?.textContent ?? "",
      ),
    loaded.source,
  );
  return errors;
}
