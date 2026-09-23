// Count avoidable adapter work, separately from native Firefox timing captures.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    await openStreamingDemo(page, base);
    const result = await page.evaluate(async () => {
      const { createChatImagePreview } = await import(
        "/demos/streaming/image-preview.ts"
      );
      const {
        prepareUserMessageCollapse,
        mountUserMessageCollapse,
        unmountUserMessageCollapse,
      } = await import("/integrations/index.ts");
      const { buildChatItem } = await import("/demos/shared/chat-ui.ts");
      const { renderMarkdown } = await import("/demos/shared/markdown.ts");
      const { createStickyHeaders } = await import("/src/companions/index.ts");
      const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
      const until = async (predicate) => {
        for (let attempt = 0; attempt < 30; attempt++) {
          if (predicate()) return;
          await settle();
        }
        throw new Error("Preview interaction did not settle");
      };
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;top:0;left:0;width:500px";
      document.body.append(host);
      try {
        // Initial image binding and remounting must not render Markdown again.
        const canvas = document.createElement("canvas");
        canvas.width = 128;
        canvas.height = 64;
        const source = canvas.toDataURL();
        const messages = [1, 2, 3].map((id) => ({
          id,
          markdown: `![Image ${id}](${source})`,
        }));
        const rows = messages.slice(0, 2).map((message) => {
          const row = document.createElement("div");
          row.dataset.key = String(message.id);
          const image = new Image();
          image.src = source;
          image.alt = `Image ${message.id}`;
          row.append(image);
          host.append(row);
          return row;
        });
        await Promise.all(
          [...host.querySelectorAll("img")].map((i) => i.decode()),
        );
        const createElement = document.createElement;
        let templates = 0;
        document.createElement = function (tag, ...args) {
          if (tag === "template") templates++;
          return createElement.call(this, tag, ...args);
        };
        let preview;
        let imageResult;
        try {
          preview = createChatImagePreview(host, () => messages);
          await settle();
          const initialTemplates = templates;
          const ids = rows.map((row) => row.firstElementChild.dataset.photoId);
          rows[0].remove();
          await settle();
          host.prepend(rows[0]);
          await settle();
          imageResult = {
            initialTemplates,
            remountTemplates: templates - initialTemplates,
            stableIds: rows.every(
              (row, index) =>
                row.firstElementChild.dataset.photoId === ids[index],
            ),
          };
          // Parsing may happen when the reader explicitly opens/navigates the
          // viewer, but its canonical IDs must still match mounted bindings.
          const firstImage = rows[0].firstElementChild;
          const open = async () => {
            firstImage.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Enter",
                bubbles: true,
                cancelable: true,
              }),
            );
            await until(
              () => document.querySelector(".photo-viewer")?.dataset.photoId,
            );
          };
          const close = async () => {
            document.querySelector(".photo-viewer-close").click();
            await until(() => !document.querySelector(".photo-viewer"));
          };
          await open();
          imageResult.openId =
            document.querySelector(".photo-viewer").dataset.photoId;
          document.querySelector(".photo-viewer-next").click();
          await until(
            () =>
              document.querySelector(".photo-viewer")?.dataset.photoId ===
              ids[1],
          );
          imageResult.nextId =
            document.querySelector(".photo-viewer").dataset.photoId;
          imageResult.expectedIds = ids;
          document.querySelector(".photo-viewer-next").click();
          await until(
            () =>
              document.querySelector(".photo-viewer-details")?.textContent ===
              "Image 3",
          );
          const offscreenId =
            document.querySelector(".photo-viewer").dataset.photoId;
          const thirdRow = document.createElement("div");
          thirdRow.dataset.key = "3";
          const thirdImage = new Image();
          thirdImage.src = source;
          thirdImage.alt = "Image 3";
          thirdRow.append(thirdImage);
          host.append(thirdRow);
          await thirdImage.decode();
          await settle();
          imageResult.offscreenIdMatches =
            thirdImage.dataset.photoId === offscreenId;
          await close();

          // Same-message DOM changes, including A -> B -> A with unchanged
          // source Markdown, cannot leave navigation pointing at obsolete IDs.
          canvas.getContext("2d").fillRect(0, 0, 128, 64);
          firstImage.src = canvas.toDataURL();
          await firstImage.decode();
          await settle();
          await open();
          imageResult.aheadOfModelNextEnabled =
            !document.querySelector(".photo-viewer-next").disabled;
          await close();
          firstImage.src = source;
          await firstImage.decode();
          await settle();
          await open();
          imageResult.restoredNextEnabled =
            !document.querySelector(".photo-viewer-next").disabled;
          await close();
        } finally {
          document.createElement = createElement;
          preview?.dispose();
          host.replaceChildren();
        }

        // A retained row already has its natural text size from preparation.
        const message = { role: "user", markdown: "Long prompt. ".repeat(100) };
        const row = buildChatItem(message, renderMarkdown(message.markdown));
        prepareUserMessageCollapse(row, 901, false, () => {}, 500);
        const content = row.querySelector(".user-message-body > .markdown");
        const body = row.querySelector(".user-message-body");
        const button = row.querySelector(".user-message-toggle");
        const rect = content.getBoundingClientRect;
        const computedStyle = window.getComputedStyle;
        let rectReads = 0;
        let styleReads = 0;
        content.getBoundingClientRect = function () {
          rectReads++;
          return rect.call(this);
        };
        window.getComputedStyle = function (element, ...args) {
          if (element === content) styleReads++;
          return computedStyle.call(this, element, ...args);
        };
        let collapseResult;
        try {
          host.append(row);
          mountUserMessageCollapse(row);
          await settle();
          const initial = { rectReads, styleReads };
          rectReads = styleReads = 0;
          unmountUserMessageCollapse(row);
          row.remove();
          host.append(row);
          mountUserMessageCollapse(row);
          await settle();
          const remounted = { rectReads, styleReads };
          rectReads = styleReads = 0;
          host.style.width = "360px";
          await settle();
          const resized = {
            rectReads,
            styleReads,
            collapsed: body.classList.contains("is-collapsed"),
          };
          content.textContent = "Short prompt.";
          await settle();
          collapseResult = {
            initial,
            remounted,
            resized,
            shortToggleHidden: button.hidden,
            shortCollapsed: body.classList.contains("is-collapsed"),
          };
        } finally {
          window.getComputedStyle = computedStyle;
          content.getBoundingClientRect = rect;
          unmountUserMessageCollapse(row);
          host.replaceChildren();
        }

        // Duplicate position publications must be no-ops, while refresh must
        // still reconcile a new inline header at the very same scroll offset.
        const viewport = document.createElement("div");
        host.append(viewport);
        let inline = document.createElement("div");
        viewport.append(inline);
        let top = 0;
        let inlineReads = 0;
        const sticky = createStickyHeaders({
          observeScroll: true,
          container: host,
          viewport,
          headerKeys: () => ["day"],
          positionOf: () => ({ top, height: 32 }),
          renderHeader: (slot) => {
            slot.textContent = "Day";
          },
          elementOf: () => {
            inlineReads++;
            return inline;
          },
        });
        let stickyResult;
        const mutations = new MutationObserver(() => {});
        try {
          const overlay = host.querySelector(".vl-sticky-header");
          mutations.observe(overlay, {
            subtree: true,
            attributes: true,
            childList: true,
          });
          sticky.refresh(10);
          mutations.takeRecords();
          inlineReads = 0;
          sticky.update(10);
          const duplicateWrites = mutations.takeRecords().length;
          const duplicateReads = inlineReads;
          inline.remove();
          inline = document.createElement("div");
          viewport.append(inline);
          sticky.refresh(10);
          const replacementHidden = inline.classList.contains(
            "vl-sticky-inline-hidden",
          );
          top = 20;
          sticky.refresh(10);
          const changedGeometryHidden = overlay.style.display === "none";
          top = 0;
          sticky.refresh(10);
          sticky.setEnabled(false);
          sticky.setEnabled(true);
          stickyResult = {
            duplicateWrites,
            duplicateReads,
            replacementHidden,
            changedGeometryHidden,
            reenabled: overlay.style.display !== "none",
          };
        } finally {
          mutations.disconnect();
          sticky.destroy();
        }
        return {
          images: imageResult,
          collapse: collapseResult,
          sticky: stickyResult,
        };
      } finally {
        host.remove();
      }
    });
    console.log(JSON.stringify({ engine: engine.name(), result }));
    assert.equal(
      result.images.initialTemplates,
      0,
      "binding never reparses Markdown",
    );
    assert.equal(
      result.images.remountTemplates,
      0,
      "remounting never reparses Markdown",
    );
    assert.equal(
      result.images.stableIds,
      true,
      "preview IDs survive remounting",
    );
    assert.equal(result.images.openId, result.images.expectedIds[0]);
    assert.equal(result.images.nextId, result.images.expectedIds[1]);
    assert.equal(
      result.images.offscreenIdMatches,
      true,
      "offscreen navigation IDs match later bindings",
    );
    assert.equal(
      result.images.restoredNextEnabled,
      true,
      "restored DOM images can still navigate",
    );
    assert.equal(
      result.images.aheadOfModelNextEnabled,
      true,
      "live images ahead of the model retain mounted navigation",
    );
    assert.deepEqual(result.collapse.initial, { rectReads: 0, styleReads: 0 });
    assert.deepEqual(result.collapse.remounted, {
      rectReads: 0,
      styleReads: 0,
    });
    assert.equal(
      result.collapse.resized.rectReads,
      0,
      "resize uses observer dimensions",
    );
    assert.equal(result.collapse.resized.collapsed, true);
    assert.equal(result.collapse.shortToggleHidden, true);
    assert.equal(result.collapse.shortCollapsed, false);
    assert.deepEqual(result.sticky, {
      duplicateWrites: 0,
      duplicateReads: 0,
      replacementHidden: true,
      changedGeometryHidden: true,
      reenabled: true,
    });
  } finally {
    await browser.close();
  }
}
