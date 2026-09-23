// Scroll into a page just committed above the reader:
//   node next/bench/scrollback.mjs --engine=chromium [--rounds=7]
import process from "node:process";
import { chromium, firefox, webkit } from "playwright";

const option = (name, fallback) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;
const servers = {
  main: option("main", "http://127.0.0.1:4274"),
  next: option("next", "http://127.0.0.1:4273"),
};
const engine = option("engine", "chromium");
const type = { chromium, firefox, webkit }[engine];
const rounds = Number(option("rounds", "7"));
const browser = await type.launch({ headless: true });
const samples = { main: [], next: [] };
for (let round = 0; round < rounds; round++) {
  for (const name of round % 2 ? ["next", "main"] : ["main", "next"]) {
    const page = await browser.newPage();
    await page.route("**/__bench__", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: "<!doctype html><body></body>",
      }),
    );
    await page.goto(`${servers[name]}/__bench__`);
    samples[name].push(
      await page.evaluate(async () => {
        const { createVirtualList } = await import("/src/virtual-list.ts");
        const frame = () => new Promise((done) => requestAnimationFrame(done));
        const build = (item) => {
          const row = document.createElement("article");
          row.style.cssText = "font:15px/1.5 system-ui;padding:8px 16px";
          row.innerHTML = `<h3>Message ${item.id}</h3><p>${"rows measured where they mount keep their layout ".repeat(6 + (item.id % 7))}</p><pre style="white-space:pre-wrap">${"code block line ".repeat(24)}</pre><ul><li>one</li><li>two</li></ul>`;
          return row;
        };
        const viewport = document.createElement("div");
        viewport.style.cssText = "width:720px;height:800px;overflow:auto";
        document.body.append(viewport);
        const items = Array.from({ length: 80 }, (_, id) => ({ id }));
        const list = createVirtualList(viewport, {
          items,
          key: (i) => String(i.id),
          render: (i, e) => e ?? build(i),
          settleStrategy: "default",
          overscanPx: 400,
        });
        await frame();
        await frame();
        const page = Array.from({ length: 60 }, (_, i) => ({ id: -60 + i }));
        list.setItems([...page, ...items], { anchor: "viewport" });
        await frame();
        let total = 0;
        let steps = 0;
        for (
          let top = viewport.scrollTop - 200;
          top > viewport.scrollTop - 6000 && top > 0;
          top -= 200
        ) {
          const started = performance.now();
          viewport.scrollTop = top;
          viewport.dispatchEvent(new Event("scroll"));
          void viewport.offsetHeight;
          total += performance.now() - started;
          steps += 1;
          await frame();
        }
        list.dispose();
        viewport.remove();
        return total / steps;
      }),
    );
    await page.close();
  }
}
await browser.close();
const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
console.log(
  JSON.stringify({
    engine,
    stepMs: { main: median(samples.main), next: median(samples.next) },
  }),
);
