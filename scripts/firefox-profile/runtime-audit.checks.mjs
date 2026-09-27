import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
  installRuntimeAudit,
  instrumentDemo,
  instrumentRetainedRows,
  instrumentRowLayers,
  instrumentRuntime,
} from "./runtime-audit.mjs";

test("recycling and native row layer controls still match the runtime", async () => {
  const source = await readFile(
    new URL("../../src/virtual-list.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    instrumentRetainedRows(source).includes(
      "const retire = (row: Row<T>): void => {\n return;",
    ),
  );
  for (const enabled of [true, false]) {
    const changed = instrumentRowLayers(source, enabled);
    assert.ok(
      changed.includes(
        `const nativeLayerHint = ${JSON.stringify(enabled ? "will-change:transform;" : "")};`,
      ),
    );
    assert.throws(
      () => instrumentRowLayers(changed, enabled),
      /Native row style changed/,
    );
  }
  assert.throws(
    () => instrumentRetainedRows("changed source"),
    /Row retirement changed/,
  );
});

test("demo overlay measures separate rendering and URL-assignment boundaries", async () => {
  for (const [path, event] of [
    ["demos/shared/markdown.ts", "markdown"],
    ["demos/streaming/attachments.ts", "attachment-src"],
    ["demos/streaming/message-content.ts", "ordered-html"],
  ]) {
    const source = await readFile(
      new URL(`../../${path}`, import.meta.url),
      "utf8",
    );
    const changed = instrumentDemo(source, `/${path}`);
    assert.equal(changed.split(`event("${event}"`).length, 2);
    assert.throws(
      () => instrumentDemo("changed source", `/${path}`),
      /target changed/,
    );
  }
  assert.equal(instrumentDemo("unchanged", "/other.ts"), "unchanged");
});

test("runtime overlay matches each current source boundary exactly once", async () => {
  const source = await readFile(
    new URL("../../src/virtual-list.ts", import.meta.url),
    "utf8",
  );
  const changed = instrumentRuntime(source);
  for (const event of [
    "canvas-height",
    "commit-height",
    "resize-change",
    "place",
    "mount",
    "unmount",
    "live-pass",
    "stage-frame",
    "stage-row",
  ])
    assert.equal(changed.split(`event("${event}"`).length, 2);
  assert.ok(changed.includes("stageFrameBody();"));
  assert.throws(() => instrumentRuntime(changed), /Audit target changed/);
  assert.throws(
    () =>
      instrumentRuntime(
        source.replace("row.offset = offset;", "row.offset = 0;"),
      ),
    /Audit target changed/,
  );
});

function probe() {
  let time = 100;
  const listeners = new Map();
  class Image {
    complete = true;
    naturalWidth = 1280;
    naturalHeight = 720;
    decoding = "auto";
    get src() {
      throw new Error("Must not read image source");
    }
    get offsetHeight() {
      throw new Error("Must not read layout");
    }
  }
  const image = new Image();
  const context = {
    HTMLImageElement: Image,
    performance: { now: () => time },
    document: {
      querySelectorAll: () => [image],
      addEventListener: (name, listener) => listeners.set(name, listener),
      removeEventListener: (name, listener) => {
        assert.equal(listeners.get(name), listener);
        listeners.delete(name);
      },
    },
  };
  runInNewContext(`(${installRuntimeAudit.toString()})();`, context);
  return {
    audit: context.__runtimeAudit,
    image,
    listeners,
    tick: () => {
      time += 10;
    },
  };
}

test("audit ignores disabled hooks, logs numeric changes and stops listeners", () => {
  const { audit, image, listeners, tick } = probe();
  audit.event("mount", 123);
  audit.start();
  assert.throws(() => audit.start(), /already active/);
  tick();
  audit.event("place", Number.NaN, 300);
  listeners.get("load")({ target: image });
  const result = JSON.parse(JSON.stringify(audit.stop()));
  assert.deepEqual(result.records, [
    [10, "place", null, 300],
    [10, "image-load", 1280, 720],
  ]);
  assert.equal(result.start, 100);
  assert.equal(result.duration, 10);
  assert.equal(result.dropped, 0);
  assert.equal(result.initialImages[0].decoding, "auto");
  assert.equal(result.finalImages[0].width, 1280);
  assert.equal(listeners.size, 0);
  audit.event("mount", 456);
  assert.equal(result.records.length, 2);
  audit.start();
  assert.equal(audit.stop().records.length, 0);
});

test("audit bounds retained records and reports data loss", () => {
  const { audit } = probe();
  audit.start();
  for (let i = 0; i < 50003; i++) audit.event("mount", i);
  const result = audit.stop();
  assert.equal(result.records.length, 50000);
  assert.equal(result.dropped, 3);
});
