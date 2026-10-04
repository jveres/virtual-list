// Bounded exhaustive matrix over the default conversation's valid version states.
// Each case runs in sequence in the same document so retained state carries over.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
const states = [
  ...[1, 2, 3].flatMap((reply) =>
    [false, true].map((expanded) => ({ prompt: 1, reply, expanded })),
  ),
  { prompt: 2, reply: 1, expanded: false },
];
const placements = ["pin", "clipped", "middle", "bottom"];
const engines = { chromium, firefox, webkit };
const selected = process.env.BROWSER_ENGINE;
assert.ok(!selected || Object.hasOwn(engines, selected));
for (const [engine, type] of Object.entries(engines)) {
  if (selected && selected !== engine) continue;
  const browser = await type.launch();
  let cases = 0;
  try {
    const page = await browser.newPage({
      viewport: { width: 1920, height: 962 },
      deviceScaleFactor: 2,
    });
    const errors = await openStreamingDemo(page, base);
    const row = (role) => page.locator(`.message.${role}`).last();
    const frame = () =>
      page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
    const version = async (role, desired) => {
      for (let tries = 0; tries < 3; tries++) {
        const nav = row(role).locator(".version-nav");
        const current = (await nav.count())
          ? Number((await nav.textContent()).match(/\d+/)[0])
          : 1;
        if (current === desired) return;
        await row(role)
          .getByRole("button", {
            name: `${current < desired ? "Next" : "Previous"} version`,
          })
          .evaluate((button) => button.click());
        await frame();
      }
      throw new Error(`Could not select ${role} version ${desired}`);
    };
    const disclosure = async (expanded) => {
      const button = row("user").locator(".user-message-toggle");
      if (
        ((await button.getAttribute("aria-expanded")) === "true") !==
        expanded
      ) {
        await button.evaluate((button) => button.click());
        await frame();
      }
    };
    const snapshot = () =>
      page.evaluate(() => {
        const viewport = document.getElementById("viewport");
        const origin = viewport.getBoundingClientRect().top;
        const user = [...viewport.querySelectorAll(".message.user")].at(-1);
        const assistant = [
          ...viewport.querySelectorAll(".message.assistant"),
        ].at(-1);
        const rect = (el) => ({
          key: el.dataset.key,
          top: el.getBoundingClientRect().top - origin,
          height: el.getBoundingClientRect().height,
        });
        const prompt = rect(user);
        const reply = rect(assistant);
        const contentEnd =
          assistant.parentElement.getBoundingClientRect().bottom -
          origin +
          viewport.scrollTop;
        const canonicalEnd = Math.max(
          0,
          viewport.scrollTop + prompt.top - 40,
          contentEnd - viewport.clientHeight,
        );
        return {
          prompt,
          reply,
          top: viewport.scrollTop,
          max: viewport.scrollHeight - viewport.clientHeight,
          canonicalEnd,
          height: viewport.clientHeight,
        };
      });
    const waitAtEnd = async (label) => {
      try {
        await page.waitForFunction(
          () => {
            const viewport = document.getElementById("viewport");
            const origin = viewport.getBoundingClientRect().top;
            const prompt = [...viewport.querySelectorAll(".message.user")].at(
              -1,
            );
            const reply = [
              ...viewport.querySelectorAll(".message.assistant"),
            ].at(-1);
            const end = Math.max(
              0,
              viewport.scrollTop +
                prompt.getBoundingClientRect().top -
                origin -
                40,
              viewport.scrollTop +
                reply.parentElement.getBoundingClientRect().bottom -
                origin -
                viewport.clientHeight,
            );
            return (
              Math.abs(viewport.scrollTop - end) <= 1 &&
              Math.abs(
                viewport.scrollHeight -
                  viewport.clientHeight -
                  viewport.scrollTop,
              ) <= 1
            );
          },
          undefined,
          { timeout: 2500 },
        );
        await frame();
      } catch {
        throw new Error(
          `${label}: end did not settle ${JSON.stringify(await snapshot())}`,
        );
      }
    };
    for (const state of states) {
      const actions = [
        "prompt",
        ...(state.prompt === 1
          ? [
              "toggle",
              ...(state.reply < 3 ? ["reply-next"] : []),
              ...(state.reply > 1 ? ["reply-previous"] : []),
            ]
          : []),
      ];
      for (const placement of placements)
        for (const action of actions) {
          const label = `${engine}/${JSON.stringify(state)}/${placement}/${action}`;
          await version("user", state.prompt);
          await version("assistant", state.reply);
          await disclosure(state.expanded);
          await page.waitForTimeout(180);
          await row("user").evaluate((row, placement) => {
            const viewport = document.getElementById("viewport");
            if (placement === "bottom")
              viewport.scrollTop = viewport.scrollHeight;
            else
              viewport.scrollTop +=
                row.getBoundingClientRect().top -
                viewport.getBoundingClientRect().top -
                { pin: 40, clipped: -24, middle: 200 }[placement];
          }, placement);
          await page.waitForTimeout(180);
          const before = await snapshot();
          if (action === "toggle") await disclosure(!state.expanded);
          else if (action === "prompt")
            await version("user", state.prompt === 1 ? 2 : 1);
          else
            await version(
              "assistant",
              state.reply + (action === "reply-next" ? 1 : -1),
            );
          await page.waitForTimeout(200);
          const after = await snapshot();
          const part = action.startsWith("reply") ? "reply" : "prompt";
          const old = before[part];
          const next = after[part];
          if (old.top < before.height && old.top + old.height > 40) {
            const restoresPin =
              action === "toggle" && state.expanded && old.top < 0;
            const readingOffset = old.top + next.height <= 40 ? 40 : old.top;
            const expectedOffset =
              action === "toggle"
                ? restoresPin
                  ? 40
                  : old.top
                : Math.max(
                    readingOffset,
                    after.top + next.top - after.canonicalEnd,
                  );
            if (old.top + next.height > 40)
              assert.ok(
                Math.abs(next.top - expectedOffset) <= 1,
                `${label}: reading jump ${JSON.stringify({ before, after })}`,
              );
            else
              assert.ok(
                next.top + next.height > 0 && next.top < after.height,
                `${label}: replacement disappeared`,
              );
          }
          // A bottom command must land at content/the pin, not retained reading space.
          await page
            .locator("#scroll-bottom-btn")
            .evaluate((button) => button.click());
          await waitAtEnd(label);
          const end = await snapshot();
          assert.ok(
            Math.abs(end.top - end.canonicalEnd) <= 1,
            `${label}: bottom command landed in retained space ${JSON.stringify(end)}`,
          );
          // Repeated gesture round trips must retire temporary space and return to the same end.
          await page.locator("#viewport").hover();
          for (let repeat = 0; repeat < 2; repeat++) {
            const startTop = await page
              .locator("#viewport")
              .evaluate((v) => v.scrollTop);
            await page.mouse.wheel(0, -500);
            // Firefox wheel input is asynchronous; observe actual travel
            // before reversing instead of accepting an unmoved capture.
            await page.waitForFunction(
              (start) =>
                document.getElementById("viewport").scrollTop < start - 250,
              startTop,
            );
            await page.mouse.wheel(0, 1000);
            await waitAtEnd(label);
            const returned = await snapshot();
            assert.ok(
              Math.abs(returned.top - returned.canonicalEnd) <= 1,
              `${label}: gesture returned to retained space ${JSON.stringify(returned)}`,
            );
          }
          // Close the scripted input phase explicitly at the case boundary.
          // Firefox automation can omit the protected-edge scrollend marker.
          await page
            .locator("#viewport")
            .evaluate((v) => v.dispatchEvent(new Event("scrollend")));
          await page.waitForTimeout(200);
          cases++;
          if (cases % 12 === 0)
            console.log(`${engine}: ${cases} combinations passed`);
        }
    }
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({ engine, combinations: cases, status: "passed" }),
    );
  } finally {
    await browser.close();
  }
}
