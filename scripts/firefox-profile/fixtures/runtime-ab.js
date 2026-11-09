// Deterministic synthetic workloads for runtime-ab.mjs. Each scenario takes a
// runtime module and returns the elapsed milliseconds of its timed section.
// JavaScript and layout only; no paint or native input.
const frame = () => new Promise(requestAnimationFrame);
const text = (id) => "lorem ipsum dolor sit amet ".repeat(1 + (id % 9));

function makeHost(anchor) {
  const v = document.createElement("div");
  v.style.cssText = `width:700px;height:800px;overflow:auto;overflow-anchor:${anchor}`;
  document.body.appendChild(v);
  return v;
}

const measuredRenderer = (item, existing) => {
  const el = existing ?? document.createElement("div");
  el.style.cssText = "padding:4px;font:14px/20px sans-serif";
  el.textContent = item.text;
  return el;
};
const declaredRenderer = (item, existing) => {
  const el = existing ?? document.createElement("div");
  el.style.cssText = `box-sizing:border-box;height:${item.height}px;font:14px/20px sans-serif`;
  el.textContent = item.text;
  return el;
};
const measuredItems = (count, prefix = "m") =>
  Array.from({ length: count }, (_, id) => ({
    id: `${prefix}-${id}`,
    text: text(id),
  }));
const declaredItems = (count) =>
  Array.from({ length: count }, (_, i) => ({
    id: `d-${i}`,
    text: `Row ${i}`,
    height: 44 + (i % 5) * 12,
  }));

function measuredList(m, anchor, boot, count = 2000, extra = {}) {
  const v = makeHost(anchor);
  const items = measuredItems(count);
  const list = m.createVirtualList(v, {
    items,
    key: (i) => i.id,
    render: measuredRenderer,
    boot,
    settleStrategy: "default",
    ...extra,
  });
  return { v, items, list };
}

export const scenarios = {
  /** Streaming tokens into the last row at the end, native anchoring. */
  async "stream-native"(m) {
    const { v, list } = measuredList(m, "auto", "end");
    await frame();
    let t = "";
    const start = performance.now();
    for (let k = 0; k < 600; k++) {
      t += k % 12 === 0 ? "word word word word word word " : "x";
      list.updateItem("m-1999", { id: "m-1999", text: t });
    }
    const dt = performance.now() - start;
    list.dispose();
    v.remove();
    return dt;
  },
  /** The same with runtime anchoring (Safari's path). */
  async "stream-runtime"(m) {
    const { v, list } = measuredList(m, "none", "end");
    await frame();
    let t = "";
    const start = performance.now();
    for (let k = 0; k < 600; k++) {
      t += k % 12 === 0 ? "word word word word word word " : "x";
      list.updateItem("m-1999", { id: "m-1999", text: t });
    }
    const dt = performance.now() - start;
    list.dispose();
    v.remove();
    return dt;
  },
  /** Streaming with declarative pinning and follow callbacks, as the chat demo configures. */
  async "stream-chat-options"(m) {
    const { v, list } = measuredList(m, "auto", "end", 2000, {
      pinning: { match: (item) => item.id === "m-1998", offset: 8 },
      followBehavior: "smooth",
      followMode: "keep-content",
      followStart: (_item, element) => element,
      onState() {},
      onViewport() {},
      onReachStart() {},
    });
    await frame();
    let t = "";
    const start = performance.now();
    for (let k = 0; k < 600; k++) {
      t += k % 12 === 0 ? "word word word word word word " : "x";
      list.updateItem("m-1999", { id: "m-1999", text: t });
    }
    const dt = performance.now() - start;
    list.dispose();
    v.remove();
    return dt;
  },
  async "scroll-native"(m) {
    const { v, list } = measuredList(m, "auto", "start");
    await frame();
    const start = performance.now();
    for (let k = 1; k <= 600; k++) {
      v.scrollTop = k * 53;
      v.dispatchEvent(new Event("scroll"));
    }
    const dt = performance.now() - start;
    list.dispose();
    v.remove();
    return dt;
  },
  async "scroll-runtime"(m) {
    const { v, list } = measuredList(m, "none", "start");
    await frame();
    const start = performance.now();
    for (let k = 1; k <= 600; k++) {
      v.scrollTop = k * 53;
      v.dispatchEvent(new Event("scroll"));
    }
    const dt = performance.now() - start;
    list.dispose();
    v.remove();
    return dt;
  },
  async "scroll-declared"(m) {
    const v = makeHost("none");
    const items = declaredItems(10000);
    const list = m.createVirtualList(v, {
      items,
      key: (it) => it.id,
      height: (it) => it.height,
      render: declaredRenderer,
      boot: "start",
      settleStrategy: "default",
    });
    await frame();
    const start = performance.now();
    for (let k = 1; k <= 600; k++) {
      v.scrollTop = k * 53;
      v.dispatchEvent(new Event("scroll"));
    }
    const dt = performance.now() - start;
    list.dispose();
    v.remove();
    return dt;
  },
  async "scroll-positioned"(m) {
    const v = makeHost("none");
    const items = Array.from({ length: 10000 }, (_, i) => ({
      id: `p-${i}`,
      text: `Card ${i}`,
      height: 100 + (i % 3) * 16,
      top: Math.floor(i / 4) * 140 + (i % 4) * 7,
      lane: i % 4,
    }));
    const list = m.createVirtualList(v, {
      items,
      key: (it) => it.id,
      height: (it) => it.height,
      position: (it) => ({ top: it.top, lane: it.lane }),
      render: (item, existing) => {
        const el = existing ?? document.createElement("div");
        el.style.width = "160px";
        el.style.left = `${item.lane * 170}px`;
        el.textContent = item.text;
        return el;
      },
      boot: "start",
      settleStrategy: "default",
    });
    await frame();
    const start = performance.now();
    for (let k = 1; k <= 600; k++) {
      v.scrollTop = k * 53;
      v.dispatchEvent(new Event("scroll"));
    }
    const dt = performance.now() - start;
    list.dispose();
    v.remove();
    return dt;
  },
  /** A new message per call: the key order grows by one. */
  async "append-measured"(m) {
    const { v, items, list } = measuredList(m, "auto", "end");
    await frame();
    let next = items;
    const start = performance.now();
    for (let k = 0; k < 100; k++) {
      next = [...next, { id: `a-${k}`, text: text(k) }];
      list.setItems(next);
    }
    const dt = performance.now() - start;
    list.dispose();
    v.remove();
    return dt;
  },
  /** History paging: twenty rows prepended per call, away from the edges. */
  async "prepend-measured"(m) {
    const { v, items, list } = measuredList(m, "auto", "end", 500);
    await frame();
    let next = items;
    const start = performance.now();
    for (let k = 0; k < 30; k++) {
      next = [...measuredItems(20, `h${k}`), ...next];
      list.setItems(next);
    }
    const dt = performance.now() - start;
    list.dispose();
    v.remove();
    return dt;
  },
  /** An unchanged snapshot resubmitted (a host store notifying without a diff). */
  async "setitems-same"(m) {
    const { v, items, list } = measuredList(m, "auto", "start", 5000);
    v.scrollTop = 90000;
    v.dispatchEvent(new Event("scroll"));
    const start = performance.now();
    for (let k = 0; k < 50; k++) list.setItems(items);
    const dt = performance.now() - start;
    list.dispose();
    v.remove();
    return dt;
  },
  async "boot-measured"(m) {
    const start = performance.now();
    for (let k = 0; k < 4; k++) {
      const { v, list } = measuredList(m, "auto", "end", 400);
      list.dispose();
      v.remove();
    }
    return performance.now() - start;
  },
  async "boot-declared"(m) {
    const items = declaredItems(20000);
    const start = performance.now();
    for (let k = 0; k < 10; k++) {
      const v = makeHost("none");
      const list = m.createVirtualList(v, {
        items,
        key: (it) => it.id,
        height: (it) => it.height,
        render: declaredRenderer,
        boot: "end",
        settleStrategy: "default",
      });
      list.dispose();
      v.remove();
    }
    return performance.now() - start;
  },
  /** Gallery paging: a page of forty declared rows appended per call. */
  async "append-declared"(m) {
    const v = makeHost("none");
    let next = declaredItems(10000);
    const list = m.createVirtualList(v, {
      items: next,
      key: (it) => it.id,
      height: (it) => it.height,
      render: declaredRenderer,
      boot: "start",
      settleStrategy: "default",
    });
    const start = performance.now();
    for (let k = 0; k < 50; k++) {
      const page = Array.from({ length: 40 }, (_, i) => ({
        id: `page-${k}-${i}`,
        text: "Row",
        height: 44 + (i % 5) * 12,
      }));
      next = [...next, ...page];
      list.setItems(next);
    }
    const dt = performance.now() - start;
    list.dispose();
    v.remove();
    return dt;
  },
  /** A declared snapshot whose one mid-list height changes per call. */
  async "midlist-declared"(m) {
    const v = makeHost("none");
    const items = declaredItems(10000);
    const list = m.createVirtualList(v, {
      items,
      key: (it) => it.id,
      height: (it) => it.height,
      render: declaredRenderer,
      boot: "start",
      settleStrategy: "default",
    });
    v.scrollTop = 250000;
    v.dispatchEvent(new Event("scroll"));
    const start = performance.now();
    for (let k = 0; k < 50; k++) {
      items[5000] = {
        id: "d-5000",
        text: `Row ${k}`,
        height: 44 + (k % 5) * 12,
      };
      list.setItems(items);
    }
    const dt = performance.now() - start;
    list.dispose();
    v.remove();
    return dt;
  },
  /** A declared layout replaced wholesale (a column-count change). */
  async "relayout-declared"(m) {
    const v = makeHost("none");
    const items = declaredItems(10000);
    const list = m.createVirtualList(v, {
      items,
      key: (it) => it.id,
      height: (it) => it.height,
      render: declaredRenderer,
      boot: "start",
      settleStrategy: "default",
    });
    v.scrollTop = 250000;
    v.dispatchEvent(new Event("scroll"));
    const start = performance.now();
    for (let k = 0; k < 20; k++)
      list.setItems(
        items.map((item) => ({ ...item, height: item.height + 1 + (k % 2) })),
      );
    const dt = performance.now() - start;
    list.dispose();
    v.remove();
    return dt;
  },
  /** Every connected row is re-read at a new width. */
  async "width-resize"(m) {
    const { v, list } = measuredList(m, "auto", "start", 600);
    await frame();
    v.scrollTop = 20000;
    v.dispatchEvent(new Event("scroll"));
    await frame();
    const start = performance.now();
    for (let k = 0; k < 12; k++) {
      v.style.width = `${700 - (k % 2) * 120}px`;
      await frame();
      await frame();
    }
    const dt = performance.now() - start;
    list.dispose();
    v.remove();
    return dt;
  },
};
