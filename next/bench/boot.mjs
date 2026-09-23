// Boot-only micro benchmark: node next/bench/boot.mjs --engine=chromium
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
const type = { chromium, firefox, webkit }[option("engine", "chromium")];
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
        const build = (item) => {
          const row = document.createElement("article");
          row.innerHTML = `<h3>Message ${item.id}</h3><p>${"virtual list rows measured where they mount ".repeat(4 + (item.id % 5))}</p><pre>${"code ".repeat(20)}</pre>`;
          return row;
        };
        let total = 0;
        for (let repeat = 0; repeat < 10; repeat++) {
          const viewport = document.createElement("div");
          viewport.style.cssText = "width:720px;height:800px;overflow:auto";
          document.body.append(viewport);
          const items = Array.from({ length: 300 }, (_, id) => ({ id }));
          const started = performance.now();
          const list = createVirtualList(viewport, {
            items,
            key: (i) => String(i.id),
            render: (i, e) => e ?? build(i),
            settleStrategy: "default",
          });
          void viewport.offsetHeight;
          total += performance.now() - started;
          list.dispose();
          viewport.remove();
        }
        return total / 10;
      }),
    );
    await page.close();
  }
}
await browser.close();
const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
console.log(
  JSON.stringify({ main: median(samples.main), next: median(samples.next) }),
);
