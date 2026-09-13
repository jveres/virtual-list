// Installed Safari correctness checks, not Playwright WebKit or a profile.
// Start /usr/bin/safaridriver -p 4445 first. This script owns its session and
// Vite server, not the driver or the user's existing Safari windows.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";

const driver = "http://127.0.0.1:4445";
const output = resolve("browser-artifacts/safari-ui");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(`${output}/run-`);
console.log(`Artifacts: ${directory}`);
let session;
let server;
const report = { status: "starting", composer: [] };
const interrupted = new AbortController();
const interrupt = () => interrupted.abort();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
async function request(path, body, method = "POST") {
  const response = await fetch(`${driver}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  if (!response.ok || result.value?.error)
    throw new Error(JSON.stringify(result.value));
  return result.value;
}
const command = (path, body, method) =>
  request(`/session/${session}${path}`, body, method);
async function evaluate(fn, ...args) {
  if (interrupted.signal.aborted) throw new Error("Interrupted");
  const result = await command("/execute/async", {
    script: `const done=arguments[arguments.length-1];
      Promise.resolve().then(()=>(${fn.toString()})(...Array.from(arguments).slice(0,-1)))
      .then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error.stack||error)}));`,
    args,
  });
  if (!result?.ok)
    throw new Error(
      result?.error ??
        "Safari script ended without a result; check dialogs or session interruption",
    );
  return result.value;
}
async function screenshot(name) {
  const png = await command("/screenshot", undefined, "GET");
  await writeFile(
    resolve(directory, `${name}.png`),
    Buffer.from(png, "base64"),
  );
}
async function pause() {
  await evaluate(() => new Promise((done) => setTimeout(done, 250)));
}
async function snapshot(label) {
  const value = await evaluate(() => {
    const v = document.querySelector("#viewport");
    const input = document.querySelector("#prompt");
    return {
      top: v.scrollTop,
      gap: v.scrollHeight - v.clientHeight - v.scrollTop,
      viewportHeight: v.clientHeight,
      promptHeight: input.getBoundingClientRect().height,
      value: input.value,
    };
  });
  report.composer.push({ label, ...value });
  return value;
}
async function fill(value) {
  await evaluate((text) => {
    const input = document.querySelector("#prompt");
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
  await pause();
}
try {
  server = await createServer({
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, open: false, hmr: false },
  });
  await server.listen();
  const base = server.resolvedUrls.local[0];
  const created = await request("/session", {
    capabilities: { alwaysMatch: { browserName: "safari" } },
  });
  session = created.sessionId;
  report.sessionId = session;
  report.capabilities = created.capabilities;
  await writeFile(
    resolve(directory, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(`Safari session: ${session}`);
  await command("/timeouts", { script: 60000, pageLoad: 60000 });
  const x = Number(process.env.SAFARI_WINDOW_X ?? 0);
  const y = Number(process.env.SAFARI_WINDOW_Y ?? 31);
  assert.ok(Number.isFinite(x) && Number.isFinite(y));
  await command("/window/rect", { x, y, width: 1900, height: 1049 });
  await command("/url", { url: `${base}demos/streaming/` });
  await evaluate(async () => {
    const until = performance.now() + 20000;
    while (document.documentElement.classList.contains("booting")) {
      if (performance.now() > until) throw new Error("Demo boot timed out");
      await new Promise((done) => setTimeout(done, 50));
    }
    window.__safariUiErrors = [];
    addEventListener("error", (event) =>
      window.__safariUiErrors.push(event.message),
    );
    addEventListener("unhandledrejection", (event) =>
      window.__safariUiErrors.push(String(event.reason)),
    );
  });
  report.display = await evaluate(() => ({
    x: screenX,
    y: screenY,
    innerWidth,
    innerHeight,
    dpr: devicePixelRatio,
    screenWidth: screen.width,
    screenHeight: screen.height,
    focused: document.hasFocus(),
    userAgent: navigator.userAgent,
  }));
  if (process.env.SAFARI_WINDOW_X) {
    assert.ok(
      report.display.x >= x,
      "Safari window must be on requested display",
    );
    assert.equal(
      report.display.dpr,
      2,
      "external-display capture requires 2x scaling",
    );
  }
  // Import synthetic history into the isolated automation session only.
  await evaluate(async () => {
    const originalConfirm = window.confirm;
    window.confirm = (message) => {
      if (
        !/^Replace .+ with the 6 turns in safari-composer\.md\?$/.test(message)
      ) {
        window.__safariUiErrors.push(`Unexpected confirmation: ${message}`);
        return false;
      }
      window.confirm = originalConfirm;
      return true;
    };
    const markdown = Array.from(
      { length: 6 },
      (_, i) =>
        `**${i % 2 ? "Assistant" : "User"}**\n\nTurn ${i}. ${"Scrollable conversation content. ".repeat(90)}\n\n`,
    ).join("");
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([markdown], "safari-composer.md", { type: "text/markdown" }),
    );
    const input = document.querySelector("#import-file");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const until = performance.now() + 15000;
    try {
      while (
        !document.querySelector("#viewport").textContent.includes("Turn 5.")
      ) {
        if (performance.now() > until) throw new Error("Import timed out");
        await new Promise((done) => setTimeout(done, 50));
      }
    } finally {
      window.confirm = originalConfirm;
    }
  });
  await fill("First line\n");
  await evaluate(() => {
    const v = document.querySelector("#viewport");
    v.scrollTop = v.scrollHeight;
  });
  await pause();
  const before = await snapshot("two lines at bottom");
  assert.ok(Math.abs(before.gap) <= 1);
  await screenshot("composer-before");
  const input = await command("/element", {
    using: "css selector",
    value: "#prompt",
  });
  const id = input["element-6066-11e4-a52e-4f735466cecf"];
  assert.equal(typeof id, "string");
  for (const text of "abc") {
    await command(`/element/${id}/value`, { text, value: [text] });
    await pause();
    const after = await snapshot(`native typing ${text}`);
    assert.equal(after.promptHeight, before.promptHeight);
    assert.ok(
      Math.abs(after.top - before.top) <= 1,
      "same-line typing moved chat",
    );
    assert.ok(
      Math.abs(after.gap) <= 1,
      "same-line typing lost bottom alignment",
    );
  }
  assert.equal(report.composer.at(-1).value, "First line\nabc");
  await screenshot("composer-after-typing");
  for (const [label, value] of [
    ["three lines", "First line\nSecond line\nThird line"],
    ["maximum height", "Line\n".repeat(20)],
    ["short", "Short"],
  ]) {
    await fill(value);
    const resized = await snapshot(label);
    assert.ok(Math.abs(resized.gap) <= 1, `${label}: bottom alignment`);
    assert.ok(resized.promptHeight <= 160, `${label}: height cap`);
    await screenshot(`composer-${label.replaceAll(" ", "-")}`);
  }
  assert.equal(
    report.composer.find((s) => s.label === "maximum height").promptHeight,
    160,
  );
  assert.ok(report.composer.at(-1).promptHeight < before.promptHeight);
  await fill("First line\nSecond line");
  await evaluate(() => {
    document.querySelector("#viewport").scrollTop -= 180;
  });
  await pause();
  const away = await snapshot("scrolled away");
  assert.ok(away.gap > 100, "scrollback precondition");
  await command(`/element/${id}/value`, { text: "x", value: ["x"] });
  await pause();
  assert.ok(
    Math.abs((await snapshot("typing while away")).top - away.top) <= 1,
  );
  await screenshot("composer-away");
  report.errors = await evaluate(() => window.__safariUiErrors);
  assert.deepEqual(report.errors, []);
  await command("/url", { url: base });
  const typography = await evaluate(async () => {
    const errors = [];
    const onError = (event) => errors.push(event.message);
    const onRejection = (event) => errors.push(String(event.reason));
    addEventListener("error", onError);
    addEventListener("unhandledrejection", onRejection);
    const { checkScopedTypography } = await import(
      "/scripts/regressions/fixtures/scoped-typography.js"
    );
    try {
      const result = await checkScopedTypography();
      return { result, errors };
    } finally {
      removeEventListener("error", onError);
      removeEventListener("unhandledrejection", onRejection);
    }
  });
  report.typography = typography.result;
  report.typographyErrors = typography.errors;
  assert.deepEqual(typography.errors, []);
  report.status = "passed";
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack ?? error);
  if (session) await screenshot("failure").catch(() => {});
  process.exitCode = 1;
  console.error(report.error);
} finally {
  if (session) {
    try {
      await command("", undefined, "DELETE");
      report.sessionClosed = true;
    } catch (error) {
      report.cleanupError = String(error);
      process.exitCode = 1;
    }
  }
  await server?.close();
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await writeFile(
    resolve(directory, "report.json"),
    JSON.stringify(report, null, 2),
  );
}
