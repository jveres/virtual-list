import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";

for (const engine of [firefox, webkit, chromium]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    const results = await page.evaluate(async () => {
      const { createConversationTree } = await import(
        "/demos/streaming/conversation-tree.ts"
      );
      function fixture() {
        const host = document.createElement("div");
        const viewport = document.createElement("div");
        host.append(viewport);
        document.body.append(host);
        const tree = new Map([
          [
            0,
            {
              message: null,
              parentId: 0,
              childrenIds: [1],
              selectedChildIndex: 0,
            },
          ],
          [
            1,
            {
              message: { id: 1, role: "user", markdown: "Root" },
              parentId: 0,
              childrenIds: [2],
              selectedChildIndex: 0,
            },
          ],
          [
            2,
            {
              message: { id: 2, role: "assistant", markdown: "Reply" },
              parentId: 1,
              childrenIds: [],
              selectedChildIndex: 0,
            },
          ],
        ]);
        let hostReads = 0;
        const pending = [];
        const api = createConversationTree({
          host,
          viewport,
          tree,
          isLoaded: () => {
            hostReads++;
            return true;
          },
          currentMessage: () => {
            hostReads++;
            return 1;
          },
          headings: () => {
            hostReads++;
            return [];
          },
          navigate: () =>
            new Promise((resolve, reject) => pending.push({ resolve, reject })),
        });
        host.querySelector(".conversation-tree-toggle").click();
        const panel = host.querySelector(".conversation-tree-panel");
        return {
          api,
          pending,
          panel,
          reads: () => hostReads,
          click: () =>
            host
              .querySelector('.conversation-tree-node[data-message-id="2"]')
              .click(),
          dispose: () => {
            api.dispose();
            host.remove();
          },
        };
      }
      const settle = async () => {
        await Promise.resolve();
        await Promise.resolve();
      };
      const results = [];
      for (const outcome of ["success", "refused", "error"]) {
        const f = fixture();
        try {
          f.click();
          f.api.reset();
          const resetBusy = f.panel.hasAttribute("aria-busy");
          f.click();
          const acceptedNewNavigation = f.pending.length === 2;
          const newStatus = f.panel.querySelector(
            ".conversation-tree-status",
          ).textContent;
          if (outcome === "error")
            f.pending[0].reject(new Error("Old navigation failed"));
          else f.pending[0].resolve(outcome === "success");
          await settle();
          const staleResultIgnored =
            f.panel.querySelector('[aria-current="location"]')?.dataset
              .messageId === "1" &&
            f.panel.hasAttribute("aria-busy") &&
            f.panel.querySelector(".conversation-tree-status").textContent ===
              newStatus;
          f.pending[1]?.resolve(true);
          await settle();
          results.push({
            outcome,
            resetBusy,
            acceptedNewNavigation,
            staleResultIgnored,
            newNavigationFinished:
              !f.panel.hasAttribute("aria-busy") &&
              f.panel.querySelector('[aria-current="location"]')?.dataset
                .messageId === "2",
          });
        } finally {
          f.dispose();
        }
      }
      const f = fixture();
      f.click();
      f.dispose();
      const reads = f.reads();
      f.pending[0].resolve(true);
      await settle();
      f.api.refresh();
      f.api.refreshLoaded();
      f.api.reset();
      f.api.dispose();
      const gestures = [];
      for (const kind of ["pointer", "trackpad"]) {
        const gesture = fixture();
        try {
          const scroller = gesture.panel.querySelector(
            ".conversation-tree-scroll",
          );
          gesture.panel.querySelector('[aria-label="Zoom in tree"]').click();
          if (kind === "pointer") {
            for (const [pointerId, clientX] of [
              [1, 0],
              [2, 100],
            ]) {
              scroller.dispatchEvent(
                new PointerEvent("pointerdown", {
                  pointerId,
                  clientX,
                  button: 0,
                }),
              );
            }
          } else {
            scroller.dispatchEvent(
              new Event("gesturestart", { cancelable: true }),
            );
          }
          gesture.api.reset();
          if (kind === "pointer") {
            scroller.dispatchEvent(
              new PointerEvent("pointermove", { pointerId: 2, clientX: 150 }),
            );
          } else {
            const event = new Event("gesturechange", { cancelable: true });
            Object.defineProperty(event, "scale", { value: 2 });
            scroller.dispatchEvent(event);
          }
          gestures.push({
            kind,
            zoom: gesture.panel.dataset.zoom,
            dragging: scroller.hasAttribute("data-dragging"),
          });
        } finally {
          gesture.dispose();
        }
      }
      return {
        resets: results,
        noReadsAfterDispose: f.reads() === reads,
        gestures,
      };
    });
    assert.deepEqual(results, {
      resets: ["success", "refused", "error"].map((outcome) => ({
        outcome,
        resetBusy: false,
        acceptedNewNavigation: true,
        staleResultIgnored: true,
        newNavigationFinished: true,
      })),
      noReadsAfterDispose: true,
      gestures: ["pointer", "trackpad"].map((kind) => ({
        kind,
        zoom: "1",
        dragging: false,
      })),
    });
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: reset and disposal invalidate pending tree navigation`,
    );
  } finally {
    await browser.close();
  }
}
