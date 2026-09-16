import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext, Script } from "node:vm";
import { serializedExpression } from "./expression.mjs";

test("serializes expressions with comments and a trailing semicolon", () => {
  const expression = serializedExpression(
    "// setup\n(() => ({ value: 7 }))();\n",
  );
  assert.equal(runInNewContext(expression), '{"value":7}');
  assert.equal(runInNewContext(serializedExpression("42 // value")), "42");
});

test("compiles the tracked setup files in the profiler wrapper", async () => {
  for (const name of [
    "rich-chat",
    "streaming-chat",
    "idle-chat-scroll",
    "canvas-compositing",
  ]) {
    const source = await readFile(
      new URL(`./fixtures/${name}.js`, import.meta.url),
      "utf8",
    );
    assert.doesNotThrow(() => new Script(serializedExpression(source)));
  }
});
