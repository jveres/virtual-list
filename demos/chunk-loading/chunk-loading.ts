import { conversation } from "../../src/chat-data.js";
import { buildChatItem, type ChatRole } from "../../src/chat-ui.js";
import {
  createDynamicVirtualizer,
  createDynamicVirtualizerItemMeasurer,
  type DynamicVirtualizer,
  type DynamicVirtualizerBoundary,
  type DynamicVirtualizerBoundarySlot,
  type DynamicVirtualizerPlaceholderSlot,
  type DynamicVirtualizerRenderDrift,
  type DynamicVirtualizerRenderMode,
} from "../../src/dynamic-virtualizer.js";
import {
  applyDocumentTheme,
  codeThemeName,
  hasHighlighter,
  initMarkdown,
  loadHighlighter,
  renderMarkdown,
  watchSystemTheme,
} from "../../src/markdown.js";
import { bindThemeButtons, mustGet, syncThemeButtons } from "../demo-utils.js";
import "../demo-styles.css";

const TOTAL_AVAILABLE = 10_000;
const DEFAULT_RETAINED_COUNT = 100;
const DEFAULT_CHUNK_SIZE = 50;
const DEFAULT_LOAD_MODE: LoadMode = "deferred";
const DEFAULT_RENDER_MODE: DynamicVirtualizerRenderMode = "virtual";
const DEFAULT_SOURCE: SourceId = "synthetic";
const BOUNDARY_SLOT_HEIGHT = 52;
const SYNTHETIC_OVERSCAN_PX = 900;
const NETWORK_OVERSCAN_PX = 1200;
const COLLAPSIBLE_TEXT_MIN_CHARS = 520;
const COLLAPSIBLE_TEXT_MIN_LINES = 13;
const AVERAGE_TEXT_CHAR_WIDTH_PX = 7.2;
const BSKY_PUBLIC_API = "https://public.api.bsky.app";
const BSKY_DISCOVER_FEED =
  "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot";
const LEMMY_POST_LIST_PATHS = ["/api/v4/post/list", "/api/v3/post/list"];
const LEMMY_ORIGINS = [
  "https://lemmy.world",
  "https://lemmy.ml",
  "https://programming.dev",
  "https://sh.itjust.works",
];

type LoadMode = "instant" | "deferred";
type SourceId = "synthetic" | "bsky" | "lemmy";
type DemoRenderMode = DynamicVirtualizerRenderMode;
type BoundarySlotKind = "none" | "idle" | "loading" | "no-more" | "error";
type PlaceholderSlotKind = "loading" | "empty" | "error";
type MediaRenderMode = "load" | "placeholder";

type RenderDriftDebugWindow = Window & {
  __vl4RenderDriftCount?: number;
  __vl4RenderDriftReports?: unknown[];
};

interface BaseLoadedItem {
  key: string;
  role: ChatRole;
}

interface SyntheticLoadedItem extends BaseLoadedItem {
  source: "synthetic";
  globalIndex: number;
  templateId: number;
}

interface HtmlLoadedItem extends BaseLoadedItem {
  source: "html";
  label: string;
  html: string;
  media?: LoadedMedia[];
  remoteId: string;
  createdAt: string;
}

type LoadedItem = SyntheticLoadedItem | HtmlLoadedItem;

interface BuildLoadedItemOptions {
  mediaMode?: MediaRenderMode;
}

interface LoadedMedia {
  previewUrl: string;
  url: string;
  alt: string;
  width: number;
  height: number;
}

interface ChunkSource {
  id: SourceId;
  label: string;
  totalLabel(): string;
  initialItems(): Promise<LoadedItem[]>;
  loadTop(
    currentItems: readonly LoadedItem[],
    controller: AbortController,
  ): Promise<LoadedItem[]>;
  loadBottom(
    currentItems: readonly LoadedItem[],
    controller: AbortController,
  ): Promise<LoadedItem[]>;
  canLoadTop(currentItems: readonly LoadedItem[]): boolean;
  canLoadBottom(currentItems: readonly LoadedItem[]): boolean;
  statusLabel(currentItems: readonly LoadedItem[]): string;
  rangeLabel(item: LoadedItem): string;
  boundaryLabel(
    boundary: DynamicVirtualizerBoundary,
    kind: Exclude<BoundarySlotKind, "none" | "idle">,
  ): string;
}

interface BoundarySlotState {
  kind: BoundarySlotKind;
}

interface BoundaryLoadToken {
  boundary: DynamicVirtualizerBoundary;
  sequence: number;
  controller: AbortController;
}

interface BskyActor {
  handle: string;
  displayName?: string;
}

interface BskyPostView {
  uri: string;
  author: BskyActor;
  record: unknown;
  indexedAt?: string;
}

interface BskyFeedItem {
  post: BskyPostView;
}

interface BskyFeedPage {
  feed: BskyFeedItem[];
  cursor?: string;
}

interface BskyPostRecord {
  text: string;
  createdAt?: string;
}

interface LemmyPost {
  id?: number | string;
  ap_id?: string;
  name: string;
  body?: string | null;
  url?: string | null;
  thumbnail_url?: string | null;
  alt_text?: string | null;
  published?: string;
  published_at?: string;
}

interface LemmyPerson {
  name: string;
  display_name?: string | null;
}

interface LemmyCommunity {
  name: string;
  title?: string | null;
}

interface LemmyImageDetails {
  link?: string | null;
  width?: number;
  height?: number;
}

interface LemmyPostView {
  post: LemmyPost;
  creator: LemmyPerson;
  community: LemmyCommunity;
  image_details?: LemmyImageDetails | null;
}

interface LemmyPostPage {
  items?: LemmyPostView[];
  posts?: LemmyPostView[];
  next_page?: string;
  prev_page?: string;
}

const params = new URLSearchParams(location.search);
const retainedCount = readPositiveInt("retain", DEFAULT_RETAINED_COUNT);
const chunkSize = readPositiveInt("chunk", DEFAULT_CHUNK_SIZE);
const configuredLoadMode = params.get("mode");
const configuredRenderMode = params.get("render");
const configuredSource = params.get("source");
const renderDriftDebug = readBooleanFlag("debugRenderDrift");
if (renderDriftDebug) {
  const debugWindow = window as RenderDriftDebugWindow;
  debugWindow.__vl4RenderDriftCount = 0;
  debugWindow.__vl4RenderDriftReports = [];
  console.info("[chunk-loading] render drift debug enabled");
}

const viewport = mustGet("viewport");
const windowStatus = mustGet("window-status");
const rangeStatus = mustGet("range-status");
const loadModeButton = mustGet("load-mode-btn", HTMLButtonElement);
const renderModeButton = mustGet("render-mode-btn", HTMLButtonElement);
const sourceSelect = mustGet("source-select", HTMLSelectElement);

let loadMode: LoadMode = isLoadMode(configuredLoadMode)
  ? configuredLoadMode
  : DEFAULT_LOAD_MODE;
let renderMode: DemoRenderMode = isRenderMode(configuredRenderMode)
  ? configuredRenderMode
  : DEFAULT_RENDER_MODE;
let sourceId: SourceId = isSourceId(configuredSource)
  ? configuredSource
  : DEFAULT_SOURCE;
let activeSource = createChunkSource(sourceId);
let items: LoadedItem[] = [];
let topLoads = 0;
let bottomLoads = 0;
let sourceVersion = 0;
let sourceLoading = false;
let pendingSourceId: SourceId | null = null;
let sourceError = "";
let lemmyOriginIndex = 0;
let pendingTopLoad = false;
let pendingBottomLoad = false;
let loadingTop = false;
let loadingBottom = false;
let pendingTrimSide: "top" | "bottom" | null = null;
let topLoadController: AbortController | null = null;
let bottomLoadController: AbortController | null = null;
let topLoadSequence = 0;
let bottomLoadSequence = 0;
let loadSequence = 0;
let virtualizer: DynamicVirtualizer | undefined;
let measuredViewportWidth = viewport.clientWidth;
let renderedWindowStatus = "";
let renderedRangeStatus = "";

const measuredItemHeights = new Map<string, number>();
const visibleItemCache = new Map<string, HTMLElement>();
const htmlCache = new Map<string, string>();
const expandedTextKeys = new Set<string>();
const boundarySlotStates: Record<
  DynamicVirtualizerBoundary,
  BoundarySlotState
> = {
  top: { kind: "none" },
  bottom: { kind: "none" },
};

function readPositiveInt(name: string, fallback: number): number {
  const value = Number(params.get(name));
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.max(1, Math.floor(value));
}

function readBooleanFlag(name: string): boolean {
  const value = params.get(name);
  return value !== null && value !== "0" && value !== "false";
}

function isLoadMode(value: string | null | undefined): value is LoadMode {
  return value === "instant" || value === "deferred";
}

function isRenderMode(
  value: string | null | undefined,
): value is DemoRenderMode {
  return value === "virtual" || value === "full";
}

function isSourceId(value: string | null | undefined): value is SourceId {
  return value === "synthetic" || value === "bsky" || value === "lemmy";
}

function templateIdForGlobalIndex(index: number): number {
  return index % conversation.length;
}

function htmlForTemplate(templateId: number): string {
  const themeKey = hasHighlighter() ? codeThemeName() : "plain";
  const cacheKey = `${themeKey}:${templateId}`;
  let html = htmlCache.get(cacheKey);
  if (html === undefined) {
    html = renderMarkdown(conversation[templateId]!.markdown);
    htmlCache.set(cacheKey, html);
  }
  return html;
}

function createSyntheticItem(globalIndex: number): SyntheticLoadedItem {
  const templateId = templateIdForGlobalIndex(globalIndex);
  return {
    source: "synthetic",
    key: `synthetic:${globalIndex}`,
    role: conversation[templateId]!.role,
    globalIndex,
    templateId,
  };
}

function createSyntheticRange(start: number, end: number): LoadedItem[] {
  const nextItems: LoadedItem[] = [];
  for (let globalIndex = start; globalIndex < end; globalIndex++) {
    nextItems.push(createSyntheticItem(globalIndex));
  }
  return nextItems;
}

function createSyntheticSource(): ChunkSource {
  return {
    id: "synthetic",
    label: "Synthetic",
    totalLabel() {
      return `/ ${TOTAL_AVAILABLE}`;
    },
    initialItems() {
      const initialCount = Math.min(retainedCount, TOTAL_AVAILABLE);
      const start = Math.floor((TOTAL_AVAILABLE - initialCount) / 2);
      return Promise.resolve(createSyntheticRange(start, start + initialCount));
    },
    loadTop(currentItems) {
      const first = firstSyntheticItem(currentItems);
      const start = first?.globalIndex ?? TOTAL_AVAILABLE;
      const addedBefore = Math.min(chunkSize, start);
      return Promise.resolve(createSyntheticRange(start - addedBefore, start));
    },
    loadBottom(currentItems) {
      const last = lastSyntheticItem(currentItems);
      const start = last ? last.globalIndex + 1 : 0;
      const added = Math.min(chunkSize, TOTAL_AVAILABLE - start);
      return Promise.resolve(createSyntheticRange(start, start + added));
    },
    canLoadTop(currentItems) {
      return (firstSyntheticItem(currentItems)?.globalIndex ?? 0) > 0;
    },
    canLoadBottom(currentItems) {
      const last = lastSyntheticItem(currentItems);
      return last === undefined || last.globalIndex + 1 < TOTAL_AVAILABLE;
    },
    statusLabel(currentItems) {
      const first = firstSyntheticItem(currentItems);
      const last = lastSyntheticItem(currentItems);
      if (!first || !last) return "loaded empty";
      return `loaded ${first.globalIndex}-${last.globalIndex}`;
    },
    rangeLabel(item) {
      return item.source === "synthetic" ? String(item.globalIndex) : item.key;
    },
    boundaryLabel(boundary, kind) {
      const direction = boundary === "top" ? "older" : "newer";
      if (kind === "loading") return `Loading ${direction} items`;
      if (kind === "no-more") return `No more ${direction} items`;
      return `Error loading ${direction} items`;
    },
  };
}

function firstSyntheticItem(
  currentItems: readonly LoadedItem[],
): SyntheticLoadedItem | undefined {
  const first = currentItems[0];
  return first?.source === "synthetic" ? first : undefined;
}

function lastSyntheticItem(
  currentItems: readonly LoadedItem[],
): SyntheticLoadedItem | undefined {
  const last = currentItems[currentItems.length - 1];
  return last?.source === "synthetic" ? last : undefined;
}

function createBskySource(): ChunkSource {
  let bottomCursor = "";

  return {
    id: "bsky",
    label: "Bluesky",
    totalLabel() {
      return "Discover";
    },
    async initialItems() {
      const page = await fetchBskyItems(
        undefined,
        retainedCount,
        new Set(),
        true,
      );
      bottomCursor = page.cursor;
      return page.items;
    },
    loadTop(currentItems, controller) {
      return fetchBskyItems(
        undefined,
        chunkSize,
        itemKeySet(currentItems),
        false,
        controller.signal,
      ).then((page) => page.items);
    },
    async loadBottom(currentItems, controller) {
      if (!bottomCursor) return [];
      const page = await fetchBskyItems(
        bottomCursor,
        chunkSize,
        itemKeySet(currentItems),
        true,
        controller.signal,
      );
      throwIfAborted(controller.signal);
      bottomCursor = page.cursor;
      return page.items;
    },
    canLoadTop() {
      return true;
    },
    canLoadBottom() {
      return Boolean(bottomCursor);
    },
    statusLabel(currentItems) {
      const first = firstBskyItem(currentItems);
      const last = lastBskyItem(currentItems);
      if (!first || !last) return "loaded empty";
      return `loaded ${currentItems.length} posts ${shortDate(first.createdAt)}-${shortDate(last.createdAt)}`;
    },
    rangeLabel(item) {
      return item.source === "html" ? shortRemoteId(item.remoteId) : item.key;
    },
    boundaryLabel(boundary, kind) {
      const direction = boundary === "top" ? "newer" : "older";
      if (kind === "loading") return `Loading ${direction} posts`;
      if (kind === "no-more") return `No more ${direction} posts`;
      return `Error loading ${direction} posts`;
    },
  };
}

function createLemmySource(): ChunkSource {
  let bottomCursor = "";

  return {
    id: "lemmy",
    label: "Lemmy",
    totalLabel() {
      return lemmyHostLabel();
    },
    async initialItems() {
      const page = await fetchLemmyItems(
        undefined,
        retainedCount,
        new Set(),
        true,
      );
      bottomCursor = page.cursor;
      return page.items;
    },
    loadTop(currentItems, controller) {
      return fetchLemmyItems(
        undefined,
        chunkSize,
        itemKeySet(currentItems),
        false,
        controller.signal,
      ).then((page) => page.items);
    },
    async loadBottom(currentItems, controller) {
      if (!bottomCursor) return [];
      const page = await fetchLemmyItems(
        bottomCursor,
        chunkSize,
        itemKeySet(currentItems),
        true,
        controller.signal,
      );
      throwIfAborted(controller.signal);
      bottomCursor = page.cursor;
      return page.items;
    },
    canLoadTop() {
      return true;
    },
    canLoadBottom() {
      return Boolean(bottomCursor);
    },
    statusLabel(currentItems) {
      const first = firstLemmyItem(currentItems);
      const last = lastLemmyItem(currentItems);
      if (!first || !last) return "loaded empty";
      return `loaded ${currentItems.length} posts ${shortDate(first.createdAt)}-${shortDate(last.createdAt)}`;
    },
    rangeLabel(item) {
      return item.source === "html" ? shortRemoteId(item.remoteId) : item.key;
    },
    boundaryLabel(boundary, kind) {
      const direction = boundary === "top" ? "newer" : "older";
      if (kind === "loading") return `Loading ${direction} posts`;
      if (kind === "no-more") return `No more ${direction} posts`;
      return `Error loading ${direction} posts`;
    },
  };
}

function firstBskyItem(
  currentItems: readonly LoadedItem[],
): HtmlLoadedItem | undefined {
  return currentItems.find(isBskyItem);
}

function lastBskyItem(
  currentItems: readonly LoadedItem[],
): HtmlLoadedItem | undefined {
  for (let index = currentItems.length - 1; index >= 0; index--) {
    const item = currentItems[index];
    if (item && isBskyItem(item)) return item;
  }
  return undefined;
}

function isBskyItem(item: LoadedItem): item is HtmlLoadedItem {
  return item.source === "html" && item.key.startsWith("bsky:");
}

function firstLemmyItem(
  currentItems: readonly LoadedItem[],
): HtmlLoadedItem | undefined {
  return currentItems.find(isLemmyItem);
}

function lastLemmyItem(
  currentItems: readonly LoadedItem[],
): HtmlLoadedItem | undefined {
  for (let index = currentItems.length - 1; index >= 0; index--) {
    const item = currentItems[index];
    if (item && isLemmyItem(item)) return item;
  }
  return undefined;
}

function isLemmyItem(item: LoadedItem): item is HtmlLoadedItem {
  return item.source === "html" && item.key.startsWith("lemmy:");
}

function itemKeySet(currentItems: readonly LoadedItem[]): Set<string> {
  return new Set(currentItems.map((item) => item.key));
}

function createChunkSource(nextSourceId: SourceId): ChunkSource {
  if (nextSourceId === "bsky") return createBskySource();
  if (nextSourceId === "lemmy") return createLemmySource();
  return createSyntheticSource();
}

function itemAt(index: number): LoadedItem {
  const item = items[index];
  if (!item) throw new Error(`missing loaded item at index ${index}`);
  return item;
}

function buildLoadedItem(
  item: LoadedItem,
  options: BuildLoadedItemOptions = {},
): HTMLElement {
  if (item.source === "synthetic") {
    const row = buildChatItem(
      item.globalIndex,
      conversation[item.templateId]!,
      htmlForTemplate(item.templateId),
      { indexLabel: true },
    );
    applyCollapsibleText(row, item.key);
    return row;
  }

  const row = document.createElement("article");
  row.className = `message ${item.role}`;

  const content = document.createElement("div");
  content.className = "message-content";

  const label = document.createElement("div");
  label.className = "role-label";
  label.textContent = item.label;
  content.appendChild(label);

  const markdown = document.createElement("div");
  markdown.className = "md";
  markdown.innerHTML = item.html;
  content.appendChild(markdown);
  appendLoadedMedia(content, item.media, options.mediaMode ?? "load");

  row.appendChild(content);
  applyCollapsibleText(row, item.key);
  return row;
}

function syncTextToggle(button: HTMLButtonElement, expanded: boolean): void {
  button.textContent = expanded ? "Show less" : "Show more";
  button.setAttribute("aria-expanded", String(expanded));
}

function estimatedLineCapacity(): number {
  const messageWidth = Math.min(Math.max(0, viewport.clientWidth - 48), 860);
  return Math.max(36, Math.floor(messageWidth / AVERAGE_TEXT_CHAR_WIDTH_PX));
}

function estimatedBlockLines(element: Element, lineCapacity: number): number {
  const text = element.textContent?.trim() ?? "";
  if (!text) return 0;

  if (element.tagName === "PRE") {
    return Math.max(1, text.split("\n").length);
  }
  if (element.tagName === "TABLE") {
    return Math.max(3, element.querySelectorAll("tr").length + 1);
  }
  if (element.tagName === "UL" || element.tagName === "OL") {
    const itemLines = Array.from(element.querySelectorAll("li")).reduce(
      (sum, item) =>
        sum +
        Math.max(
          1,
          Math.ceil((item.textContent?.trim().length ?? 0) / lineCapacity),
        ),
      0,
    );
    return Math.max(1, itemLines);
  }

  return Math.max(1, Math.ceil(text.length / lineCapacity));
}

function estimatedMarkdownLines(markdown: HTMLElement): number {
  const lineCapacity = estimatedLineCapacity();
  const blocks = Array.from(markdown.children);
  if (blocks.length === 0) {
    const textLength = markdown.textContent?.trim().length ?? 0;
    return Math.ceil(textLength / lineCapacity);
  }

  return blocks.reduce(
    (sum, block) => sum + estimatedBlockLines(block, lineCapacity),
    0,
  );
}

function applyCollapsibleText(row: HTMLElement, itemKey: string): void {
  const markdown = row.querySelector<HTMLElement>(".md");
  const content = markdown?.parentElement;
  if (!markdown || !content) return;

  const text = markdown.textContent?.trim() ?? "";
  if (text.length < COLLAPSIBLE_TEXT_MIN_CHARS) return;
  if (estimatedMarkdownLines(markdown) < COLLAPSIBLE_TEXT_MIN_LINES) return;

  const expanded = expandedTextKeys.has(itemKey);
  const wrapper = document.createElement("div");
  wrapper.className = expanded
    ? "collapsible-text expanded"
    : "collapsible-text collapsed";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "text-toggle";
  syncTextToggle(button, expanded);
  button.addEventListener("click", () => {
    const nextExpanded = !expandedTextKeys.has(itemKey);
    if (nextExpanded) {
      expandedTextKeys.add(itemKey);
    } else {
      expandedTextKeys.delete(itemKey);
    }
    wrapper.classList.toggle("expanded", nextExpanded);
    wrapper.classList.toggle("collapsed", !nextExpanded);
    syncTextToggle(button, nextExpanded);
  });

  markdown.replaceWith(wrapper);
  wrapper.appendChild(markdown);
  content.insertBefore(button, wrapper.nextSibling);
}

function appendLoadedMedia(
  parent: HTMLElement,
  mediaItems: readonly LoadedMedia[] | undefined,
  mode: MediaRenderMode,
): void {
  if (!mediaItems || mediaItems.length === 0) return;

  const mediaCount = Math.min(mediaItems.length, 4);
  const grid = document.createElement("div");
  grid.className = `post-media count-${mediaCount}`;

  for (let index = 0; index < mediaCount; index++) {
    const media = mediaItems[index]!;
    const link = document.createElement(mode === "load" ? "a" : "span");
    link.className =
      mode === "load" ? "post-image" : "post-image post-image-placeholder";
    if (link instanceof HTMLAnchorElement) {
      link.href = media.url;
      link.target = "_blank";
      link.rel = "noreferrer noopener";
    }
    if (mediaCount === 1) {
      link.style.aspectRatio = `${positiveNumber(media.width, 16)} / ${positiveNumber(media.height, 9)}`;
    }

    if (mode === "load") {
      const image = document.createElement("img");
      image.src = media.previewUrl;
      image.alt = media.alt;
      image.loading = "lazy";
      image.decoding = "async";
      image.fetchPriority = "low";
      image.draggable = false;
      image.width = Math.round(positiveNumber(media.width, 16));
      image.height = Math.round(positiveNumber(media.height, 9));
      link.appendChild(image);
    }
    grid.appendChild(link);
  }

  parent.appendChild(grid);
}

function buildItem(localIndex: number): HTMLElement {
  const item = itemAt(localIndex);
  if (item.source === "synthetic") return buildLoadedItem(item);

  let element = visibleItemCache.get(item.key);
  if (!element) {
    element = buildLoadedItem(item);
    visibleItemCache.set(item.key, element);
  }
  return element;
}

function getItemHeight(localIndex: number): number {
  const item = itemAt(localIndex);
  const height = measuredItemHeights.get(item.key);
  if (height === undefined) {
    throw new Error(`missing measured height for item ${item.key}`);
  }
  return height;
}

function measureItems(nextItems: readonly LoadedItem[]): void {
  if (nextItems.length === 0) return;

  const measurer = createDynamicVirtualizerItemMeasurer({
    viewport,
    canvasClassName: "chat-canvas",
    buildItem: (index) =>
      buildLoadedItem(nextItems[index]!, { mediaMode: "placeholder" }),
  });
  try {
    for (let index = 0; index < nextItems.length; index++) {
      const item = nextItems[index]!;
      measuredItemHeights.set(item.key, measurer.measure(index));
    }
  } finally {
    measurer.dispose();
  }
}

function remeasureForViewportWidth(): void {
  if (Math.abs(viewport.clientWidth - measuredViewportWidth) <= 0.5) return;
  measuredViewportWidth = viewport.clientWidth;
  measureItems(items);
  virtualizer?.invalidateMeasurements();
}

function pruneMeasuredHeights(): void {
  const retainedKeys = itemKeySet(items);
  for (const key of measuredItemHeights.keys()) {
    if (!retainedKeys.has(key)) measuredItemHeights.delete(key);
  }
  for (const key of visibleItemCache.keys()) {
    if (!retainedKeys.has(key)) visibleItemCache.delete(key);
  }
  for (const key of expandedTextKeys.keys()) {
    if (!retainedKeys.has(key)) expandedTextKeys.delete(key);
  }
}

function setBoundarySlotState(
  boundary: DynamicVirtualizerBoundary,
  kind: BoundarySlotKind,
): void {
  boundarySlotStates[boundary] = { kind };
}

function clearBoundarySlotState(boundary: DynamicVirtualizerBoundary): void {
  setBoundarySlotState(boundary, "none");
}

function clearBoundarySlotStates(): void {
  clearBoundarySlotState("top");
  clearBoundarySlotState("bottom");
}

function boundarySlotLabel(
  boundary: DynamicVirtualizerBoundary,
  kind: BoundarySlotKind,
): string {
  return kind === "none" || kind === "idle"
    ? ""
    : activeSource.boundaryLabel(boundary, kind);
}

function buildBoundarySlot(
  boundary: DynamicVirtualizerBoundary,
  kind: BoundarySlotKind,
): HTMLElement {
  const element = document.createElement("div");
  element.className = `boundary-slot ${kind}`;
  if (kind === "idle") {
    element.setAttribute("aria-hidden", "true");
    return element;
  }

  element.setAttribute("role", kind === "error" ? "alert" : "status");

  if (kind === "loading") {
    const spinner = document.createElement("span");
    spinner.className = "boundary-spinner";
    spinner.setAttribute("aria-hidden", "true");
    element.appendChild(spinner);
  }

  const label = document.createElement("span");
  label.textContent = boundarySlotLabel(boundary, kind);
  element.appendChild(label);
  return element;
}

function visibleBoundarySlotKind(
  boundary: DynamicVirtualizerBoundary,
): Exclude<BoundarySlotKind, "none"> {
  const kind = boundarySlotStates[boundary].kind;
  return kind === "none" ? "idle" : kind;
}

function boundarySlotFor(
  boundary: DynamicVirtualizerBoundary,
): DynamicVirtualizerBoundarySlot | null {
  if (items.length === 0) return null;

  return {
    key: `${boundary}:slot`,
    height: BOUNDARY_SLOT_HEIGHT,
    build: () => buildBoundarySlot(boundary, visibleBoundarySlotKind(boundary)),
  };
}

function buildPlaceholderSlot(
  kind: PlaceholderSlotKind,
  label: string,
): HTMLElement {
  const element = document.createElement("div");
  element.className = `placeholder-slot ${kind}`;
  element.setAttribute("role", kind === "error" ? "alert" : "status");

  if (kind === "loading") {
    const spinner = document.createElement("span");
    spinner.className = "boundary-spinner";
    spinner.setAttribute("aria-hidden", "true");
    element.appendChild(spinner);
  }

  const text = document.createElement("span");
  text.textContent = label;
  element.appendChild(text);
  return element;
}

function placeholderSlotFor(): DynamicVirtualizerPlaceholderSlot | null {
  if (items.length > 0) return null;

  if (sourceLoading) {
    return {
      key: `loading:${sourceId}`,
      build: () =>
        buildPlaceholderSlot("loading", `Loading ${activeSource.label}`),
    };
  }

  if (sourceError) {
    return {
      key: `error:${sourceId}:${sourceError}`,
      build: () => buildPlaceholderSlot("error", sourceError),
    };
  }

  return {
    key: `empty:${sourceId}`,
    build: () =>
      buildPlaceholderSlot("empty", `${activeSource.label} returned no items`),
  };
}

function syncBoundarySlot(boundary: DynamicVirtualizerBoundary): void {
  virtualizer?.setBoundarySlot(boundary, boundarySlotFor(boundary));
}

function syncBoundarySlots(): void {
  virtualizer?.syncLayout({
    topSlot: boundarySlotFor("top"),
    bottomSlot: boundarySlotFor("bottom"),
    placeholderSlot: placeholderSlotFor(),
  });
}

function syncLoadModeButton(): void {
  const deferred = loadMode === "deferred";
  loadModeButton.classList.toggle("active", deferred);
  loadModeButton.setAttribute("aria-pressed", String(deferred));
  loadModeButton.title = deferred
    ? "Deferred chunk loading"
    : "Instant chunk loading";
  loadModeButton.setAttribute(
    "aria-label",
    deferred ? "Deferred chunk loading" : "Instant chunk loading",
  );
}

function syncRenderModeButton(): void {
  const full = renderMode === "full";
  renderModeButton.classList.toggle("active", full);
  renderModeButton.setAttribute("aria-pressed", String(full));
  renderModeButton.title = full ? "Full retained DOM" : "Virtualized rows";
  renderModeButton.setAttribute(
    "aria-label",
    full ? "Full retained DOM" : "Virtualized rows",
  );
}

function syncSourceSelect(): void {
  sourceSelect.value = pendingSourceId ?? sourceId;
  sourceSelect.disabled = sourceLoading;
  renderModeButton.disabled = hasActiveBoundaryLoad();
}

function syncStatus(state = virtualizer?.state): void {
  renderModeButton.disabled = hasActiveBoundaryLoad();
  const pending = [
    sourceLoading ? "source loading" : "",
    loadingTop ? "↑ loading" : "",
    loadingBottom ? "↓ loading" : "",
    pendingTopLoad ? "↑ pending" : "",
    pendingBottomLoad ? "↓ pending" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const nextWindowStatus = sourceError
    ? sourceError
    : `${activeSource.label} · ${activeSource.statusLabel(items)} ${activeSource.totalLabel()} · retain ${retainedCount} · chunk ${chunkSize} · ${loadMode} · ${renderMode}${pending ? ` · ${pending}` : ""} · ↑${topLoads} ↓${bottomLoads}`;
  if (nextWindowStatus !== renderedWindowStatus) {
    renderedWindowStatus = nextWindowStatus;
    windowStatus.textContent = nextWindowStatus;
  }

  if (!state || items.length === 0) {
    if (renderedRangeStatus) {
      renderedRangeStatus = "";
      rangeStatus.textContent = "";
    }
    return;
  }

  const mountedLast = Math.max(state.range.start, state.range.end - 1);
  const nextRangeStatus =
    activeSource.id !== "synthetic"
      ? "network rows pre-measured"
      : `mounted ${activeSource.rangeLabel(itemAt(state.range.start))}-${activeSource.rangeLabel(itemAt(mountedLast))} · ${state.mountedCount} nodes`;
  if (nextRangeStatus !== renderedRangeStatus) {
    renderedRangeStatus = nextRangeStatus;
    rangeStatus.textContent = nextRangeStatus;
  }
}

function refreshTheme(): void {
  applyDocumentTheme();
  syncThemeButtons();
  htmlCache.clear();
  virtualizer?.refreshMounted();
}

function reportRenderDrift(
  drifts: readonly DynamicVirtualizerRenderDrift[],
): void {
  const debugWindow = window as RenderDriftDebugWindow;
  debugWindow.__vl4RenderDriftCount =
    (debugWindow.__vl4RenderDriftCount ?? 0) + drifts.length;
  const reports = debugWindow.__vl4RenderDriftReports ?? [];
  reports.push({
    source: sourceId,
    scrollTop: viewport.scrollTop,
    count: drifts.length,
    drifts,
  });
  debugWindow.__vl4RenderDriftReports = reports.slice(-20);
  console.warn("[chunk-loading] render drift", reports.at(-1));
}

function createVirtualizer(): DynamicVirtualizer {
  return createDynamicVirtualizer({
    viewport,
    canvasClassName: "chat-canvas",
    getCount: () => items.length,
    getItemHeight,
    buildItem,
    overscanPx: () =>
      activeSource.id === "synthetic"
        ? SYNTHETIC_OVERSCAN_PX
        : NETWORK_OVERSCAN_PX,
    renderMode,
    debugRenderDrift: renderDriftDebug ? reportRenderDrift : false,
    onRangeChange: syncStatus,
    onReachTop: loadTopChunk,
    onReachBottom: loadBottomChunk,
  });
}

function controllerForBoundary(
  boundary: DynamicVirtualizerBoundary,
): AbortController | null {
  return boundary === "top" ? topLoadController : bottomLoadController;
}

function sequenceForBoundary(boundary: DynamicVirtualizerBoundary): number {
  return boundary === "top" ? topLoadSequence : bottomLoadSequence;
}

function setBoundaryLoadToken(token: BoundaryLoadToken): void {
  if (token.boundary === "top") {
    topLoadController = token.controller;
    topLoadSequence = token.sequence;
  } else {
    bottomLoadController = token.controller;
    bottomLoadSequence = token.sequence;
  }
}

function clearBoundaryLoadToken(token: BoundaryLoadToken): void {
  if (!isCurrentBoundaryLoad(token)) return;
  if (token.boundary === "top") {
    topLoadController = null;
    topLoadSequence = 0;
  } else {
    bottomLoadController = null;
    bottomLoadSequence = 0;
  }
}

function clearBoundaryLoadState(boundary: DynamicVirtualizerBoundary): void {
  if (boundary === "top") {
    topLoadController = null;
    topLoadSequence = 0;
    pendingTopLoad = false;
    loadingTop = false;
  } else {
    bottomLoadController = null;
    bottomLoadSequence = 0;
    pendingBottomLoad = false;
    loadingBottom = false;
  }
}

function hasActiveBoundaryLoad(): boolean {
  return (
    sourceLoading ||
    topLoadController !== null ||
    bottomLoadController !== null ||
    pendingTopLoad ||
    pendingBottomLoad ||
    loadingTop ||
    loadingBottom
  );
}

function isCurrentBoundaryLoad(token: BoundaryLoadToken): boolean {
  return (
    controllerForBoundary(token.boundary) === token.controller &&
    sequenceForBoundary(token.boundary) === token.sequence
  );
}

function beginBoundaryLoad(
  boundary: DynamicVirtualizerBoundary,
): BoundaryLoadToken {
  const token: BoundaryLoadToken = {
    boundary,
    sequence: ++loadSequence,
    controller: new AbortController(),
  };
  setBoundaryLoadToken(token);
  return token;
}

function cancelBoundaryLoad(boundary: DynamicVirtualizerBoundary): void {
  const hasLoad =
    controllerForBoundary(boundary) !== null ||
    (boundary === "top"
      ? loadingTop || pendingTopLoad
      : loadingBottom || pendingBottomLoad);
  if (!hasLoad) return;

  controllerForBoundary(boundary)?.abort();
  clearBoundaryLoadState(boundary);
  clearBoundarySlotState(boundary);
  syncBoundarySlot(boundary);
}

function loadTopChunk(): void {
  if (sourceLoading) return;
  cancelBoundaryLoad("top");
  cancelBoundaryLoad("bottom");

  if (!activeSource.canLoadTop(items)) {
    setBoundarySlotState("top", "no-more");
    syncBoundarySlot("top");
    syncStatus();
    return;
  }

  void commitTopChunk(loadMode === "deferred");
}

async function commitTopChunk(deferDuringScroll: boolean): Promise<void> {
  if (sourceLoading || !virtualizer || !activeSource.canLoadTop(items)) {
    pendingTopLoad = false;
    if (virtualizer && !activeSource.canLoadTop(items)) {
      setBoundarySlotState("top", "no-more");
      syncBoundarySlot("top");
    }
    syncStatus();
    return;
  }

  const version = sourceVersion;
  const token = beginBoundaryLoad("top");
  pendingTopLoad = deferDuringScroll;
  loadingTop = true;
  sourceError = "";
  setBoundarySlotState("top", "loading");
  syncBoundarySlot("top");
  syncStatus();

  try {
    const addedItems = await activeSource.loadTop(items, token.controller);
    if (version !== sourceVersion || !isCurrentBoundaryLoad(token)) return;
    loadingTop = false;
    applyTopChunk(addedItems, token, deferDuringScroll);
  } catch (error) {
    if (
      version !== sourceVersion ||
      !isCurrentBoundaryLoad(token) ||
      isAbortError(error)
    ) {
      return;
    }
    setBoundarySlotState("top", "error");
    syncBoundarySlot("top");
    console.error(error);
    loadingTop = false;
    pendingTopLoad = false;
    clearBoundaryLoadToken(token);
  }
  syncStatus();
}

function loadBottomChunk(): void {
  if (sourceLoading) return;
  cancelBoundaryLoad("top");
  cancelBoundaryLoad("bottom");

  if (!activeSource.canLoadBottom(items)) {
    setBoundarySlotState("bottom", "no-more");
    syncBoundarySlot("bottom");
    syncStatus();
    return;
  }

  void commitBottomChunk(loadMode === "deferred");
}

async function commitBottomChunk(deferDuringScroll: boolean): Promise<void> {
  if (sourceLoading || !virtualizer || !activeSource.canLoadBottom(items)) {
    pendingBottomLoad = false;
    if (virtualizer && !activeSource.canLoadBottom(items)) {
      setBoundarySlotState("bottom", "no-more");
      syncBoundarySlot("bottom");
    }
    syncStatus();
    return;
  }

  const version = sourceVersion;
  const token = beginBoundaryLoad("bottom");
  pendingBottomLoad = deferDuringScroll;
  loadingBottom = true;
  sourceError = "";
  setBoundarySlotState("bottom", "loading");
  syncBoundarySlot("bottom");
  syncStatus();

  try {
    const addedItems = await activeSource.loadBottom(items, token.controller);
    if (version !== sourceVersion || !isCurrentBoundaryLoad(token)) return;
    loadingBottom = false;
    applyBottomChunk(addedItems, token, deferDuringScroll);
  } catch (error) {
    if (
      version !== sourceVersion ||
      !isCurrentBoundaryLoad(token) ||
      isAbortError(error)
    ) {
      return;
    }
    setBoundarySlotState("bottom", "error");
    syncBoundarySlot("bottom");
    console.error(error);
    loadingBottom = false;
    pendingBottomLoad = false;
    clearBoundaryLoadToken(token);
  }
  syncStatus();
}

function finishBoundaryLoad(token: BoundaryLoadToken): void {
  if (!isCurrentBoundaryLoad(token)) return;
  clearBoundaryLoadToken(token);
  if (token.boundary === "top") {
    loadingTop = false;
    pendingTopLoad = false;
  } else {
    loadingBottom = false;
    pendingBottomLoad = false;
  }
}

function applyTopChunk(
  addedItems: readonly LoadedItem[],
  token: BoundaryLoadToken,
  deferDuringScroll: boolean,
): void {
  if (!virtualizer) return;

  if (addedItems.length === 0) {
    finishBoundaryLoad(token);
    setBoundarySlotState("top", "no-more");
    syncBoundarySlot("top");
    return;
  }

  measureItems(addedItems);
  virtualizer.syncLayout({
    addedBefore: addedItems.length,
    deferDuringScroll,
    topSlot: boundarySlotFor("top"),
    apply: () => {
      if (!isCurrentBoundaryLoad(token)) {
        return false;
      }
      items = [...addedItems, ...items];
      pendingTrimSide = "bottom";
      topLoads++;
      finishBoundaryLoad(token);
      clearBoundarySlotState("top");
      return true;
    },
    after: () => {
      pruneMeasuredHeights();
      trimRetainedWindow();
      syncStatus();
    },
  });
}

function applyBottomChunk(
  addedItems: readonly LoadedItem[],
  token: BoundaryLoadToken,
  deferDuringScroll: boolean,
): void {
  if (!virtualizer) return;

  if (addedItems.length === 0) {
    finishBoundaryLoad(token);
    setBoundarySlotState("bottom", "no-more");
    syncBoundarySlot("bottom");
    return;
  }

  measureItems(addedItems);
  virtualizer.syncLayout({
    deferDuringScroll,
    bottomSlot: boundarySlotFor("bottom"),
    apply: () => {
      if (!isCurrentBoundaryLoad(token)) {
        return false;
      }
      items = [...items, ...addedItems];
      pendingTrimSide = "top";
      bottomLoads++;
      finishBoundaryLoad(token);
      clearBoundarySlotState("bottom");
      return true;
    },
    after: () => {
      pruneMeasuredHeights();
      trimRetainedWindow();
      syncStatus();
    },
  });
}

function setLoadMode(nextLoadMode: LoadMode): void {
  if (nextLoadMode === loadMode) return;

  loadMode = nextLoadMode;
  syncLoadModeButton();
  if (loadMode === "instant") {
    clearBoundarySlotStates();
    syncBoundarySlots();
  } else {
    syncBoundarySlots();
  }
  syncStatus();
}

function setRenderMode(nextRenderMode: DemoRenderMode): void {
  if (nextRenderMode === renderMode || hasActiveBoundaryLoad()) return;

  const keepScrollTop = viewport.scrollTop;
  renderMode = nextRenderMode;
  syncRenderModeButton();
  virtualizer?.dispose();
  virtualizer = createVirtualizer();
  syncBoundarySlots();
  virtualizer.setCount();
  viewport.scrollTop = Math.min(
    keepScrollTop,
    Math.max(0, viewport.scrollHeight - viewport.clientHeight),
  );
  syncStatus();
}

function trimRetainedWindow(): void {
  if (!virtualizer || !pendingTrimSide) return;

  const excess = Math.max(0, items.length - retainedCount);
  if (excess <= 0) {
    pendingTrimSide = null;
    return;
  }

  const { range } = virtualizer.state;
  if (pendingTrimSide === "top") {
    const removedBefore =
      renderMode === "full" ? excess : Math.min(excess, range.start);
    if (removedBefore <= 0) return;

    items = items.slice(removedBefore);
    virtualizer.setCount({ removedBefore });
  } else {
    const removedAfter =
      renderMode === "full"
        ? excess
        : Math.min(excess, items.length - range.end);
    if (removedAfter <= 0) return;

    items = items.slice(0, items.length - removedAfter);
    virtualizer.setCount();
  }

  pruneMeasuredHeights();
  if (items.length <= retainedCount) pendingTrimSide = null;
}

async function resetSource(nextSourceId: SourceId): Promise<void> {
  const version = ++sourceVersion;
  const nextSource = createChunkSource(nextSourceId);
  cancelBoundaryLoad("top");
  cancelBoundaryLoad("bottom");
  loadSequence++;
  sourceLoading = true;
  sourceId = nextSourceId;
  pendingSourceId = nextSourceId;
  activeSource = nextSource;
  virtualizer?.dispose();
  virtualizer = undefined;
  items = [];
  sourceError = "";
  pendingTrimSide = null;
  topLoads = 0;
  bottomLoads = 0;
  measuredItemHeights.clear();
  visibleItemCache.clear();
  expandedTextKeys.clear();
  clearBoundarySlotStates();
  renderedWindowStatus = "";
  renderedRangeStatus = "";
  virtualizer = createVirtualizer();
  syncBoundarySlots();
  syncSourceSelect();
  syncStatus();

  try {
    const nextItems = await nextSource.initialItems();
    if (version !== sourceVersion) return;

    items = nextItems;
    measureItems(items);
    clearBoundarySlotStates();
    syncBoundarySlots();
    if (items.length === 0) return;
    if (activeSource.id === "synthetic") {
      await virtualizer.scrollToIndex(Math.floor(items.length / 2), "center");
    } else {
      await virtualizer.scrollToTop();
    }
  } catch (error) {
    if (version === sourceVersion) {
      items = [];
      measuredItemHeights.clear();
      visibleItemCache.clear();
      expandedTextKeys.clear();
      sourceError = `${nextSource.label} failed: ${errorMessage(error)}`;
    }
  } finally {
    if (version === sourceVersion) {
      sourceLoading = false;
      pendingSourceId = null;
      syncSourceSelect();
      syncBoundarySlots();
      syncStatus();
    }
  }
}

async function switchSource(nextSourceId: SourceId): Promise<void> {
  if (nextSourceId === sourceId || sourceLoading) return;
  await resetSource(nextSourceId);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason: unknown = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException("Aborted", "AbortError");
}

function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function shortRemoteId(value: string): string {
  return value.split(/[/:]/).filter(Boolean).at(-1)?.slice(-6) ?? value;
}

function positiveNumber(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function fetchBskyItems(
  cursor: string | undefined,
  targetCount: number,
  excludedKeys: Set<string>,
  paginate: boolean,
  signal?: AbortSignal,
): Promise<{ items: LoadedItem[]; cursor: string }> {
  const items: LoadedItem[] = [];
  let nextCursor = cursor;

  while (items.length < targetCount) {
    throwIfAborted(signal);
    const limit = Math.min(100, targetCount - items.length);
    const page = await fetchBskyPage({ cursor: nextCursor, limit }, signal);
    addUniqueBskyPosts(items, page.feed, excludedKeys);

    if (!page.cursor || page.cursor === nextCursor) {
      nextCursor = "";
      break;
    }
    nextCursor = page.cursor;

    if (!paginate) break;
  }

  return { items, cursor: nextCursor ?? "" };
}

async function fetchBskyPage(
  config: {
    cursor?: string;
    limit: number;
  },
  signal?: AbortSignal,
): Promise<BskyFeedPage> {
  const url = new URL("/xrpc/app.bsky.feed.getFeed", BSKY_PUBLIC_API);
  url.searchParams.set("feed", BSKY_DISCOVER_FEED);
  url.searchParams.set("limit", String(config.limit));
  if (config.cursor) url.searchParams.set("cursor", config.cursor);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Language": navigator.language || "en",
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `Bluesky failed: ${response.status} ${(await response.text()).slice(
        0,
        160,
      )}`,
    );
  }

  const value: unknown = await response.json();
  if (!isBskyFeedPage(value)) {
    throw new Error("Bluesky response was not a feed page");
  }
  return value;
}

function addUniqueBskyPosts(
  target: LoadedItem[],
  feedItems: readonly BskyFeedItem[],
  excludedKeys: Set<string>,
): void {
  for (const feedItem of feedItems) {
    const item = bskyPostToItem(feedItem.post);
    if (!item || excludedKeys.has(item.key)) continue;
    excludedKeys.add(item.key);
    target.push(item);
  }
}

function bskyPostToItem(post: BskyPostView): LoadedItem | null {
  const record = bskyPostRecord(post.record);
  const media = bskyPostMedia(post);
  if (!record && media.length === 0) return null;

  const displayName = post.author.displayName?.trim();
  const account = displayName || `@${post.author.handle}`;
  const createdAt = record?.createdAt ?? post.indexedAt ?? "";
  return {
    source: "html",
    key: `bsky:${post.uri}`,
    role: "assistant",
    label: `${account} - ${shortDate(createdAt)}`,
    html: record?.text.trim()
      ? textToHtml(record.text)
      : "<p><em>Media post.</em></p>",
    media,
    remoteId: post.uri,
    createdAt,
  };
}

function bskyPostRecord(value: unknown): BskyPostRecord | null {
  if (!isRecord(value) || typeof value.text !== "string") return null;
  return {
    text: value.text,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
  };
}

function bskyPostMedia(post: BskyPostView): LoadedMedia[] {
  if (!isRecord(post) || !("embed" in post)) return [];
  return bskyEmbedMedia(post.embed);
}

function bskyEmbedMedia(embed: unknown): LoadedMedia[] {
  if (!isRecord(embed)) return [];

  const mediaItems: LoadedMedia[] = [];
  if (Array.isArray(embed.images)) {
    for (const image of embed.images) {
      const media = bskyImageMedia(image);
      if (media) mediaItems.push(media);
    }
  }

  if ("media" in embed) {
    mediaItems.push(...bskyEmbedMedia(embed.media));
  }

  return mediaItems;
}

function bskyImageMedia(value: unknown): LoadedMedia | null {
  if (!isRecord(value)) return null;

  const previewUrl =
    readSafeUrl(value.thumb) ?? readSafeUrl(value.fullsize) ?? "";
  const url = readSafeUrl(value.fullsize) ?? previewUrl;
  if (!previewUrl || !url) return null;

  const aspectRatio = isRecord(value.aspectRatio) ? value.aspectRatio : null;
  const width = positiveNumber(Number(aspectRatio?.width), 16);
  const height = positiveNumber(Number(aspectRatio?.height), 9);
  return {
    previewUrl,
    url,
    alt: typeof value.alt === "string" ? value.alt : "",
    width,
    height,
  };
}

function isBskyFeedPage(value: unknown): value is BskyFeedPage {
  if (!isRecord(value) || !Array.isArray(value.feed)) return false;
  return value.feed.every(isBskyFeedItem);
}

function isBskyFeedItem(value: unknown): value is BskyFeedItem {
  if (!isRecord(value) || !isRecord(value.post)) return false;
  const { post } = value;
  return (
    typeof post.uri === "string" &&
    isRecord(post.author) &&
    typeof post.author.handle === "string"
  );
}

async function fetchLemmyItems(
  cursor: string | undefined,
  targetCount: number,
  excludedKeys: Set<string>,
  paginate: boolean,
  signal?: AbortSignal,
): Promise<{ items: LoadedItem[]; cursor: string }> {
  const items: LoadedItem[] = [];
  let nextCursor = cursor;

  while (items.length < targetCount) {
    throwIfAborted(signal);
    const limit = Math.min(50, targetCount - items.length);
    const page = await fetchLemmyPage({ cursor: nextCursor, limit }, signal);
    addUniqueLemmyPosts(items, lemmyPostViews(page), excludedKeys);

    if (!page.next_page || page.next_page === nextCursor) {
      nextCursor = "";
      break;
    }
    nextCursor = page.next_page;

    if (!paginate) break;
  }

  return { items, cursor: nextCursor ?? "" };
}

async function fetchLemmyPage(
  config: {
    cursor?: string;
    limit: number;
  },
  signal?: AbortSignal,
): Promise<LemmyPostPage> {
  const attempts = lemmyOriginAttempts(Boolean(config.cursor));
  let lastError = "";

  for (const originIndex of attempts) {
    try {
      const page = await fetchLemmyPageFromOrigin(
        LEMMY_ORIGINS[originIndex]!,
        config,
        signal,
      );
      lemmyOriginIndex = originIndex;
      return page;
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError = errorMessage(error);
    }
  }

  throw new Error(lastError || "no public Lemmy source responded");
}

function lemmyOriginAttempts(cursorRequest: boolean): number[] {
  if (cursorRequest) return [lemmyOriginIndex];

  const attempts: number[] = [];
  for (let offset = 0; offset < LEMMY_ORIGINS.length; offset++) {
    attempts.push((lemmyOriginIndex + offset) % LEMMY_ORIGINS.length);
  }
  return attempts;
}

async function fetchLemmyPageFromOrigin(
  origin: string,
  config: {
    cursor?: string;
    limit: number;
  },
  signal?: AbortSignal,
): Promise<LemmyPostPage> {
  let lastError = "";

  for (const path of LEMMY_POST_LIST_PATHS) {
    try {
      return await fetchLemmyPageFromPath(origin, path, config, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError = errorMessage(error);
    }
  }

  throw new Error(`${new URL(origin).host} failed: ${lastError}`);
}

async function fetchLemmyPageFromPath(
  origin: string,
  path: string,
  config: {
    cursor?: string;
    limit: number;
  },
  signal?: AbortSignal,
): Promise<LemmyPostPage> {
  const url = new URL(path, origin);
  const isV4 = path.includes("/v4/");
  url.searchParams.set("limit", String(config.limit));
  url.searchParams.set("sort", isV4 ? "new" : "New");
  url.searchParams.set("type_", isV4 ? "all" : "All");
  url.searchParams.set("show_nsfw", "false");
  if (config.cursor) url.searchParams.set("page_cursor", config.cursor);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Language": navigator.language || "en",
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `${path} ${response.status} ${(await response.text()).slice(0, 160)}`,
    );
  }

  const value: unknown = await response.json();
  if (!isLemmyPostPage(value)) {
    throw new Error(`${path} response was not a post list`);
  }
  return value;
}

function addUniqueLemmyPosts(
  target: LoadedItem[],
  postViews: readonly LemmyPostView[],
  excludedKeys: Set<string>,
): void {
  for (const postView of postViews) {
    const item = lemmyPostToItem(postView);
    if (!item || excludedKeys.has(item.key)) continue;
    excludedKeys.add(item.key);
    target.push(item);
  }
}

function lemmyPostViews(page: LemmyPostPage): readonly LemmyPostView[] {
  if (Array.isArray(page.items)) return page.items;
  if (Array.isArray(page.posts)) return page.posts;
  return [];
}

function lemmyPostToItem(postView: LemmyPostView): LoadedItem | null {
  const { post } = postView;
  const remoteId = String(post.id ?? post.ap_id ?? "");
  if (!remoteId) return null;

  const media = lemmyPostMedia(postView);
  const body = typeof post.body === "string" ? post.body.trim() : "";
  const bodyHtml = body ? sanitizeStatusHtml(renderMarkdown(body)) : "";
  const linkHtml = lemmyPostLinkHtml(post);
  const html =
    `<p><strong>${escapeHtml(post.name)}</strong></p>` +
    bodyHtml +
    linkHtml +
    (!bodyHtml && !linkHtml && media.length === 0
      ? "<p><em>No body content.</em></p>"
      : "");
  const createdAt = post.published_at ?? post.published ?? "";

  return {
    source: "html",
    key: `lemmy:${remoteId}`,
    role: "assistant",
    label: `${lemmyPersonLabel(postView.creator)} in ${lemmyCommunityLabel(
      postView.community,
    )} - ${shortDate(createdAt)}`,
    html,
    media,
    remoteId,
    createdAt,
  };
}

function lemmyPersonLabel(person: LemmyPerson): string {
  return person.display_name?.trim() || `@${person.name}`;
}

function lemmyCommunityLabel(community: LemmyCommunity): string {
  return community.title?.trim() || `c/${community.name}`;
}

function lemmyPostLinkHtml(post: LemmyPost): string {
  const url = readSafeUrl(post.url);
  if (!url) return "";

  const paragraph = document.createElement("p");
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noreferrer noopener nofollow";
  link.textContent = readableUrlLabel(url);
  paragraph.appendChild(link);
  return paragraph.outerHTML;
}

function lemmyPostMedia(postView: LemmyPostView): LoadedMedia[] {
  const { post, image_details: details } = postView;
  const previewUrl =
    readSafeUrl(post.thumbnail_url) ?? readSafeUrl(details?.link) ?? "";
  const imageUrl = readSafeUrl(details?.link) ?? previewUrl;
  if (!previewUrl || !imageUrl) return [];

  return [
    {
      previewUrl,
      url: readSafeUrl(post.url) ?? imageUrl,
      alt: post.alt_text?.trim() || post.name,
      width: positiveNumber(Number(details?.width), 16),
      height: positiveNumber(Number(details?.height), 9),
    },
  ];
}

function lemmyHostLabel(): string {
  return new URL(LEMMY_ORIGINS[lemmyOriginIndex]!).host;
}

function isLemmyPostPage(value: unknown): value is LemmyPostPage {
  if (!isRecord(value)) return false;
  const postViews = Array.isArray(value.items)
    ? value.items
    : Array.isArray(value.posts)
      ? value.posts
      : null;
  return postViews?.every(isLemmyPostView) ?? false;
}

function isLemmyPostView(value: unknown): value is LemmyPostView {
  if (!isRecord(value) || !isRecord(value.post)) return false;
  const { post } = value;
  return (
    typeof post.name === "string" &&
    isRecord(value.creator) &&
    typeof value.creator.name === "string" &&
    isRecord(value.community) &&
    typeof value.community.name === "string"
  );
}

const allowedStatusTags = new Set([
  "a",
  "blockquote",
  "br",
  "code",
  "em",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

const droppedStatusTags = new Set([
  "embed",
  "iframe",
  "link",
  "math",
  "meta",
  "object",
  "script",
  "style",
  "svg",
]);

function sanitizeStatusHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const output = document.createElement("div");
  for (const child of Array.from(template.content.childNodes)) {
    appendSanitizedNode(child, output);
  }
  return output.innerHTML;
}

function appendSanitizedNode(node: Node, parent: HTMLElement): void {
  if (node.nodeType === Node.TEXT_NODE) {
    parent.appendChild(document.createTextNode(node.textContent ?? ""));
    return;
  }

  if (!(node instanceof HTMLElement)) return;

  const tagName = node.tagName.toLowerCase();
  if (droppedStatusTags.has(tagName)) return;

  if (tagName === "img") {
    const fallback = node.getAttribute("alt") || node.getAttribute("title");
    if (fallback) parent.appendChild(document.createTextNode(fallback));
    return;
  }

  if (!allowedStatusTags.has(tagName)) {
    for (const child of Array.from(node.childNodes)) {
      appendSanitizedNode(child, parent);
    }
    return;
  }

  const element = document.createElement(tagName);
  if (tagName === "a") {
    const href = safeHttpUrl(node.getAttribute("href"));
    if (href) {
      element.setAttribute("href", href);
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noreferrer noopener nofollow");
    }
  }

  for (const child of Array.from(node.childNodes)) {
    appendSanitizedNode(child, element);
  }
  parent.appendChild(element);
}

function safeHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, location.href);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function readableUrlLabel(value: string): string {
  try {
    const url = new URL(value);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

function readSafeUrl(value: unknown): string | null {
  return typeof value === "string" ? safeHttpUrl(value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function textToHtml(value: string): string {
  const paragraphs = value
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return "";
  return paragraphs
    .map(
      (paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
}

function escapeHtml(value: string): string {
  const element = document.createElement("span");
  element.textContent = value;
  return element.innerHTML;
}

bindThemeButtons(refreshTheme);

loadModeButton.addEventListener("click", () => {
  setLoadMode(loadMode === "deferred" ? "instant" : "deferred");
});

renderModeButton.addEventListener("click", () => {
  setRenderMode(renderMode === "virtual" ? "full" : "virtual");
});

sourceSelect.addEventListener("change", () => {
  const nextSourceId = sourceSelect.value;
  if (isSourceId(nextSourceId)) void switchSource(nextSourceId);
});

const viewportResizeObserver = new ResizeObserver(remeasureForViewportWidth);
viewportResizeObserver.observe(viewport);

document.getElementById("top-btn")?.addEventListener("click", () => {
  void virtualizer?.scrollToIndex(0, "top");
});

document.getElementById("bottom-btn")?.addEventListener("click", () => {
  void virtualizer?.scrollToIndex(items.length - 1, "bottom");
});

await Promise.all([initMarkdown(), document.fonts.ready]);
applyDocumentTheme();
syncThemeButtons();
syncLoadModeButton();
syncRenderModeButton();
syncSourceSelect();
await resetSource(sourceId);

syncStatus();
document.documentElement.classList.remove("booting");

watchSystemTheme(refreshTheme);
loadHighlighter()
  .then(() => {
    htmlCache.clear();
    if (sourceId === "synthetic") {
      virtualizer?.refreshMounted();
    }
  })
  .catch(console.error);

declare global {
  interface Window {
    chunkLoading: {
      virtualizer: DynamicVirtualizer | undefined;
      loadTop: () => void;
      loadBottom: () => void;
      loadOlder: () => void;
      loadNewer: () => void;
      setLoadMode: (mode: LoadMode) => void;
      setSource: (source: SourceId) => Promise<void>;
      loadedWindow: () => { source: SourceId; count: number };
    };
  }
}

window.chunkLoading = {
  get virtualizer() {
    return virtualizer;
  },
  loadTop: loadTopChunk,
  loadBottom: loadBottomChunk,
  loadOlder: loadTopChunk,
  loadNewer: loadBottomChunk,
  setLoadMode,
  setSource: switchSource,
  loadedWindow: () => ({
    source: sourceId,
    count: items.length,
  }),
};
