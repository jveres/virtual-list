// Shared setup for the browser regressions: boot the streaming demo and
// import transcripts through its file input.

/** Wait until the demo has finished booting. */
export function waitForBoot(page) {
  return page.waitForFunction(
    () => !document.documentElement.classList.contains("booting"),
  );
}

/**
 * Open the streaming demo at `path` and wait for it to boot. Returns the
 * page errors, collected from here on. With `acceptDialogs`, every dialog
 * is accepted. Init scripts must be added before this call.
 */
export async function openStreamingDemo(
  page,
  base,
  { path = "/demos/streaming/", acceptDialogs = false } = {},
) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (acceptDialogs) page.on("dialog", (dialog) => dialog.accept());
  await page.goto(`${base}${path}`);
  await waitForBoot(page);
  return errors;
}

/** Import `markdown` through the demo's file input as a file named `name`. */
export function importTranscript(page, markdown, { name = "chat.md" } = {}) {
  return page.locator("#import-file").setInputFiles({
    name,
    mimeType: "text/markdown",
    buffer: Buffer.from(markdown),
  });
}

/**
 * Serialize `turns` ({ role: "user" | "assistant", sentAt?, text }) as a
 * demo transcript, under a `## day` heading when `day` is set.
 */
export function transcriptMarkdown(turns, { day } = {}) {
  const lines = ["# streaming-chat transcript", ""];
  if (day) lines.push("<!-- day -->", `## ${day}`, "");
  for (const { role, sentAt, text } of turns) {
    lines.push(`**${role === "user" ? "User" : "Assistant"}**`);
    if (sentAt !== undefined)
      lines.push(`<!-- turn ${JSON.stringify({ sentAt })} -->`);
    lines.push("", text, "");
  }
  return lines.join("\n");
}

/** A markdown transcript of `turns` alternating turns, two minutes apart. */
export function datedTranscript(turns) {
  const start = new Date(2026, 8, 2, 9, 0, 0).getTime();
  return transcriptMarkdown(
    Array.from({ length: turns }, (_, index) => {
      const i = index + 1;
      return {
        role: i % 2 ? "user" : "assistant",
        sentAt: start + i * 120_000,
        text: `Message ${i} ${"lorem ipsum dolor sit amet ".repeat(8 + (i % 5) * 6)}`,
      };
    }),
    { day: "Day" },
  );
}

/**
 * 124 undated turns for paging checks: long rows, then 28 shorter ones at
 * the end, so the initial window holds only a slice of the history.
 */
export function pagingTranscript() {
  return Array.from(
    { length: 124 },
    (_, i) =>
      `**${i % 2 ? "Assistant" : "User"}**\n\nHistory turn ${i + 1}. ${"Synthetic paging content. ".repeat(i < 96 ? 100 : 20)}\n`,
  ).join("\n");
}

/**
 * Open the streaming demo, import `turns` dated turns, and wait until the
 * window status matches `loaded`. Returns the page errors, collected from
 * here on. Init scripts must be added before this call.
 */
export async function openTranscript(page, base, turns, loaded) {
  const errors = await openStreamingDemo(page, base, {
    path: "/demos/streaming/index.html",
    acceptDialogs: true,
  });
  await importTranscript(page, datedTranscript(turns));
  await page.waitForFunction(
    (pattern) =>
      new RegExp(pattern).test(
        document.getElementById("window-status")?.textContent ?? "",
      ),
    loaded.source,
  );
  return errors;
}
