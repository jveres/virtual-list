// Native Safari diagnostic. Start safaridriver separately, then run this script.
// Only its automation session is closed; normal Safari tabs are not touched.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { bandColors } from "../shared/trail-pixels.mjs";

const driver = process.env.SAFARI_WEBDRIVER_URL ?? "http://127.0.0.1:4447";
const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
const output = "browser-artifacts/streaming-trail/safari-renderer";
await mkdir(output, { recursive: true });
async function request(path, body, method = "POST") {
  const response = await fetch(`${driver}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const { value } = await response.json();
  if (!response.ok || value?.error) throw new Error(JSON.stringify(value));
  return value;
}
const session =
  process.env.SAFARI_SESSION_ID ??
  (
    await request("/session", {
      capabilities: { alwaysMatch: { browserName: "safari" } },
    })
  ).sessionId;
const execute = (script) =>
  request(`/session/${session}/execute/sync`, { script, args: [] });
try {
  await request(`/session/${session}/url`, {
    url: `${base}/demos/streaming/?trail=long`,
  });
  await execute(`window.trailProbeReady = false; (async()=>{
    const {initMarkdown,createMarkdownViewer}=await import('/demos/shared/markdown.ts');
    await initMarkdown();
    document.body.replaceChildren();document.body.style.cssText='display:block;margin:30px;background:white;color:black';
    const host=document.createElement('div');host.style.width='600px';document.body.append(host);
    const viewer=createMarkdownViewer(host,{text:'',isStreaming:true,throttleMs:0,cursor:'none',streamingTrail:{},focusOnStreamingStart:false});
    const root=viewer.getContainer();root.style.cssText='font:24px/2 Arial;--cursor-color:#f5a1ff';
    window.probe={root,viewer};window.trailProbeReady=true;
  })().catch(e=>window.trailProbeError=String(e));`);
  for (let i = 0; i < 100; i++) {
    const ready = await execute(
      "return window.trailProbeError || window.trailProbeReady",
    );
    if (typeof ready === "string") throw new Error(ready);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await execute(
    "if(!window.probe)throw new Error('Probe initialization timed out');window.probe.viewer.update({text:'If those remain stable, the demo is covering the failure modes that are easy to'});",
  );
  console.log(
    "initial",
    await execute(
      "return {hidden:document.hidden,trail:!!document.querySelector('[data-streaming-trail]'),groups:document.querySelectorAll('[data-trail-group]').length,animations:window.probe.root.parentElement.getAnimations({subtree:true}).length,html:window.probe.root.innerHTML}",
    ),
  );
  await new Promise((r) => setTimeout(r, 240));
  await execute(
    "const text='If those remain stable, the demo is covering the failure modes that are easy to\\nmiss with very short responses.';window.probe.viewer.update({text,isStreaming:false});",
  );
  console.log(
    "finished",
    await execute(
      "return {hidden:document.hidden,groups:document.querySelectorAll('[data-trail-group]').length,animations:window.probe.root.parentElement.getAnimations({subtree:true}).map(a=>({time:a.currentTime,state:a.playState}))}",
    ),
  );
  const started = Date.now();
  const box = await execute(
    "const walker=document.createTreeWalker(window.probe.root.querySelector('p'),NodeFilter.SHOW_TEXT);let node,last;while(node=walker.nextNode())if(node.data.trim())last=node;const r=document.createRange();r.setStart(last,last.data.length-last.data.trimStart().length);r.setEnd(last,last.length);const b=r.getClientRects();const line=b[b.length-1];return {left:line.left,right:line.right,top:line.top,bottom:line.bottom,dpr:devicePixelRatio}",
  );
  const captures = [];
  for (const target of [0, 250, 500, 750, 1000, 1250, 1500]) {
    const wait = target - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const png = await request(
      `/session/${session}/screenshot`,
      undefined,
      "GET",
    );
    const buffer = Buffer.from(png, "base64");
    await writeFile(`${output}/fade-${target}.png`, buffer);
    captures.push({
      target,
      elapsed: Date.now() - started,
      ...bandColors(buffer, box),
    });
  }
  const final = await execute(
    "return {html:window.probe.root.innerHTML,groups:document.querySelectorAll('[data-trail-group],[data-trail-css]').length,animations:window.probe.root.parentElement.getAnimations({subtree:true}).length,userAgent:navigator.userAgent}",
  );
  await writeFile(
    `${output}/capture.json`,
    JSON.stringify({ captures, final }, null, 2),
  );
  console.log(JSON.stringify({ captures, final }));
  {
    assert.equal(final.groups, 0);
    assert.equal(final.animations, 0);
    assert.ok(
      captures.every((c) => c.gap === "255,255,255"),
      "No detached band may be painted above the text",
    );
    const green = captures.map((c) => Number(c.text.split(",")[1]));
    assert.ok(
      green[0] < 240 && green.at(-1) === 255,
      "The last line must visibly fade to the background",
    );
    assert.ok(
      new Set(green).size >= 5,
      "The fade must paint intermediate colors, not stick then disappear",
    );
    assert.ok(
      green.every((value, i) => i === 0 || value >= green[i - 1]),
      "The fade must not flash backwards",
    );
  }
} finally {
  await request(`/session/${session}`, undefined, "DELETE");
}
