// Browser-side correctness scenario shared by Playwright and installed Safari.
// This deliberately reads layout at checkpoints; it is not a performance sampler.
export async function checkScopedTypography() {
  const { createVirtualList } = await import("/src/index.ts");
  const {
    prepareUserMessageCollapse,
    mountUserMessageCollapse,
    unmountUserMessageCollapse,
    syncUserMessageCollapse,
  } = await import("/integrations/index.ts");
  await import("/integrations/collapse.css");
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const frames = () =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  const settle = async () => {
    for (let i = 0; i < 6; i++) await frames();
  };
  const style = document.createElement("style");
  style.textContent = `
    .scope-test { --row-font: 23px; --row-line: 32px;
      font-family: monospace; color: #18202a; background: white; }
    .scope-test .message { margin: 0; padding: 12px; border: 0;
      box-sizing: border-box; display: block; }
    .scope-test .message-content { margin: 0; padding: 0; }
    .scope-test .markdown { font-family: inherit; font-size: var(--row-font);
      line-height: var(--row-line); letter-spacing: .4px; white-space: pre-wrap;
      overflow-wrap: anywhere; margin: 0; padding: 0; }
  `;
  document.head.append(style);
  const host = document.createElement("div");
  host.className = "scope-test";
  host.style.cssText =
    "position:fixed;left:20px;top:20px;width:540px;z-index:10000";
  const viewport = document.createElement("div");
  viewport.style.cssText = "height:360px;overflow:auto;overflow-anchor:none";
  host.append(viewport);
  const measurement = document.createElement("div");
  measurement.className = "scope-test";
  measurement.style.cssText = "position:fixed;width:0;height:0";
  document.body.append(host, measurement);
  const expanded = new Map();
  const prepared = [];
  const mounts = new Map();
  const firstMounts = [];
  let unmounts = 0;
  let destroys = 0;
  let list;
  const items = Array.from({ length: 20 }, (_, index) => ({
    id: String(index),
    text: Array.from(
      { length: index === 0 ? 1 : 8 },
      (_, line) =>
        `Scoped row ${index}, line ${line}: text wraps at narrow widths.`,
    ).join("\n"),
  }));
  const snapshots = [];
  try {
    list = createVirtualList(viewport, {
      items,
      key: (item) => item.id,
      overscanPx: 0,
      pinning: false,
      render: (item, existing) => {
        if (existing) {
          existing.querySelector(".markdown").textContent = item.text;
          return existing;
        }
        const row = document.createElement("article");
        row.className = "message user";
        row.dataset.key = item.id;
        row.innerHTML =
          '<div class="message-content"><div class="markdown-viewer"><div class="markdown"></div></div></div>';
        row.querySelector(".markdown").textContent = item.text;
        prepareUserMessageCollapse(
          row,
          Number(item.id) + 90000,
          expanded.get(item.id) ?? false,
          (value) => {
            expanded.set(item.id, value);
            queueMicrotask(() =>
              list.remeasure(item.id, { anchor: "viewport" }),
            );
          },
          viewport.clientWidth,
          measurement,
        );
        prepared.push({
          key: item.id,
          limit: row
            .querySelector(".user-message-body")
            .style.getPropertyValue("--user-message-limit"),
          detached: !row.isConnected,
        });
        return row;
      },
      onMount: (row, item) => {
        if (!mounts.has(item.id)) {
          const actual = row.getBoundingClientRect().height;
          const reserved = row.parentElement.getBoundingClientRect().height;
          firstMounts.push({ key: item.id, actual, reserved });
          check(
            Math.abs(actual - reserved) <= 1,
            `first mount must fit premeasured space: ${JSON.stringify(firstMounts.at(-1))}`,
          );
        }
        mounts.set(item.id, (mounts.get(item.id) ?? 0) + 1);
        mountUserMessageCollapse(row);
      },
      onUnmount: (row) => {
        unmounts++;
        unmountUserMessageCollapse(row);
      },
      onDestroy: () => destroys++,
    });
    await settle();
    check(prepared.length === items.length, "all unknown-height rows prepared");
    check(
      prepared.every((row) => row.detached),
      "preparation leaves rows detached",
    );
    check(
      prepared.every((row) => row.limit === "160px"),
      "scoped line height used before mount",
    );
    const inspect = (key, label) => {
      const row = list.elementOf(key);
      check(row, `${label}: row is mounted`);
      const body = row.querySelector(".user-message-body");
      const text = row.querySelector(".markdown");
      const toggle = row.querySelector(".user-message-toggle");
      const measured = row.getBoundingClientRect().height;
      const committed = list.positionOf(key).height;
      const snapshot = {
        label,
        measured,
        committed,
        width: row.getBoundingClientRect().width,
        lineHeight: getComputedStyle(text).lineHeight,
        fontSize: getComputedStyle(text).fontSize,
        limit: body.style.getPropertyValue("--user-message-limit"),
        collapsed: body.classList.contains("is-collapsed"),
        expanded: toggle.getAttribute("aria-expanded"),
        top:
          row.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top,
      };
      check(
        Math.abs(measured - committed) <= 1,
        `${label}: committed height matches mounted text: ${JSON.stringify(snapshot)}`,
      );
      snapshots.push(snapshot);
      return snapshot;
    };
    await list.scrollTo("1", { align: "start", behavior: "instant" });
    await settle();
    const initial = inspect("1", "initial");
    check(
      initial.collapsed &&
        initial.lineHeight === "32px" &&
        initial.fontSize === "23px",
      "custom typography and collapse applied",
    );
    const originalRow = list.elementOf("1");
    originalRow.querySelector("button").click();
    await settle();
    const open = inspect("1", "expanded");
    check(
      open.expanded === "true" && open.measured > initial.measured,
      "expansion uses full scoped text",
    );
    check(
      Math.abs(open.top - initial.top) <= 1,
      "expansion preserves reading point",
    );
    await list.scrollTo("end", { behavior: "instant" });
    await settle();
    check(list.elementOf("1") === null, "expanded row unmounted");
    await list.scrollTo("1", { align: "start", behavior: "instant" });
    await settle();
    check(
      list.elementOf("1") === originalRow,
      "unknown-height row reused on remount",
    );
    check(
      inspect("1", "remounted").expanded === "true",
      "expansion survives remount",
    );
    check(mounts.get("1") >= 2 && unmounts > 0, "mount lifecycle exercised");
    host.style.width = "320px";
    await settle();
    const narrow = inspect("1", "narrow");
    check(
      narrow.width < open.width && narrow.measured > open.measured,
      "resize remeasures scoped wrapping",
    );
    // Changed typography is host intent: update the list and the collapse
    // measurement container, then remeasure.
    for (const root of [host, measurement]) {
      root.style.setProperty("--row-font", "19px");
      root.style.setProperty("--row-line", "29px");
    }
    syncUserMessageCollapse(originalRow);
    list.remeasure("1", { anchor: "viewport" });
    await settle();
    originalRow.querySelector("button").click();
    await settle();
    const changed = inspect("1", "changed typography, collapsed");
    check(
      changed.collapsed &&
        changed.limit === "145px" &&
        changed.fontSize === "19px",
      "updated scoped CSS variables reach preparation and mounted content",
    );
    const next = items.map((item) =>
      item.id === "1" ? { ...item, text: "Short replacement" } : item,
    );
    list.setItems(next, { anchor: "viewport" });
    await settle();
    const short = inspect("1", "short replacement");
    check(
      !short.collapsed && short.measured < changed.measured,
      "short replacement removes collapse",
    );
    check(
      list.elementOf("1").querySelector("button").hidden,
      "short text hides toggle",
    );
    list.dispose();
    list = undefined;
    check(
      measurement.childElementCount === 0,
      "collapse preparation leaves its measurement container empty",
    );
    check(destroys === items.length, "every retained element destroyed once");
    return {
      snapshots,
      firstMounts,
      prepared: prepared.length,
      unmounts,
      destroys,
    };
  } finally {
    list?.dispose();
    host.remove();
    measurement.remove();
    style.remove();
  }
}
