import assert from "node:assert/strict";
import { test } from "node:test";

for (const supplied of [true, false]) {
  test(`Safari probe ${supplied ? "preserves a supplied" : "closes its own"} session after failure`, async (t) => {
    const names = ["SAFARI_WEBDRIVER_URL", "SAFARI_SESSION_ID"];
    const previous = names.map((name) => process.env[name]);
    t.after(() => {
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      });
    });
    process.env.SAFARI_WEBDRIVER_URL = "http://safari-probe.invalid";
    if (supplied) process.env.SAFARI_SESSION_ID = "supplied-session";
    else delete process.env.SAFARI_SESSION_ID;
    const requests = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
      const path = new URL(url).pathname;
      requests.push([options.method, path]);
      if (path === "/session")
        return Response.json({ value: { sessionId: "owned-session" } });
      if (options.method === "DELETE") return Response.json({ value: null });
      return Response.json(
        { value: { error: "Injected navigation failure" } },
        { status: 500 },
      );
    });

    await assert.rejects(
      import(
        `../regressions/runtime/streaming-trail-safari-probe.mjs?supplied=${supplied}`
      ),
      /Injected navigation failure/,
    );

    assert.deepEqual(
      requests,
      supplied
        ? [["POST", "/session/supplied-session/url"]]
        : [
            ["POST", "/session"],
            ["POST", "/session/owned-session/url"],
            ["DELETE", "/session/owned-session"],
          ],
    );
  });
}
