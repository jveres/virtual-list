import { createVirtualList } from "/src/virtual-list.ts";

const viewport = document.querySelector("#viewport");
const status = document.querySelector("#status");
const items = Array.from({ length: 10000 }, (_, i) => ({
  id: String(i),
  height: 40 + (i % 5) * 12,
}));
const list = createVirtualList(viewport, {
  items,
  key: (item) => item.id,
  height: (item) => item.height,
  render: (item) => {
    const row = document.createElement("div");
    row.className = "row";
    row.style.height = `${item.height}px`;
    row.style.background = Number(item.id) % 2 ? "#eaf0f4" : "#fff";
    row.textContent = `Item ${item.id} — declared height ${item.height}px`;
    return row;
  },
  onState: (state) => {
    status.textContent = `${state.count} items; mounted range ${state.start}–${state.end}; held=${state.held}`;
  },
});
await list.scrollTo("5000", { align: "start" });
