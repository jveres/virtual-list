// Offline anchoring matrix. Uses real controls; never calls an AI service.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { importTranscript, openStreamingDemo } from "../shared/transcript.mjs";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const browser = await { chromium, firefox, webkit }[engine].launch();
const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
const failures = [];
const layouts = [
  { name: "desktop", width: 1420, height: 950, sticky: true },
  { name: "tall", width: 1420, height: 1200, sticky: true },
  { name: "narrow", width: 600, height: 900, sticky: true },
  { name: "no-pill", width: 1420, height: 950, sticky: false },
];
try {
  for (const layout of layouts) {
    for (const role of ["user", "assistant"]) {
      for (const placement of ["top", "below", "footer"]) {
        const page = await browser.newPage({
          viewport: { width: layout.width, height: layout.height },
        });
        await page.route("https://api.openai.com/**", (route) => route.abort());
        try {
          const errors = await openStreamingDemo(page, base, {
            acceptDialogs: true,
          });
          await page.locator("#sticky-toggle").evaluate((el, checked) => {
            if (el.checked !== checked) el.click();
          }, layout.sticky);
          const fixture = await page.evaluate(async (role) => {
            const { branchingTranscriptMarkdown } = await import(
              "/demos/streaming/branching-transcript.ts"
            );
            const nodes = Array.from({ length: 20 }, (_, index) => ({
              id: index + 1,
              parentId: index,
              selectedChildId: index + 2,
              message: {
                role: index % 2 === 0 ? "user" : "assistant",
                markdown: `History ${index}`,
                sentAt: 1700000000000,
              },
            }));
            if (role === "assistant") {
              nodes.push({
                id: 21,
                parentId: 20,
                selectedChildId: 22,
                message: {
                  role: "user",
                  markdown: "Branch prompt",
                  sentAt: 1700000000000,
                },
              });
            }
            const id = role === "user" ? 21 : 22;
            for (const [offset, body] of [
              [
                0,
                Array.from(
                  { length: 45 },
                  (_, i) => `Long paragraph ${i}.`,
                ).join("\n\n"),
              ],
              [2, "Short version"],
              [4, ""],
            ]) {
              nodes.push({
                id: id + offset,
                parentId: id - 1,
                selectedChildId: role === "user" ? id + offset + 1 : null,
                message: {
                  role,
                  markdown: body,
                  sentAt: 1700000000000 + (offset === 2 ? 86400000 : 0),
                },
              });
              if (role === "user") {
                nodes.push({
                  id: id + offset + 1,
                  parentId: id + offset,
                  selectedChildId: null,
                  message: {
                    role: "assistant",
                    markdown: "Reply",
                    sentAt: 1700000000000 + (offset === 2 ? 86400000 : 0),
                  },
                });
              }
            }
            return branchingTranscriptMarkdown(
              { selectedRootId: 1, nodes },
              {
                dayOf: (message) => message.sentAt,
                dayLabel: () => "Fixture day",
              },
            );
          }, role);
          await importTranscript(page, fixture, { name: "anchor-matrix.md" });
          const key = role === "user" ? 21 : 22;
          const row = page.locator(`.message[data-key="${key}"]`);
          await row.waitFor();
          const inset = layout.sticky
            ? await page
                .locator(".section-header")
                .first()
                .evaluate((el) => el.getBoundingClientRect().height)
            : 0;
          const state = () =>
            page.evaluate(() => {
              const vp = document.getElementById("viewport");
              return {
                scrollTop: vp.scrollTop,
                height: vp.clientHeight,
                total: vp.scrollHeight,
                rows: [...vp.querySelectorAll(".message")]
                  .filter((r) => Number(r.dataset.key) >= 20)
                  .map((r) => ({
                    key: r.dataset.key,
                    top:
                      r.getBoundingClientRect().top -
                      vp.getBoundingClientRect().top,
                    height: r.getBoundingClientRect().height,
                  })),
              };
            });
          if (placement !== "footer") {
            await row.evaluate(
              (el, inset) => {
                const vp = document.getElementById("viewport");
                vp.scrollTop +=
                  el.getBoundingClientRect().top -
                  vp.getBoundingClientRect().top -
                  inset;
              },
              inset + (placement === "below" ? 100 : 0),
            );
          } else {
            await row
              .getByRole("button", { name: "Next version" })
              .scrollIntoViewIfNeeded();
          }
          await page.waitForTimeout(150);
          const before = await state();
          const oldTop = before.rows.find((r) => r.key === String(key)).top;
          let expected = Math.max(inset, oldTop);
          const visibleReply = before.rows.find(
            (r) => r.key === String(key + 1),
          );
          let currentKey = key;
          let firstSwitch = true;
          for (const nextKey of [key + 2, key + 4, key + 2, key, key + 2]) {
            const direction = nextKey > currentKey ? "Next" : "Previous";
            // The first footer click replaces a clipped user prompt while
            // its reply is visible: preserve that reply, not the hidden top.
            const readingReply =
              firstSwitch &&
              role === "user" &&
              placement === "footer" &&
              visibleReply?.top >= inset &&
              visibleReply.top < before.height &&
              oldTop < 0;
            const anchorKey = readingReply ? nextKey + 1 : nextKey;
            const anchorOffset = readingReply ? visibleReply.top : expected;
            // Direct activation isolates anchoring from automation's auto-scroll.
            await page
              .locator(`.message[data-key="${currentKey}"]`)
              .getByRole("button", { name: `${direction} version` })
              .evaluate((el) => el.click());
            await page.waitForTimeout(150);
            const after = await state();
            const newTop = after.rows.find(
              (r) => r.key === String(anchorKey),
            )?.top;
            assert.ok(
              Math.abs(newTop - anchorOffset) < 1,
              `${layout.name}/${role}/${placement}/${nextKey}: ${anchorOffset} → ${newTop}`,
            );
            // Every short/empty replacement must leave enough scroll surface
            // for the named coordinate, including space after the last row.
            assert.ok(after.total - after.height >= after.scrollTop - 1);
            expected = after.rows.find((r) => r.key === String(nextKey)).top;
            currentKey = nextKey;
            firstSwitch = false;
          }
          console.log(
            JSON.stringify({
              engine,
              layout: layout.name,
              role,
              placement,
              expected,
              switches: 5,
            }),
          );
          assert.deepEqual(errors, []);
        } catch (error) {
          failures.push(error.message);
        } finally {
          await page.close();
        }
      }
    }
  }
  assert.deepEqual(failures, []);
} finally {
  await browser.close();
}
