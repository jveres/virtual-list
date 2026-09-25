import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { SafariMcp } from "./safari-mcp.mjs";

// A real stdio peer exercises framing, cancellation and child-process lifetime.
// No browser, permissions, or network are needed for these portable checks.
async function withPeer(run) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {createInterface} from 'node:readline';
    const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
    for await (const line of createInterface({input:process.stdin})) {
      const m=JSON.parse(line);
      if (!m.id) continue;
      if (m.method==='initialize') send(m.id,{serverInfo:{name:'Safari',version:'test'}});
      else if (m.params?.name==='hang') continue;
      else if (m.params?.name==='exit') process.exit(0);
      else if (m.params?.name==='error') send(m.id,{isError:true,content:[{type:'text',text:'Rejected test operation'}]});
      else if (m.params?.name==='rpc-error') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-1,message:'Protocol failure'}})+'\\n');
      else {
        const response=JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:JSON.stringify(m.params.arguments)}]}})+'\\n';
        process.stdout.write(response.slice(0,13));
        setTimeout(()=>process.stdout.write(response.slice(13)),5);
      }
    }
  `,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = new Promise((resolve) => child.once("close", resolve));
  const client = new SafariMcp(child);
  try {
    await run(client);
  } finally {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await closed;
  }
}

test("Safari transport preserves fragmented responses and browser errors", () =>
  withPeer(async (client) => {
    assert.deepEqual(await client.initialize(), {
      name: "Safari",
      version: "test",
    });
    const value = { text: "line one\nline two ✓" };
    assert.deepEqual(JSON.parse(await client.tool("echo", value)), value);
    await assert.rejects(client.tool("error", {}), /Rejected test operation/);
    await assert.rejects(client.tool("rpc-error", {}), /Protocol failure/);
  }));

test("Safari transport cancels a pending request without preventing cleanup", () =>
  withPeer(async (client) => {
    await client.initialize();
    const controller = new AbortController();
    const pending = client.tool("hang", {}, { signal: controller.signal });
    controller.abort(new Error("Capture interrupted"));
    await assert.rejects(pending, /Capture interrupted/);
    assert.equal(
      await client.tool("close_tab", { handle: "owned-tab" }),
      '{"handle":"owned-tab"}',
    );
  }));

test("Safari transport fails promptly on deadlines and process exit", () =>
  withPeer(async (client) => {
    await client.initialize();
    await assert.rejects(
      client.tool("hang", {}, { timeoutMs: 10 }),
      /timed out/,
    );
    await assert.rejects(client.tool("exit", {}), /Safari MCP exited/);
    await assert.rejects(client.tool("echo", {}), /Safari MCP exited/);
  }));
