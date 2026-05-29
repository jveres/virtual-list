import {
  createDynamicVirtualizer,
  type DynamicVirtualizer,
  type DynamicVirtualizerBoundary,
  type DynamicVirtualizerBoundarySlot,
  type DynamicVirtualizerRenderDrift,
  type DynamicVirtualizerRenderMode,
  type DynamicVirtualizerState,
} from "../../src/dynamic-virtualizer.js";
import { applyDocumentTheme, watchSystemTheme } from "../demo-theme.js";
import { bindThemeButtons, mustGet, syncThemeButtons } from "../demo-utils.js";

import "../demo-styles.css";
import "./virtualizer-state.css";

interface DemoOptions {
  boundarySlots: boolean;
  count: number;
  debugRenderDrift: boolean;
  itemBaseHeight: number;
  itemVariance: number;
  measureEpsilon: number;
  overscanPx: number;
  placeholderVelocityThreshold: number;
  placeholders: boolean;
  renderMode: DynamicVirtualizerRenderMode;
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
  debugRenderDrift: false,
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
const stateDrift = mustGet("state-drift");
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
const driftToggle = mustGet("drift-toggle", HTMLInputElement);

let options: DemoOptions = { ...DEFAULT_OPTIONS };
let virtualizer: DynamicVirtualizer | null = null;
let optionFrame = 0;
let stateFrame = 0;
let driftCount = 0;
let lastEvent: StateEvent = "init";
let lastStateText = "";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

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
  boundary: DynamicVirtualizerBoundary,
): DynamicVirtualizerBoundarySlot | null {
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
  virtualizer?.setBoundarySlot("top", boundarySlot("top"));
  virtualizer?.setBoundarySlot("bottom", boundarySlot("bottom"));
}

function syncEmptySlot(): void {
  virtualizer?.setPlaceholderSlot({
    key: "state-empty",
    build: () => {
      const element = document.createElement("div");
      element.className = "state-empty";
      element.textContent = "No items";
      return element;
    },
  });
}

function stateEdgeText(state: DynamicVirtualizerState): string {
  if (state.atTop && state.atBottom) return "top + bottom";
  if (state.atTop) return "top";
  if (state.atBottom) return "bottom";
  return "middle";
}

function renderState(
  state: DynamicVirtualizerState,
  event: StateEvent = lastEvent,
): void {
  lastEvent = event;
  const rangeText = `${state.range.start.toLocaleString()}-${state.range.end.toLocaleString()} / ${state.count.toLocaleString()}`;
  const mountedText = state.mountedCount.toLocaleString();
  const measuredText = state.measuredCount.toLocaleString();
  const scrollText = `${px(state.scrollTop)} / ${px(state.scrollMax)}`;
  const totalText = px(state.totalSize);
  const edgesText = stateEdgeText(state);
  const driftText = driftCount.toLocaleString();
  const statusText = `${state.count.toLocaleString()} items · ${options.renderMode} · ${options.overscanPx}px overscan`;
  const signature = [
    rangeText,
    mountedText,
    measuredText,
    scrollText,
    totalText,
    edgesText,
    event,
    driftText,
    statusText,
  ].join("|");

  if (signature === lastStateText) return;
  lastStateText = signature;
  setText(stateRange, rangeText);
  setText(stateMounted, mountedText);
  setText(stateMeasured, measuredText);
  setText(stateScroll, scrollText);
  setText(stateTotal, totalText);
  setText(stateEdges, edgesText);
  setText(stateEvent, event);
  setText(stateDrift, driftText);
  setText(statusSummary, statusText);
  setText(statusCallback, event);
}

function scheduleStateRender(event: StateEvent = lastEvent): void {
  lastEvent = event;
  if (stateFrame) return;
  stateFrame = requestAnimationFrame(() => {
    stateFrame = 0;
    if (virtualizer) renderState(virtualizer.state, lastEvent);
  });
}

function reportRenderDrift(drifts: readonly DynamicVirtualizerRenderDrift[]) {
  driftCount += drifts.length;
  scheduleStateRender("range");
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
  virtualizer?.dispose();
  driftCount = 0;
  virtualizer = createDynamicVirtualizer({
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
    debugRenderDrift: options.debugRenderDrift ? reportRenderDrift : false,
    onRangeChange: (state) => renderState(state, "range"),
    onReachTop: (state) => renderState(state, "boundary:top"),
    onReachBottom: (state) => renderState(state, "boundary:bottom"),
    onScrollStart: (state) => renderState(state, "scroll-start"),
    onScrollEnd: (state) => renderState(state, "scroll-end"),
  });
  syncBoundarySlots();
  syncEmptySlot();
  void virtualizer
    .scrollToOffset(clamp(keepScrollTop, 0, virtualizer.state.scrollMax))
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
  driftToggle.checked = options.debugRenderDrift;

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
    debugRenderDrift: driftToggle.checked,
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

function optionsEqual(a: DemoOptions, b: DemoOptions): boolean {
  return (
    a.boundarySlots === b.boundarySlots &&
    a.count === b.count &&
    a.debugRenderDrift === b.debugRenderDrift &&
    a.itemBaseHeight === b.itemBaseHeight &&
    a.itemVariance === b.itemVariance &&
    a.measureEpsilon === b.measureEpsilon &&
    a.overscanPx === b.overscanPx &&
    a.placeholderVelocityThreshold === b.placeholderVelocityThreshold &&
    a.placeholders === b.placeholders &&
    a.renderMode === b.renderMode
  );
}

function scheduleOptionApply(): void {
  const previousOptions = options;
  options = readOptionsFromControls();
  syncControlValues();

  if (optionsEqual(previousOptions, options)) {
    scheduleStateRender("options");
    return;
  }

  const onlyPlaceholderOptionsChanged =
    previousOptions.boundarySlots === options.boundarySlots &&
    previousOptions.count === options.count &&
    previousOptions.debugRenderDrift === options.debugRenderDrift &&
    previousOptions.itemBaseHeight === options.itemBaseHeight &&
    previousOptions.itemVariance === options.itemVariance &&
    previousOptions.measureEpsilon === options.measureEpsilon &&
    previousOptions.overscanPx === options.overscanPx &&
    previousOptions.renderMode === options.renderMode &&
    (previousOptions.placeholders !== options.placeholders ||
      previousOptions.placeholderVelocityThreshold !==
        options.placeholderVelocityThreshold);

  if (onlyPlaceholderOptionsChanged && virtualizer) {
    if (!options.placeholders) {
      virtualizer.refreshMounted();
      void virtualizer.scrollToOffset(virtualizer.state.scrollTop);
    }
    scheduleStateRender("options");
    return;
  }

  if (optionFrame) cancelAnimationFrame(optionFrame);
  optionFrame = requestAnimationFrame(() => {
    optionFrame = 0;
    const keepScrollTop = virtualizer?.state.scrollTop ?? viewport.scrollTop;
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
    driftToggle,
  ];

  for (const input of optionInputs) {
    input.addEventListener("input", scheduleOptionApply);
    input.addEventListener("change", scheduleOptionApply);
  }

  topBtn.addEventListener("click", () => {
    void virtualizer?.scrollToTop({ behavior: "smooth" });
  });
  bottomBtn.addEventListener("click", () => {
    void virtualizer?.scrollToBottom({ behavior: "smooth" });
  });
  viewport.addEventListener(
    "scroll",
    () => {
      scheduleStateRender("scroll");
    },
    { passive: true },
  );
}

function refreshTheme(): void {
  applyDocumentTheme();
  syncThemeButtons();
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
    virtualizerStateDemo: {
      get options(): DemoOptions;
      get virtualizer(): DynamicVirtualizer | null;
      setOptions(next: Partial<DemoOptions>): void;
    };
  }
}

window.virtualizerStateDemo = {
  get options() {
    return { ...options };
  },
  get virtualizer() {
    return virtualizer;
  },
  setOptions(next) {
    options = { ...options, ...next };
    syncControlValues();
    scheduleOptionApply();
  },
};
