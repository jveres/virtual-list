import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { afterEach, mock, test } from "node:test";
import { launchSafari } from "./memory-browser.mjs";

afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

function safariPeer() {
  const peer = new EventEmitter();
  Object.assign(peer, {
    pid: 410,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  peer.kill = () => {
    peer.signalCode = "SIGTERM";
    queueMicrotask(() => {
      peer.emit("exit", null, "SIGTERM");
      peer.emit("close", null, "SIGTERM");
    });
    return true;
  };
  peer.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const request = JSON.parse(line);
      if (!request.id) continue;
      const result =
        request.method === "initialize"
          ? { serverInfo: { name: "test" } }
          : {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    request.params.name === "create_tab"
                      ? { handle: "owned-tab" }
                      : true,
                  ),
                },
              ],
            };
      queueMicrotask(() =>
        peer.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
        ),
      );
    }
  });
  return peer;
}

test("Safari launch failure never terminates a process that failed isolation validation", async () => {
  const peer = safariPeer();
  let snapshots = 0;
  const terminated = [];
  mock.method(childProcess, "spawn", () => peer);
  mock.method(childProcess, "execFileSync", (file, args) => {
    assert.equal(file, "/bin/ps");
    if (args[0] === "-axo")
      return ++snapshots === 1
        ? "1 0 /sbin/launchd\n"
        : "411 1 /Applications/Safari.app/Contents/MacOS/Safari\n";
    return "/Applications/Safari.app/Contents/MacOS/Safari\n";
  });
  mock.method(process, "kill", (pid) => {
    terminated.push(pid);
    return true;
  });
  syncBuiltinESMExports();
  await assert.rejects(launchSafari(), /Safari must be isolated/);
  assert.equal(peer.signalCode, "SIGTERM");
  assert.deepEqual(terminated, []);
});
