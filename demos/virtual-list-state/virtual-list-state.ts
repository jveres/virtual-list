import {
  createVirtualList,
  type VirtualList,
  type VirtualListBoundary,
  type VirtualListBoundarySlot,
  type VirtualListRenderMode,
  type VirtualListState,
} from "../../src/virtual-list.js";
import { watchSystemTheme } from "../shared/theme.js";
import {
  bindThemeButtons,
  clamp,
  mustGet,
  refreshTheme,
  setTextIfChanged,
} from "../shared/utils.js";

import "../shared/styles.css";
import "./virtual-list-state.css";

interface DemoOptions {
  boundarySlots: boolean;
  count: number;
  itemBaseHeight: number;
  itemVariance: number;
  measureEpsilon: number;
  overscanPx: number;
  placeholderVelocityThreshold: number;
  placeholders: boolean;
  renderMode: VirtualListRenderMode;
}

type StateEvent =
  | "boundary:bottom"
  | "boundary:top"
  | "init"
  | "options"
  | "range"
  | "scroll"
  | "scroll-end"
  | "scroll-start";

const DEFAULT_OPTIONS: DemoOptions = {
  boundarySlots: true,
  count: 1_200,
  itemBaseHeight: 118,
  itemVariance: 120,
  measureEpsilon: 0.5,
  overscanPx: 800,
  placeholderVelocityThreshold: 8,
  placeholders: true,
  renderMode: "virtual",
};

const viewport = mustGet("viewport");
const topBtn = mustGet("top-btn", HTMLButtonElement);
const bottomBtn = mustGet("bottom-btn", HTMLButtonElement);
const stateRange = mustGet("state-range");
const stateMounted = mustGet("state-mounted");
const stateMeasured = mustGet("state-measured");
const stateScroll = mustGet("state-scroll");
const stateTotal = mustGet("state-total");
const stateEdges = mustGet("state-edges");
const stateEvent = mustGet("state-event");
const statusSummary = mustGet("status-summary");
const statusCallback = mustGet("status-callback");

const countInput = mustGet("count-input", HTMLInputElement);
const countValue = mustGet("count-value", HTMLOutputElement);
const overscanInput = mustGet("overscan-input", HTMLInputElement);
const overscanValue = mustGet("overscan-value", HTMLOutputElement);
const baseHeightInput = mustGet("base-height-input", HTMLInputElement);
const baseHeightValue = mustGet("base-height-value", HTMLOutputElement);
const varianceInput = mustGet("variance-input", HTMLInputElement);
const varianceValue = mustGet("variance-value", HTMLOutputElement);
const measureEpsilonInput = mustGet("measure-epsilon-input", HTMLInputElement);
const measureEpsilonValue = mustGet("measure-epsilon-value", HTMLOutputElement);
const placeholderThresholdInput = mustGet(
  "placeholder-threshold-input",
  HTMLInputElement,
);
const placeholderThresholdValue = mustGet(
  "placeholder-threshold-value",
  HTMLOutputElement,
);
const renderModeSelect = mustGet("render-mode-select", HTMLSelectElement);
const placeholderToggle = mustGet("placeholder-toggle", HTMLInputElement);
const boundaryToggle = mustGet("boundary-toggle", HTMLInputElement);

let options: DemoOptions = { ...DEFAULT_OPTIONS };
let virtualList: VirtualList | null = null;
let optionFrame = 0;
let stateFrame = 0;
let lastEvent: StateEvent = "init";
let lastStateText = "";

function numericInputValue(input: HTMLInputElement, fallback: number): number {
  const value = Number(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function itemNoise(index: number): number {
  const value = Math.sin(index * 12.9898 + 78.233) * 43_758.5453;
  return value - Math.floor(value);
}

function itemHeight(index: number): number {
  const wave = Math.sin(index * 0.17) * 0.5 + 0.5;
  const noise = itemNoise(index);
  const variance = options.itemVariance * (wave * 0.65 + noise * 0.35);
  return Math.round(options.itemBaseHeight + variance);
}

function itemHue(index: number): number {
  return Math.round((index * 37) % 360);
}

function itemProgress(index: number): string {
  const progress = 0.18 + itemNoise(index + 17) * 0.82;
  return progress.toFixed(3);
}

function px(value: number): string {
  return `${Math.round(value).toLocaleString()}px`;
}

function buildItem(index: number): HTMLElement {
  const row = document.createElement("article");
  row.className = "state-row";
  row.style.height = `${itemHeight(index)}px`;
  row.style.setProperty("--row-hue", String(itemHue(index)));
  row.style.setProperty("--row-progress", itemProgress(index));

  const inner = document.createElement("div");
  inner.className = "state-row-inner";

  const itemIndex = document.createElement("div");
  itemIndex.className = "state-index";
  itemIndex.textContent = `#${index.toLocaleString()}`;

  const main = document.createElement("div");
  main.className = "state-item-main";

  const title = document.createElement("div");
  title.className = "state-item-title";
  title.textContent = `Measured row ${index.toLocaleString()}`;

  const track = document.createElement("div");
  track.className = "state-item-track";
  const fill = document.createElement("div");
  fill.className = "state-item-fill";
  track.append(fill);
  main.append(title, track);

  const meta = document.createElement("div");
  meta.className = "state-item-meta";
  meta.textContent = `${itemHeight(index)}px model`;

  inner.append(itemIndex, main, meta);
  row.append(inner);
  return row;
}

function buildPlaceholder(index: number): HTMLElement {
  const row = document.createElement("article");
  row.className = "state-row state-row-placeholder";
  row.style.height = `${itemHeight(index)}px`;

  const inner = document.createElement("div");
  inner.className = "state-row-inner";

  const itemIndex = document.createElement("div");
  itemIndex.className = "state-index";
  itemIndex.textContent = `#${index.toLocaleString()}`;

  const line = document.createElement("div");
  line.className = "state-placeholder-line";

  const pill = document.createElement("div");
  pill.className = "state-placeholder-pill";

  inner.append(itemIndex, line, pill);
  row.append(inner);
  return row;
}

function boundarySlot(
  boundary: VirtualListBoundary,
): VirtualListBoundarySlot | null {
  if (!options.boundarySlots) return null;
  return {
    key: `${boundary}:state-demo`,
    height: 48,
    build: () => {
      const element = document.createElement("div");
      element.className = "state-boundary";
      element.textContent =
        boundary === "top" ? "top boundary" : "bottom boundary";
      return element;
    },
  };
}

function syncBoundarySlots(): void {
  virtualList?.setBoundarySlot("top", boundarySlot("top"));
  virtualList?.setBoundarySlot("bottom", boundarySlot("bottom"));
}

function syncEmptySlot(): void {
  virtualList?.setPlaceholderSlot({
    key: "state-empty",
    build: () => {
      const element = document.createElement("div");
      element.className = "state-empty";
      element.textContent = "No items";
      return element;
    },
  });
}

function stateEdgeText(state: VirtualListState): string {
  if (state.atTop && state.atBottom) return "top + bottom";
  if (state.atTop) return "top";
  if (state.atBottom) return "bottom";
  return "middle";
}

function renderState(
  state: VirtualListState,
  event: StateEvent = lastEvent,
): void {
  lastEvent = event;
  const rangeText = `${state.range.start.toLocaleString()}-${state.range.end.toLocaleString()} / ${state.count.toLocaleString()}`;
  const mountedText = state.mountedCount.toLocaleString();
  const measuredText = state.measuredCount.toLocaleString();
  const scrollText = `${px(state.scrollTop)} / ${px(state.scrollMax)}`;
  const totalText = px(state.totalSize);
  const edgesText = stateEdgeText(state);
  const statusText = `${state.count.toLocaleString()} items · ${options.renderMode} · ${options.overscanPx}px overscan`;
  const signature = [
    rangeText,
    mountedText,
    measuredText,
    scrollText,
    totalText,
    edgesText,
    event,
    statusText,
  ].join("|");

  if (signature === lastStateText) return;
  lastStateText = signature;
  setTextIfChanged(stateRange, rangeText);
  setTextIfChanged(stateMounted, mountedText);
  setTextIfChanged(stateMeasured, measuredText);
  setTextIfChanged(stateScroll, scrollText);
  setTextIfChanged(stateTotal, totalText);
  setTextIfChanged(stateEdges, edgesText);
  setTextIfChanged(stateEvent, event);
  setTextIfChanged(statusSummary, statusText);
  setTextIfChanged(statusCallback, event);
}

function scheduleStateRender(event: StateEvent = lastEvent): void {
  lastEvent = event;
  if (stateFrame) return;
  stateFrame = requestAnimationFrame(() => {
    stateFrame = 0;
    if (virtualList) renderState(virtualList.state, lastEvent);
  });
}

function effectivePlaceholderThreshold(): number {
  return options.placeholders
    ? options.placeholderVelocityThreshold
    : Number.POSITIVE_INFINITY;
}

function createVirtualizer(
  keepScrollTop = 0,
  event: StateEvent = "init",
): void {
  virtualList?.dispose();
  virtualList = createVirtualList({
    viewport,
    canvasClassName: "state-canvas",
    getCount: () => options.count,
    getItemHeight: itemHeight,
    buildItem,
    buildPlaceholder: options.placeholders ? buildPlaceholder : undefined,
    placeholderVelocityThreshold: effectivePlaceholderThreshold,
    overscanPx: () => options.overscanPx,
    renderMode: options.renderMode,
    measureEpsilon: options.measureEpsilon,
    onRangeChange: (state) => renderState(state, "range"),
    onReachTop: (state) => renderState(state, "boundary:top"),
    onReachBottom: (state) => renderState(state, "boundary:bottom"),
    onScrollStart: (state) => renderState(state, "scroll-start"),
    onScrollEnd: (state) => renderState(state, "scroll-end"),
  });
  syncBoundarySlots();
  syncEmptySlot();
  void virtualList
    .scrollToOffset(clamp(keepScrollTop, 0, virtualList.state.scrollMax))
    .then(() => scheduleStateRender(event));
}

function syncControlValues(): void {
  countInput.value = String(options.count);
  overscanInput.value = String(options.overscanPx);
  baseHeightInput.value = String(options.itemBaseHeight);
  varianceInput.value = String(options.itemVariance);
  measureEpsilonInput.value = String(options.measureEpsilon);
  placeholderThresholdInput.value = String(
    options.placeholderVelocityThreshold,
  );
  renderModeSelect.value = options.renderMode;
  placeholderToggle.checked = options.placeholders;
  boundaryToggle.checked = options.boundarySlots;

  countValue.textContent = options.count.toLocaleString();
  overscanValue.textContent = `${options.overscanPx}px`;
  baseHeightValue.textContent = `${options.itemBaseHeight}px`;
  varianceValue.textContent = `${options.itemVariance}px`;
  measureEpsilonValue.textContent = options.measureEpsilon.toFixed(2);
  placeholderThresholdValue.textContent =
    options.placeholderVelocityThreshold.toFixed(2);
}

function readOptionsFromControls(): DemoOptions {
  return {
    boundarySlots: boundaryToggle.checked,
    count: Math.round(numericInputValue(countInput, options.count)),
    itemBaseHeight: Math.round(
      numericInputValue(baseHeightInput, options.itemBaseHeight),
    ),
    itemVariance: Math.round(
      numericInputValue(varianceInput, options.itemVariance),
    ),
    measureEpsilon: numericInputValue(
      measureEpsilonInput,
      options.measureEpsilon,
    ),
    overscanPx: Math.round(
      numericInputValue(overscanInput, options.overscanPx),
    ),
    placeholderVelocityThreshold: numericInputValue(
      placeholderThresholdInput,
      options.placeholderVelocityThreshold,
    ),
    placeholders: placeholderToggle.checked,
    renderMode:
      renderModeSelect.value === "full" || renderModeSelect.value === "virtual"
        ? renderModeSelect.value
        : "virtual",
  };
}

// Derived from DEFAULT_OPTIONS so a new option is covered automatically
// instead of silently escaping change detection.
const OPTION_KEYS = Object.keys(DEFAULT_OPTIONS) as ReadonlyArray<
  keyof DemoOptions
>;
// Changing only these swaps placeholder behavior without rebuilding the list.
const PLACEHOLDER_OPTION_KEYS: ReadonlyArray<keyof DemoOptions> = [
  "placeholders",
  "placeholderVelocityThreshold",
];

function changedOptionKeys(
  a: DemoOptions,
  b: DemoOptions,
): (keyof DemoOptions)[] {
  return OPTION_KEYS.filter((key) => a[key] !== b[key]);
}

function optionsEqual(a: DemoOptions, b: DemoOptions): boolean {
  return changedOptionKeys(a, b).length === 0;
}

function scheduleOptionApply(): void {
  const previousOptions = options;
  options = readOptionsFromControls();
  syncControlValues();

  if (optionsEqual(previousOptions, options)) {
    scheduleStateRender("options");
    return;
  }

  // Past the equal-options return above, so at least one key changed.
  const onlyPlaceholderOptionsChanged = changedOptionKeys(
    previousOptions,
    options,
  ).every((key) => PLACEHOLDER_OPTION_KEYS.includes(key));

  if (onlyPlaceholderOptionsChanged && virtualList) {
    if (!options.placeholders) {
      virtualList.refreshMounted();
      void virtualList.scrollToOffset(virtualList.state.scrollTop);
    }
    scheduleStateRender("options");
    return;
  }

  if (optionFrame) cancelAnimationFrame(optionFrame);
  optionFrame = requestAnimationFrame(() => {
    optionFrame = 0;
    const keepScrollTop = virtualList?.state.scrollTop ?? viewport.scrollTop;
    createVirtualizer(keepScrollTop, "options");
  });
}

function bindControls(): void {
  const optionInputs: HTMLElement[] = [
    countInput,
    overscanInput,
    baseHeightInput,
    varianceInput,
    measureEpsilonInput,
    placeholderThresholdInput,
    renderModeSelect,
    placeholderToggle,
    boundaryToggle,
  ];

  for (const input of optionInputs) {
    input.addEventListener("input", scheduleOptionApply);
    input.addEventListener("change", scheduleOptionApply);
  }

  topBtn.addEventListener("click", () => {
    void virtualList?.scrollToTop({ behavior: "smooth" });
  });
  bottomBtn.addEventListener("click", () => {
    void virtualList?.scrollToBottom({ behavior: "smooth" });
  });
  viewport.addEventListener(
    "scroll",
    () => {
      scheduleStateRender("scroll");
    },
    { passive: true },
  );
}

bindControls();
bindThemeButtons(refreshTheme);
refreshTheme();
syncControlValues();
createVirtualizer(0);

await document.fonts.ready;
scheduleStateRender("init");
document.documentElement.classList.remove("booting");
watchSystemTheme(refreshTheme);

declare global {
  interface Window {
    virtualListStateDemo: {
      get options(): DemoOptions;
      get virtualList(): VirtualList | null;
      setOptions(next: Partial<DemoOptions>): void;
    };
  }
}

window.virtualListStateDemo = {
  get options() {
    return { ...options };
  },
  get virtualList() {
    return virtualList;
  },
  setOptions(next) {
    options = { ...options, ...next };
    syncControlValues();
    scheduleOptionApply();
  },
};
