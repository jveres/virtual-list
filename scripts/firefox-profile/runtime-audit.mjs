// Diagnostic-only source overlay. No production runtime/API changes.
import assert from "node:assert/strict";

export function instrumentRuntime(source) {
  const replacements = [
    [
      "function syncCanvasHeight(totalSize: number, floor: boolean): void {",
      'function syncCanvasHeight(totalSize: number, floor: boolean): void {\n    globalThis.__runtimeAudit?.event("canvas-height", totalSize);',
    ],
    [
      "const height = quantize(measured);",
      'const height = quantize(measured);\n    globalThis.__runtimeAudit?.event("commit-height", row.height, height);',
    ],
    [
      "if (quantize(height) === row.height) continue;",
      'if (quantize(height) === row.height) continue;\n      globalThis.__runtimeAudit?.event("resize-change", row.height, height);',
    ],
    [
      "row.offset = offset;",
      'globalThis.__runtimeAudit?.event("place", row.offset, offset);\n    row.offset = offset;',
    ],
    [
      'row.place = "mounted";',
      'row.place = "mounted";\n    globalThis.__runtimeAudit?.event("mount", row.height);',
    ],
    [
      'function unmountRow(row: Row<T>): void {\n    row.place = "detached";',
      'function unmountRow(row: Row<T>): void {\n    globalThis.__runtimeAudit?.event("unmount", row.height);\n    row.place = "detached";',
    ],
    [
      "if (vp.scrollTop >= previousTop) break;",
      'globalThis.__runtimeAudit?.event("live-pass", previousTop, vp.scrollTop);\n          if (vp.scrollTop >= previousTop) break;',
    ],
    [
      "const stageFrame = (): void => {",
      `const stageFrame = (): void => {
        const auditStart = performance.now();
        try { stageFrameBody(); }
        finally { globalThis.__runtimeAudit?.event("stage-frame", performance.now() - auditStart); }
      };
      const stageFrameBody = (): void => {`,
    ],
    [
      "const row = createRow(key, item, render(item), 1);",
      `const auditRenderStart = performance.now();
            const row = createRow(key, item, render(item), 1);
            globalThis.__runtimeAudit?.event("stage-row", performance.now() - auditRenderStart);`,
    ],
  ];
  for (const [needle, replacement] of replacements) {
    assert.equal(
      source.split(needle).length,
      2,
      `Audit target changed: ${needle}`,
    );
    source = source.replace(needle, replacement);
  }
  return source;
}

export function instrumentDemo(source, id) {
  let needle;
  let replacement;
  if (id.endsWith("/demos/shared/markdown.ts")) {
    needle = "return renderToHtml(markdown);";
    replacement = `const auditStart = performance.now();
  try { return renderToHtml(markdown); }
  finally { globalThis.__runtimeAudit?.event("markdown", performance.now() - auditStart, markdown.length); }`;
  } else if (id.endsWith("/demos/streaming/attachments.ts")) {
    needle = "setAttachmentImageSource(image, attachment);";
    replacement = `const auditStart = performance.now();
    setAttachmentImageSource(image, attachment);
    globalThis.__runtimeAudit?.event("attachment-src", performance.now() - auditStart, attachment.dataUrl.length);`;
  } else if (id.endsWith("/demos/streaming/message-content.ts")) {
    needle = "markdown.innerHTML = renderMarkdown(part.text);";
    replacement = `const auditHtml = renderMarkdown(part.text);
      const auditStart = performance.now();
      markdown.innerHTML = auditHtml;
      globalThis.__runtimeAudit?.event("ordered-html", performance.now() - auditStart, auditHtml.length);`;
  } else return source;
  assert.equal(
    source.split(needle).length,
    2,
    `Demo audit target changed: ${id}`,
  );
  return source.replace(needle, replacement);
}

// Serialized into an isolated diagnostic page. Only existing numeric geometry
// is logged: no DOM bounds, computed-style reads, source URLs, or row contents.
export function installRuntimeAudit() {
  let active = false;
  let records = [];
  let dropped = 0;
  let start = 0;
  let initialImages;
  const snapshotImages = () =>
    [...document.querySelectorAll("#viewport img")].map((image) => ({
      complete: image.complete,
      width: image.naturalWidth,
      height: image.naturalHeight,
      decoding: image.decoding,
    }));
  const event = (name, a = null, b = null) => {
    if (!active) return;
    if (records.length === 50000) {
      dropped++;
      return;
    }
    records.push([
      performance.now() - start,
      name,
      Number.isFinite(a) ? a : null,
      Number.isFinite(b) ? b : null,
    ]);
  };
  const loaded = (e) => {
    if (e.target instanceof HTMLImageElement)
      event("image-load", e.target.naturalWidth, e.target.naturalHeight);
  };
  globalThis.__runtimeAudit = {
    event,
    start() {
      if (active) throw new Error("Runtime audit already active");
      records = [];
      dropped = 0;
      initialImages = snapshotImages();
      start = performance.now();
      active = true;
      document.addEventListener("load", loaded, true);
    },
    stop() {
      active = false;
      document.removeEventListener("load", loaded, true);
      return {
        start,
        duration: performance.now() - start,
        records,
        dropped,
        initialImages,
        finalImages: snapshotImages(),
      };
    },
  };
}
