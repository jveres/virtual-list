// Run against Vite with BROWSER_MATRIX_URL (default: http://127.0.0.1:4193).
import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:4193";
for (const engine of [firefox, webkit]) {
  const browser = await engine.launch();
  try {
    const firstPaint = await browser.newPage({
      javaScriptEnabled: false,
      colorScheme: "dark",
    });
    await firstPaint.goto(`${base}/demos/feed/`);
    assert.equal(
      await firstPaint
        .locator('header .header-title a[href="/"]')
        .textContent(),
      "virtual-list",
    );
    assert.equal(
      await firstPaint
        .locator("body")
        .evaluate((body) => getComputedStyle(body).backgroundColor),
      "rgb(22, 24, 29)",
    );
    await firstPaint.goto(base);
    assert.equal(
      await firstPaint
        .locator('ul li a[href="/demos/feed/index.html"]')
        .textContent(),
      "feed",
    );
    await firstPaint.close();
    const page = await browser.newPage({
      viewport: { width: 1000, height: 720 },
    });
    const errors = [];
    let phase = "boot";
    let failNext = false;
    let holdHead = false;
    let releaseHead;
    let headOffset = 0;
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error(`${engine.name()}/${phase}: ${error.message}`);
    });
    const text =
      "A long public post, with enough text to exercise measured heights and expansion. ".repeat(
        24,
      );
    await page.route("https://public.api.bsky.app/**", async (route) => {
      const url = new URL(route.request().url());
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      if (holdHead && cursor === 0)
        await new Promise((resolve) => {
          releaseHead = resolve;
        });
      if (failNext && cursor > 0) {
        failNext = false;
        await route.fulfill({ status: 503, body: "Unavailable" });
        return;
      }
      // The second page is empty, but still has a continuation. Later pages
      // overlap by one post so the real paging companion must deduplicate them.
      const start = cursor === 0 ? headOffset : cursor * 10;
      const feed =
        cursor === 1
          ? []
          : Array.from({ length: 10 }, (_, index) => ({
              post: {
                uri: `at://did:plc:test/app.bsky.feed.post/${start + index}`,
                author: { handle: "fixture.test" },
                record: {
                  text: `${start + index}: ${text}`,
                  createdAt: "2026-09-05T00:00:00Z",
                },
              },
            }));
      if (cursor > 2)
        feed.unshift({
          post: {
            uri: `at://did:plc:test/app.bsky.feed.post/${start - 1}`,
            author: { handle: "fixture.test" },
            record: { text },
          },
        });
      await route.fulfill({
        json: { feed, cursor: cursor < 8 ? String(cursor + 1) : undefined },
      });
    });
    await page.route("https://lemmy.world/**", async (route) => {
      await route.fulfill({
        json: {
          items: [
            {
              post: {
                id: 42,
                name: "Lemmy fixture",
                body: '**Safe markdown** <script>window.xss = true</script> [bad](javascript:alert(1)) <img src=x onerror="window.xss=true">',
              },
              creator: { name: "Alice" },
              community: { name: "dev" },
            },
          ],
        },
      });
    });
    await page.goto(`${base}/demos/feed/?retain=20&chunk=10`);
    await page.waitForFunction(
      () => document.querySelector("#viewport").dataset.retained === "10",
    );
    phase = "expand";
    await page.getByRole("button", { name: "Show more" }).first().click();
    await page.waitForFunction(() =>
      document.querySelector('.text-toggle[aria-expanded="true"]'),
    );
    assert.equal(await page.locator(".feed-edge button").count(), 0);
    assert.equal(
      await page.getByRole("link", { name: /^Open on / }).count(),
      0,
    );

    async function middle() {
      await page.evaluate(() => {
        const viewport = document.querySelector("#viewport");
        viewport.scrollTop =
          (viewport.scrollHeight - viewport.clientHeight) / 2;
        viewport.dispatchEvent(new Event("scroll"));
      });
      await page.waitForTimeout(180);
    }
    // Use only the runtime's existing reach callbacks; there are no host wheel,
    // touch, or pull-to-refresh handlers and no loader buttons.
    phase = "head refresh";
    await middle();
    headOffset = -2;
    holdHead = true;
    await page.evaluate(() => {
      const viewport = document.querySelector("#viewport");
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event("scroll"));
    });
    await page
      .locator(
        '.feed-edge[data-edge="start"][data-state="loading"] .boundary-spinner',
      )
      .waitFor();
    const oldPoint = await page
      .locator('article[data-post-key$="/0"]')
      .evaluate((row) => row.getBoundingClientRect().top);
    const headDeadline = Date.now() + 10_000;
    while (!releaseHead && Date.now() < headDeadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(releaseHead);
    holdHead = false;
    releaseHead();
    releaseHead = undefined;
    await page.waitForFunction(
      () => document.querySelector("#viewport").dataset.retained === "12",
    );
    const newPoint = await page
      .locator('article[data-post-key$="/0"]')
      .evaluate((row) => row.getBoundingClientRect().top);
    assert.ok(
      Math.abs(newPoint - oldPoint) <= 1,
      `new head moved reading point by ${newPoint - oldPoint}px`,
    );
    assert.equal(
      await page
        .locator('article[data-post-key$="/0"] .text-toggle')
        .getAttribute("aria-expanded"),
      "true",
    );

    async function atEnd() {
      await page.evaluate(() => {
        const viewport = document.querySelector("#viewport");
        viewport.scrollTop = viewport.scrollHeight;
        viewport.dispatchEvent(new Event("scroll"));
      });
    }
    phase = "paging";
    for (let step = 0; step < 5; step++) {
      const count =
        Number(await page.locator("#viewport").getAttribute("data-pages")) + 1;
      await middle();
      await atEnd();
      await page.waitForFunction(
        (count) =>
          Number(document.querySelector("#viewport").dataset.pages) >= count,
        count,
      );
      await page.waitForFunction(
        () =>
          !document.querySelector("#status").textContent.includes("loading"),
      );
      if (step === 0)
        assert.equal(
          await page.locator("#viewport").getAttribute("data-pages"),
          "3",
        );
    }
    // The budget is soft while an older page contains protected rows.
    // Intact overlapping pages can retain 21 unique posts here; move into
    // the loaded page before requiring the old page to be evicted.
    await page.evaluate(() => {
      const viewport = document.querySelector("#viewport");
      viewport.scrollTop += viewport.clientHeight * 3;
      viewport.dispatchEvent(new Event("scroll"));
    });
    await page.waitForFunction(
      () => Number(document.querySelector("#viewport").dataset.retained) <= 20,
    );
    assert.ok(
      Number(await page.locator("#viewport").getAttribute("data-evicted")) > 0,
    );
    const keys = await page
      .locator("#viewport article")
      .evaluateAll((rows) => rows.map((row) => row.dataset.postKey));
    assert.equal(new Set(keys).size, keys.length);

    phase = "load failure and retry";
    failNext = true;
    await middle();
    await atEnd();
    await page
      .locator('.feed-edge[data-edge="end"]')
      .filter({ hasText: "Couldn’t load posts" })
      .waitFor();
    assert.equal(
      await page.locator('.feed-edge[data-edge="end"]').textContent(),
      "Couldn’t load posts",
    );
    await middle();
    await atEnd();
    await page.waitForFunction(
      () => Number(document.querySelector("#viewport").dataset.pages) >= 8,
    );

    // A late, aborted old-source response may never resurrect the old session.
    phase = "source reset";
    holdHead = true;
    await page.getByRole("button", { name: "Refresh feed" }).click();
    const deadline = Date.now() + 10_000;
    while (!releaseHead && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(releaseHead, "refresh should request a fresh head");
    await page.getByLabel("Source", { exact: true }).selectOption("lemmy");
    await page.getByRole("heading", { name: "Lemmy fixture" }).waitFor();
    releaseHead();
    await page.waitForTimeout(100);
    assert.equal(await page.locator("#viewport article").count(), 1);
    assert.equal(
      await page.getByRole("link", { name: /^Open on / }).count(),
      0,
    );
    assert.equal(
      await page
        .locator(
          '#viewport script, #viewport [onerror], #viewport a[href^="javascript:"]',
        )
        .count(),
      0,
    );
    assert.equal(await page.evaluate(() => window.xss), undefined);
    assert.equal(
      await page.locator("#viewport strong").textContent(),
      "Safe markdown",
    );
    const height = await page
      .locator("header")
      .evaluate((header) => header.getBoundingClientRect().height);
    phase = "viewport resize";
    await page.setViewportSize({ width: 375, height: 720 });
    assert.equal(
      await page
        .locator("header")
        .evaluate((header) => header.getBoundingClientRect().height),
      height,
    );
    await page.route("https://feed-images.test/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="400"><rect width="200" height="400" fill="teal"/></svg>',
      }),
    );
    for (const width of [375, 1000]) {
      phase = `renderer fixtures at ${width}px`;
      await page.setViewportSize({ width, height: 720 });
      const expansions = await page.evaluate(async () => {
        const { renderPost } = await import("/demos/feed/render.ts");
        return [0, 1, 8].map((repeat) => {
          const post = {
            key: "margin-regression",
            author: "Bot",
            title: "",
            date: "",
            markdown: true,
            url: "",
            media: [],
            expanded: false,
            text: `${"A summary of the original article. ".repeat(16 * repeat)}\n\nOriginal: 39 words\n\nSummary: 29 words\n\nPercent reduction: 25.64%\n\n[I'm a bot and I'm open source](https://example.com/?${"x".repeat(600)})`,
          };
          const heights = [false, true].map((expanded) => {
            const row = renderPost({ ...post, expanded }, () => {});
            const viewport = document.querySelector("#viewport");
            const viewportHeight = viewport.clientHeight;
            // Renderer probes must not become flex siblings that shrink the
            // running feed and trigger unrelated observer/scroll work.
            row.style.cssText = "position:fixed;top:0;left:0;width:100%";
            document.body.append(row);
            if (viewport.clientHeight !== viewportHeight)
              throw new Error(
                "Renderer fixture resized the live feed viewport",
              );
            const height = row.getBoundingClientRect().height;
            const body = row.querySelector(".post-body");
            const clipped = body.scrollHeight > body.clientHeight;
            const toggleHidden = row.querySelector(".text-toggle").hidden;
            const faded = getComputedStyle(body).maskImage !== "none";
            row.remove();
            return { height, clipped, toggleHidden, faded };
          });
          return { collapsed: heights[0], expanded: heights[1] };
        });
      });
      for (const { collapsed, expanded } of expansions) {
        assert.ok(
          expanded.height >= collapsed.height,
          "Show more must never reduce row height",
        );
        if (collapsed.clipped) {
          assert.ok(expanded.height > collapsed.height);
          assert.equal(collapsed.toggleHidden, false);
          assert.equal(collapsed.faded, true);
        } else {
          assert.equal(expanded.height, collapsed.height);
          assert.equal(collapsed.toggleHidden, true);
          assert.equal(collapsed.faded, false);
        }
        assert.equal(expanded.faded, false);
      }
      phase = `image grids at ${width}px`;
      const grids = await page.evaluate(async () => {
        const { renderPost, mountPost, unmountPost } = await import(
          "/demos/feed/render.ts"
        );
        const { fetchFeedPage } = await import("/demos/feed/source.ts");
        const results = [];
        for (const count of [1, 2, 3, 4]) {
          const response = await fetchFeedPage(
            "bsky",
            undefined,
            10,
            new AbortController().signal,
            async () =>
              Response.json({
                feed: [
                  {
                    post: {
                      uri: "at://did:plc:test/app.bsky.feed.post/images",
                      author: { handle: "images.test" },
                      record: { text: "Images" },
                      embed: {
                        media: {
                          images: Array.from({ length: count }, (_, index) => ({
                            thumb: `https://feed-images.test/${index}.svg`,
                            fullsize: `https://feed-images.test/full/${index}.svg`,
                            alt: `Image ${index + 1}`,
                            aspectRatio: { width: 200, height: 400 },
                          })),
                        },
                      },
                    },
                  },
                ],
              }),
          );
          const row = renderPost(response.items[0], () => {});
          const viewport = document.querySelector("#viewport");
          const viewportHeight = viewport.clientHeight;
          row.style.cssText = "position:fixed;top:0;left:0;width:100%";
          document.body.append(row);
          if (viewport.clientHeight !== viewportHeight)
            throw new Error("Renderer fixture resized the live feed viewport");
          const before = row.getBoundingClientRect().height;
          mountPost(row);
          const images = [...row.querySelectorAll("img")];
          await Promise.all(images.map((image) => image.decode()));
          if (viewport.clientHeight !== viewportHeight)
            throw new Error("Image fixture resized the live feed viewport");
          const tiles = [...row.querySelectorAll(".post-image")].map((tile) => {
            const rect = tile.getBoundingClientRect();
            const image = tile.querySelector("img");
            const imageRect = image.getBoundingClientRect();
            return {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              imageWidth: imageRect.width,
              imageHeight: imageRect.height,
              fit: getComputedStyle(image).objectFit,
              background: getComputedStyle(image).backgroundColor,
            };
          });
          const after = row.getBoundingClientRect().height;
          unmountPost(row);
          results.push({
            count,
            before,
            after,
            tiles,
            released: images.every((image) => !image.hasAttribute("src")),
          });
          row.remove();
        }
        return results;
      });
      for (const grid of grids) {
        assert.equal(grid.tiles.length, grid.count);
        assert.equal(
          grid.after,
          grid.before,
          "image decoding must not change row height",
        );
        assert.equal(grid.released, true);
        for (const tile of grid.tiles) {
          assert.equal(tile.fit, "cover");
          assert.equal(tile.background, "rgba(0, 0, 0, 0)");
          assert.ok(Math.abs(tile.width - tile.imageWidth) < 0.1);
          assert.ok(Math.abs(tile.height - tile.imageHeight) < 0.1);
        }
        if (grid.count > 1) {
          assert.equal(grid.tiles[0].y, grid.tiles[1].y);
          assert.ok(grid.tiles[1].x > grid.tiles[0].x);
        }
        if (grid.count === 3)
          assert.ok(grid.tiles[2].width > grid.tiles[0].width * 2);
        if (grid.count === 4) assert.equal(grid.tiles[2].y, grid.tiles[3].y);
      }
    }
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: paging, eviction, empty continuation, retry, expansion, source reset, sanitization, narrow header, 1–4 image grids passed`,
    );
  } finally {
    await browser.close();
  }
}
