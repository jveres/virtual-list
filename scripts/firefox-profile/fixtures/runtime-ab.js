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
const positionedRenderer = (item, existing) => {
  const el = existing ?? document.createElement("div");
  el.style.width = "160px";
  el.style.left = `${item.lane * 170}px`;
  el.textContent = item.text;
  return el;
};
const positionedItems = (count, prefix = "p", offsetIndex = 0) =>
  Array.from({ length: count }, (_, k) => {
    const i = offsetIndex + k;
    return {
      id: `${prefix}-${i}`,
      text: `Card ${i}`,
      height: 100 + (i % 3) * 16,
      top: Math.floor(i / 4) * 140 + (i % 4) * 7,
      lane: i % 4,
    };
  });

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
  /** Ten boots of ten thousand positioned cards (gallery masonry). */
  async "boot-positioned"(m) {
    const items = positionedItems(10000);
    const start = performance.now();
    for (let k = 0; k < 10; k++) {
      const v = makeHost("none");
      const list = m.createVirtualList(v, {
        items,
        key: (it) => it.id,
        height: (it) => it.height,
        position: (it) => ({ top: it.top, lane: it.lane }),
        render: positionedRenderer,
        boot: "start",
        settleStrategy: "default",
      });
      list.dispose();
      v.remove();
    }
    return performance.now() - start;
  },
  /** Gallery paging: forty positioned cards appended per call. */
  async "append-positioned"(m) {
    const v = makeHost("none");
    let next = positionedItems(10000);
    const list = m.createVirtualList(v, {
      items: next,
      key: (it) => it.id,
      height: (it) => it.height,
      position: (it) => ({ top: it.top, lane: it.lane }),
      render: positionedRenderer,
      boot: "start",
      settleStrategy: "default",
    });
    const start = performance.now();
    for (let k = 0; k < 50; k++) {
      next = [...next, ...positionedItems(40, "p", 10000 + k * 40)];
      list.setItems(next);
    }
    const dt = performance.now() - start;
    list.dispose();
    v.remove();
    return dt;
  },
  /** Positioned layout replaced wholesale (a column-count change). */
  async "relayout-positioned"(m) {
    const v = makeHost("none");
    const items = positionedItems(10000);
    const list = m.createVirtualList(v, {
      items,
      key: (it) => it.id,
      height: (it) => it.height,
      position: (it) => ({ top: it.top, lane: it.lane }),
      render: positionedRenderer,
      boot: "start",
      settleStrategy: "default",
    });
    v.scrollTop = 100000;
    v.dispatchEvent(new Event("scroll"));
    const start = performance.now();
    for (let k = 0; k < 20; k++) {
      const cols = k % 2 === 0 ? 5 : 3;
      list.setItems(
        items.map((it, i) => ({
          ...it,
          top: Math.floor(i / cols) * 140 + (i % cols) * 7,
          lane: i % cols,
        })),
      );
    }
    const dt = performance.now() - start;
    list.dispose();
    v.remove();
    return dt;
  },
  /** Single-item content edits on a positioned card whose placement stays put. */
  async "update-positioned"(m) {
    const v = makeHost("none");
    const items = positionedItems(5000);
    const list = m.createVirtualList(v, {
      items,
      key: (it) => it.id,
      height: (it) => it.height,
      position: (it) => ({ top: it.top, lane: it.lane }),
      render: positionedRenderer,
      boot: "start",
      settleStrategy: "default",
    });
    const start = performance.now();
    for (let k = 0; k < 50; k++) {
      const it = items[10];
      list.updateItem(it.id, { ...it, text: `Card 10 edit ${k}` });
    }
    const dt = performance.now() - start;
    list.dispose();
    v.remove();
    return dt;
  },
  /** Single-item edits on a positioned card whose height/top shifts. */
  async "update-positioned-move"(m) {
    const v = makeHost("none");
    const items = positionedItems(5000);
    const list = m.createVirtualList(v, {
      items,
      key: (it) => it.id,
      height: (it) => it.height,
      position: (it) => ({ top: it.top, lane: it.lane }),
      render: positionedRenderer,
      boot: "start",
      settleStrategy: "default",
    });
    const start = performance.now();
    for (let k = 0; k < 50; k++) {
      const it = items[10];
      list.updateItem(it.id, {
        ...it,
        text: `Card 10 move ${k}`,
        height: it.height + (k % 3) * 8,
        top: it.top + (k % 2) * 4,
      });
    }
    const dt = performance.now() - start;
    list.dispose();
    v.remove();
    return dt;
  },
  /** Single-item edits on declared rows, half changing height. */
  async "update-declared"(m) {
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
    const start = performance.now();
    for (let k = 0; k < 300; k++) {
      const idx = k % 15;
      list.updateItem(`d-${idx}`, {
        id: `d-${idx}`,
        text: `Row ${idx} v${k}`,
        height: 44 + ((idx + (k >> 1)) % 5) * 12,
      });
    }
    const dt = performance.now() - start;
    list.dispose();
    v.remove();
    return dt;
  },
  /** History paging on a declared list: forty rows prepended per call. */
  async "prepend-declared"(m) {
    const v = makeHost("none");
    let next = declaredItems(10000);
    const list = m.createVirtualList(v, {
      items: next,
      key: (it) => it.id,
      height: (it) => it.height,
      render: declaredRenderer,
      boot: "end",
      settleStrategy: "default",
    });
    const start = performance.now();
    for (let k = 0; k < 30; k++) {
      const page = Array.from({ length: 40 }, (_, i) => ({
        id: `pre-${k}-${i}`,
        text: "Pre",
        height: 44 + (i % 5) * 12,
      }));
      next = [...page, ...next];
      list.setItems(next, { anchor: "viewport" });
    }
    const dt = performance.now() - start;
    list.dispose();
    v.remove();
    return dt;
  },
  /** Conversation branch switches replacing the trailing forty measured rows. */
  async "branch-switch-measured"(m) {
    const v = makeHost("auto");
    const prefix = measuredItems(1960, "base");
    const branchA = measuredItems(40, "brA");
    const branchB = measuredItems(40, "brB");
    const setA = [...prefix, ...branchA];
    const setB = [...prefix, ...branchB];
    const list = m.createVirtualList(v, {
      items: setA,
      key: (i) => i.id,
      render: measuredRenderer,
      boot: "end",
      settleStrategy: "default",
    });
    await frame();
    const start = performance.now();
    for (let k = 0; k < 40; k++) {
      list.setItems(k % 2 === 0 ? setB : setA, { anchor: "viewport" });
    }
    const dt = performance.now() - start;
    list.dispose();
    v.remove();
    return dt;
  },
  /** Live item edits through createPagedWindow across four thousand retained rows. */
  async "paging-live-edit"(m) {
    const v = makeHost("none");
    const pages = Array.from({ length: 10 }, (_, p) => ({
      items: Array.from({ length: 400 }, (_, i) => ({
        id: `pg-${p * 400 + i}`,
        text: `Item ${p * 400 + i}`,
        height: 48,
      })),
      start: p > 0 ? { available: true, cursor: p - 1 } : { available: false },
      end: p < 9 ? { available: true, cursor: p + 1 } : { available: false },
    }));
    const list = m.createVirtualList(v, {
      items: pages[0].items,
      key: (it) => it.id,
      height: (it) => it.height,
      render: declaredRenderer,
      boot: "start",
      settleStrategy: "default",
    });
    const pager = m.createPagedWindow({
      list,
      initial: pages[0],
      maxItems: 5000,
      key: (it) => it.id,
      keysOf: (it) => [it.id],
      project: (items) => items,
      live: { project: (it) => it, key: (it) => it.id },
      load: async ({ cursor }) => pages[cursor],
    });
    for (let c = 1; c < 10; c++) await pager.load("end");
    const start = performance.now();
    for (let k = 0; k < 200; k++) {
      await pager.updateItemLive("pg-3999", (it) => ({
        ...it,
        text: `Item 3999 edit ${k}`,
      }));
    }
    const dt = performance.now() - start;
    pager.dispose();
    list.dispose();
    v.remove();
    return dt;
  },
  /** Overlapping page loads, jumps, and budget trims through createPagedWindow. */
  async "paging-load-trim"(m) {
    const v = makeHost("none");
    const pageSize = 400;
    const overlap = 40;
    const makePage = (cursor) => {
      const first = cursor * (pageSize - overlap);
      return {
        items: Array.from({ length: pageSize }, (_, i) => ({
          id: `pg-${first + i}`,
          text: `Item ${first + i}`,
          height: 48,
        })),
        start:
          cursor > 0
            ? { available: true, cursor: cursor - 1 }
            : { available: false },
        end: { available: true, cursor: cursor + 1 },
      };
    };
    const initial = makePage(50);
    const list = m.createVirtualList(v, {
      items: initial.items,
      key: (it) => it.id,
      height: (it) => it.height,
      render: declaredRenderer,
      boot: "start",
      settleStrategy: "default",
    });
    const pager = m.createPagedWindow({
      list,
      initial,
      maxItems: 4000,
      key: (it) => it.id,
      keysOf: (it) => [it.id],
      project: (items) => items,
      load: async ({ cursor }) => makePage(cursor),
    });
    const start = performance.now();
    for (let k = 0; k < 40; k++) {
      await pager.load("end");
      await list.scrollTo("end");
      await pager.reconcile();
    }
    const dt = performance.now() - start;
    pager.dispose();
    list.dispose();
    v.remove();
    return dt;
  },
  /** Scrolling and state refreshes with createStickyHeaders over 100 groups. */
  async "sticky-headers"(m) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:relative;width:700px;height:800px";
    const v = document.createElement("div");
    v.style.cssText =
      "width:700px;height:800px;overflow:auto;overflow-anchor:none";
    wrap.appendChild(v);
    document.body.appendChild(wrap);
    const items = declaredItems(2000);
    const hKeys = [];
    for (let i = 0; i < 2000; i += 20) hKeys.push(`d-${i}`);
    let sticky = null;
    const list = m.createVirtualList(v, {
      items,
      key: (it) => it.id,
      height: (it) => it.height,
      render: declaredRenderer,
      boot: "start",
      settleStrategy: "default",
      onState: (_s, vp) => sticky?.refresh(vp.scrollTop),
      onViewport: (vp) => sticky?.update(vp.scrollTop),
    });
    sticky = m.createStickyHeaders({
      container: wrap,
      viewport: v,
      headerKeys: () => hKeys,
      positionOf: (k) => list.positionOf(k),
      elementOf: (k) => list.elementOf(k),
      renderHeader: (slot, ord) => {
        slot.textContent = `Group ${ord}`;
      },
    });
    const start = performance.now();
    for (let k = 1; k <= 600; k++) {
      v.scrollTop = k * 80;
      v.dispatchEvent(new Event("scroll"));
      if (k % 15 === 0) sticky.refresh(v.scrollTop);
    }
    const dt = performance.now() - start;
    sticky.destroy();
    list.dispose();
    wrap.remove();
    return dt;
  },
};
