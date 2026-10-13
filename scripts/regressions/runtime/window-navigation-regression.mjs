// Window navigation correctness, not native gesture performance.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    for (const target of ["start", "end"]) {
      for (const mode of [
        "measured",
        "declared",
        "short",
        "overlap",
        "abort",
        "replace",
      ]) {
        const page = await browser.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/__window-navigation", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<div id="viewport" style="height:400px;width:600px;overflow:auto"></div>',
          }),
        );
        await page.goto(`${base}/__window-navigation`);
        const result = await page.evaluate(
          async ({ target, mode }) => {
            const { createVirtualList } = await import("/src/virtual-list.ts");
            const viewport = document.querySelector("#viewport");
            const items = (start) =>
              Array.from({ length: 40 }, (_, i) => ({ id: String(start + i) }));
            const source = items(target === "end" ? 0 : 100);
            const destination =
              mode === "short"
                ? items(target === "end" ? 100 : 0).slice(0, 2)
                : items(
                    mode === "overlap"
                      ? target === "end"
                        ? 20
                        : 80
                      : target === "end"
                        ? 100
                        : 0,
                  );
            const list = createVirtualList(viewport, {
              items: source,
              key: (item) => item.id,
              render: (item, existing) => {
                const row = existing ?? document.createElement("div");
                row.textContent = item.id;
                row.style.height = "100px";
                return row;
              },
              ...(mode === "declared" ? { height: () => 100 } : {}),
              boot: "start",
              followBehavior: "smooth",
            });
            const controller = new AbortController();
            try {
              await list.scrollTo(source[10].id);
              const row = list.elementOf(source[10].id);
              const before = row.getBoundingClientRect().top;
              let prepared;
              let calls = 0;
              const nativeScroll = viewport.scrollTo;
              viewport.scrollTo = function (options) {
                if (options.behavior === "smooth") {
                  calls++;
                  prepared = {
                    connected: row.isConnected,
                    top: row.getBoundingClientRect().top,
                  };
                }
                return nativeScroll.call(this, options);
              };
              const navigation = list.updateWindow(
                () => ({ items: destination }),
                controller.signal,
                { scroll: { target } },
              );
              const deadline = performance.now() + 5000;
              while (!prepared && performance.now() < deadline)
                await new Promise(requestAnimationFrame);
              if (!prepared) throw new Error("navigation did not start");
              if (mode === "abort") controller.abort();
              if (mode === "replace")
                list.setItems(items(200), { interrupt: true });
              const landed = await navigation;
              return {
                before,
                prepared,
                calls,
                landed,
                count: list.state.count,
                following: list.state.following,
                atEdge:
                  target === "end" ? list.state.atEnd : list.state.atStart,
                sourceRetained: list.positionOf(source[10].id) !== null,
                replacementRetained: list.positionOf("200") !== null,
              };
            } finally {
              list.dispose();
            }
          },
          { target, mode },
        );
        assert.equal(
          result.prepared.connected,
          true,
          `${engine.name()} ${target} ${mode}: ${JSON.stringify(result)}`,
        );
        assert.ok(Math.abs(result.prepared.top - result.before) <= 1);
        assert.equal(result.calls, 1);
        assert.equal(result.landed, !["abort", "replace"].includes(mode));
        if (result.landed) {
          assert.equal(result.count, mode === "short" ? 2 : 40);
          assert.equal(result.atEdge, true);
          if (target === "end") assert.equal(result.following, true);
          assert.equal(
            result.sourceRetained,
            mode === "overlap" && target === "start",
          );
        }
        if (mode === "abort") assert.equal(result.sourceRetained, true);
        if (mode === "replace") assert.equal(result.replacementRetained, true);
        assert.deepEqual(errors, []);
        await page.close();
      }
    }
    console.log(
      `${engine.name()}: window navigation continuity and cancellation passed`,
    );
  } finally {
    await browser.close();
  }
}
