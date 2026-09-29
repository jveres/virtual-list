import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseSync } from "vite";
import { writeReproduction } from "./artifacts.mjs";
import { instrumentChat } from "./chat-instrument.mjs";
import { chatWorkload } from "./chat-workload.mjs";

test("tool history leaves existing workload defaults and hashes unchanged", () => {
  for (const [options, hash] of [
    [{}, "dcd17202ed985a294fc2d639d5c34d6d39be19a42fd30249f17da240b88943df"],
    [
      { sections: 48, history: 160, durationMs: 12000, content: "rich" },
      "b871a8159e958823e1b309e72bc3ef2f0a48590998de7e3af2b786951cf594d9",
    ],
  ]) {
    const workload = chatWorkload(options);
    assert.equal(workload.metadata.hash, hash);
    assert.deepEqual(
      workload,
      chatWorkload({ ...options, historyContent: "rich" }),
    );
    assert.equal(
      workload.turns.some((turn) => turn.toolCalls),
      false,
    );
  }
});

test("tool history changes only stored calls while keeping the stream and visible text", () => {
  const options = {
    sections: 1,
    history: 160,
    durationMs: 1000,
    content: "prose",
  };
  const rich = chatWorkload(options);
  const tools = chatWorkload({ ...options, historyContent: "tools" });
  assert.deepEqual(
    tools,
    chatWorkload({ ...options, historyContent: "tools" }),
  );
  assert.deepEqual(tools.events, rich.events);
  assert.deepEqual(
    tools.turns.map(({ toolCalls, ...turn }) => turn),
    rich.turns,
  );
  assert.notEqual(tools.metadata.hash, rich.metadata.hash);
  assert.equal(tools.metadata.historyContent, "tools");
  assert.equal(tools.metadata.historyToolCalls, 240);
  assert.equal(tools.metadata.characters, 936);
  assert.equal(tools.events.at(-1).at, 1000);
});

test("tool history contains bounded closed string payloads and chronological offsets", () => {
  const workload = chatWorkload({ historyContent: "tools" });
  const thinking = new Set();
  let payloadCharacters = 0;
  for (const turn of workload.turns) {
    if (turn.role === "user") {
      assert.equal(turn.toolCalls, undefined);
      continue;
    }
    const calls = turn.toolCalls;
    assert.deepEqual(
      calls.map((call) => call.name),
      ["thinking", "local_search", "thinking"],
    );
    let previous = 0;
    let thinkingCharacters = 0;
    for (const call of calls) {
      assert.equal(call.status, "done");
      assert.equal(call.open, false);
      assert.equal(typeof call.input, "string");
      assert.equal(typeof call.output, "string");
      assert.ok(call.markdownOffset >= previous);
      assert.ok(call.markdownOffset < turn.markdown.length);
      previous = call.markdownOffset;
      payloadCharacters += call.input.length + call.output.length;
      if (call.name === "thinking") {
        assert.match(call.output, /\n\n- /);
        assert.match(call.output, /```typescript/);
        thinking.add(call.output);
        thinkingCharacters += call.output.length;
      } else {
        assert.equal(JSON.parse(call.output).results.length, 6);
        assert.ok(call.output.length < 2400);
      }
    }
    assert.ok(thinkingCharacters >= 8000 && thinkingCharacters <= 12000);
  }
  assert.equal(
    thinking.size,
    160,
    "distinct summaries exercise construction and parsing",
  );
  assert.equal(workload.metadata.historyPayloadCharacters, payloadCharacters);
  assert.ok(JSON.stringify(workload.turns).length < 1_200_000);
});

test("tool history stays within the probe storage budget", () => {
  const maximum = chatWorkload({ historyContent: "tools", history: 320 });
  assert.ok(JSON.stringify(maximum.turns).length * 2 < 5 * 1024 ** 2);
  assert.throws(
    () => chatWorkload({ historyContent: "tools", history: 321 }),
    /at most 320/,
  );
  assert.throws(
    () => chatWorkload({ historyContent: "unknown" }),
    /Invalid historyContent/,
  );
  assert.equal(chatWorkload({ history: 1000 }).turns.length, 1000);
});

test("invalid history selection fails before a capture starts", () => {
  const result = spawnSync(
    process.execPath,
    [
      new URL("../profile-chat.mjs", import.meta.url).pathname,
      "--history-content=unknown",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid --history-content/);
  assert.equal(result.stdout, "");
});

test("tool construction receives a diagnostic span without changing timing mode", async () => {
  const path = "demos/shared/chat-ui.ts";
  const source = await readFile(
    new URL(`../../${path}`, import.meta.url),
    "utf8",
  );
  const instrumented = instrumentChat(source, path, true);
  assert.deepEqual(parseSync(path, instrumented).errors, []);
  assert.match(instrumented, /demos\/shared\/chat-ui\.ts:buildToolCall/);
  assert.equal(instrumentChat(source, path, false), source);
});

test("reproduction commands retain the selected tool history", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-history-replay-"));
  const git = (args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  try {
    await writeFile(join(root, "package.json"), "{}\n");
    git(["init", "-q"]);
    git(["add", "package.json"]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "Fixture",
    ]);
    const directory = join(root, "capture");
    await mkdir(directory);
    await writeReproduction(
      directory,
      {
        options: {
          history: 160,
          historyContent: "tools",
          content: "prose",
          sections: 1,
          durationMs: 1000,
          pointerX: 0.02,
        },
      },
      root,
    );
    const replay = JSON.parse(
      await readFile(join(directory, "reproduce.json"), "utf8"),
    );
    assert.ok(replay.command.includes("--history-content=tools"));
    assert.ok(replay.command.includes("--content=prose"));
    assert.ok(replay.command.includes("--stream-ms=1000"));
    assert.ok(replay.command.includes("--pointer-x=0.02"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
