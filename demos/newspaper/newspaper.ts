import {
  createVirtualList,
  measureVirtualListItem,
  type VirtualList,
  type VirtualListState,
} from "../../src/virtual-list.js";
import { applyDocumentTheme, watchSystemTheme } from "../demo-theme.js";
import { bindThemeButtons, mustGet, syncThemeButtons } from "../demo-utils.js";

import "../demo-styles.css";
import "./newspaper.css";

// A newspaper / magazine layout virtualized as a feed of editorial "blocks".
// Each block is one virtual-list item built from a template (hero feature,
// multi-column article, image split, card grid, briefs list). Every text region
// is line-clamped to a fixed line count, so a block's height depends only on its
// template and the canvas width, not on the (synthetic, deterministic) article
// text. That lets the host measure one representative block per template and
// reuse the height for every block of that kind — exact heights, no clipping.

const TOTAL_ARTICLES = 1_400;
const MAX_BLOCKS = 720;
const CONTENT_MAX_WIDTH = 1100;
const HORIZONTAL_PADDING = 32;
const CARD_PADDING = 28;
const COLUMN_GAP = 24;
const OVERSCAN_PX = 900;
const MASTHEAD_TITLE = "The Virtual Times";
const MASTHEAD_DATELINE = "Weekend Edition · Rendered on demand";

const CATEGORIES = [
  "World",
  "Politics",
  "Business",
  "Technology",
  "Science",
  "Culture",
  "Sport",
  "Opinion",
] as const;

const AUTHORS = [
  "A. Mercer",
  "J. Halloway",
  "R. Okafor",
  "L. Petrova",
  "M. Castellano",
  "S. Nakamura",
  "D. Whitfield",
  "E. Bauer",
  "N. Adebayo",
  "T. Lindqvist",
] as const;

const HEADLINE_WORDS = [
  "markets",
  "rally",
  "as",
  "central",
  "banks",
  "signal",
  "patience",
  "engineers",
  "unveil",
  "a",
  "quiet",
  "breakthrough",
  "in",
  "fusion",
  "research",
  "city",
  "rethinks",
  "transit",
  "after",
  "record",
  "ridership",
  "the",
  "long",
  "road",
  "back",
  "for",
  "a",
  "vanishing",
  "craft",
  "how",
  "small",
  "studios",
  "reshaped",
  "a",
  "decade",
  "of",
  "design",
  "coastline",
  "towns",
  "weigh",
  "a",
  "warmer",
  "future",
  "inside",
  "the",
  "lab",
  "rewriting",
  "the",
  "rules",
  "of",
  "memory",
  "a",
  "season",
  "of",
  "upsets",
  "leaves",
  "the",
  "table",
  "wide",
  "open",
] as const;

const BODY_WORDS = [
  "the",
  "report",
  "found",
  "that",
  "early",
  "estimates",
  "had",
  "understated",
  "the",
  "scale",
  "of",
  "the",
  "shift",
  "while",
  "officials",
  "cautioned",
  "against",
  "reading",
  "too",
  "much",
  "into",
  "a",
  "single",
  "quarter",
  "analysts",
  "described",
  "the",
  "move",
  "as",
  "measured",
  "noting",
  "that",
  "conditions",
  "remain",
  "unusually",
  "fluid",
  "across",
  "the",
  "region",
  "and",
  "that",
  "much",
  "depends",
  "on",
  "decisions",
  "still",
  "weeks",
  "away",
  "for",
  "now",
  "residents",
  "say",
  "the",
  "change",
  "is",
  "already",
  "visible",
  "in",
  "small",
  "daily",
  "details",
  "the",
  "shorter",
  "lines",
  "the",
  "quieter",
  "mornings",
  "the",
  "sense",
  "that",
  "something",
  "has",
  "loosened",
  "even",
  "if",
  "no",
  "one",
  "can",
  "quite",
  "name",
  "it",
  "yet",
  "experts",
  "expect",
  "the",
  "trend",
  "to",
  "continue",
  "through",
  "the",
  "year",
] as const;

interface Article {
  id: number;
  category: string;
  headline: string;
  deck: string;
  body: string;
  byline: string;
}

const BLOCK_KINDS = [
  "masthead",
  "feature",
  "columns",
  "split",
  "grid",
  "briefs",
] as const;
type BlockKind = (typeof BLOCK_KINDS)[number];
type ArticleKind = Exclude<BlockKind, "masthead">;

interface Block {
  kind: BlockKind;
  articles: readonly Article[];
}

// Rhythm of templates. The masthead is prepended once; from there blocks cycle
// through this pattern, so a hero feature recurs roughly every seven blocks.
const RHYTHM: readonly ArticleKind[] = [
  "feature",
  "split",
  "grid",
  "columns",
  "briefs",
  "split",
  "grid",
];

const ARTICLES_PER_BLOCK: Record<ArticleKind, number> = {
  feature: 1,
  columns: 1,
  split: 1,
  grid: 3,
  briefs: 4,
};

const viewport = mustGet("viewport");
const rangeLabel = mustGet("range-label");
const mountedLabel = mustGet("mounted-label");
const layoutLabel = mustGet("layout-label");
const topBtn = mustGet("top-btn", HTMLButtonElement);
const bottomBtn = mustGet("bottom-btn", HTMLButtonElement);

const heightByKind = {} as Record<BlockKind, number>;
let contentWidth = 0;
let measuredViewportWidth = viewport.clientWidth;
let virtualList: VirtualList;
let renderedRangeText = "";
let renderedMountedText = "";
let renderedLayoutText = "";

// --- Deterministic content generation ---------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(items: readonly T[], rnd: number): T {
  return items[Math.floor(rnd * items.length)] ?? items[0]!;
}

function words(
  pool: readonly string[],
  count: number,
  rng: () => number,
): string {
  const out: string[] = [];
  for (let index = 0; index < count; index++) out.push(pick(pool, rng()));
  return out.join(" ");
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

function titleCase(text: string): string {
  return text.replace(/\b\w/g, (char) => char.toUpperCase());
}

function createArticle(id: number): Article {
  const rng = mulberry32(Math.imul(id + 1, 2654435761));
  return {
    id,
    category: pick(CATEGORIES, rng()),
    headline: titleCase(words(HEADLINE_WORDS, 5 + Math.floor(rng() * 5), rng)),
    deck: `${capitalize(words(BODY_WORDS, 16 + Math.floor(rng() * 10), rng))}.`,
    body: `${capitalize(words(BODY_WORDS, 90 + Math.floor(rng() * 50), rng))}.`,
    byline: `By ${pick(AUTHORS, rng())}`,
  };
}

const articles: readonly Article[] = Array.from(
  { length: TOTAL_ARTICLES },
  (_, index) => createArticle(index + 1),
);

function buildBlocks(): Block[] {
  const blocks: Block[] = [{ kind: "masthead", articles: [] }];
  let cursor = 0;
  let rhythmIndex = 0;
  while (blocks.length < MAX_BLOCKS) {
    const kind = RHYTHM[rhythmIndex % RHYTHM.length]!;
    rhythmIndex++;
    const need = ARTICLES_PER_BLOCK[kind];
    if (cursor + need > articles.length) break;
    blocks.push({ kind, articles: articles.slice(cursor, cursor + need) });
    cursor += need;
  }
  return blocks;
}

const blocks: readonly Block[] = buildBlocks();

const firstIndexByKind = {} as Record<BlockKind, number>;
blocks.forEach((block, index) => {
  if (firstIndexByKind[block.kind] === undefined) {
    firstIndexByKind[block.kind] = index;
  }
});

// --- Rendering ---------------------------------------------------------------
// Line heights are applied inline so each clamped text region is exactly
// `lines * lineHeight` tall, independent of the text it holds.

const LH_BODY = 25;
const LH_DECK = 24;
const LH_META = 18;
const LH_GRID_HEAD = 23;
const LH_GRID_TEXT = 22;
const LH_BRIEF_HEAD = 23;
const LH_BRIEF_TEXT = 21;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function px(value: number): string {
  return `${Math.round(value)}px`;
}

function canvasWidthForViewport(): number {
  return Math.max(
    260,
    Math.min(CONTENT_MAX_WIDTH, viewport.clientWidth - HORIZONTAL_PADDING),
  );
}

function innerWidth(): number {
  return contentWidth - CARD_PADDING * 2;
}

function featureHeadlineLineHeight(): number {
  return contentWidth < 640 ? 34 : 46;
}

function imageUrl(seed: number, width: number, height: number): string {
  const w = clamp(Math.round(width), 80, 720);
  const h = Math.max(80, Math.round(height));
  return `https://picsum.photos/seed/virtual-list-news-${seed}/${w}/${h}`;
}

function clampText(
  tag: string,
  className: string,
  text: string,
  lines: number,
  lineHeight: number,
): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  el.style.lineHeight = `${lineHeight}px`;
  el.style.height = px(lines * lineHeight);
  el.style.display = "-webkit-box";
  el.style.setProperty("-webkit-box-orient", "vertical");
  el.style.setProperty("-webkit-line-clamp", String(lines));
  el.style.overflow = "hidden";
  return el;
}

function categoryChip(article: Article): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "np-category";
  chip.textContent = article.category;
  return chip;
}

function bylineEl(article: Article): HTMLElement {
  const el = document.createElement("p");
  el.className = "np-byline";
  el.style.lineHeight = `${LH_META}px`;
  el.style.height = px(LH_META);
  el.textContent = `${article.byline} · No. ${article.id}`;
  return el;
}

// A fixed-height figure (feature/grid thumbnails).
function picture(seed: number, width: number, height: number): HTMLElement {
  const figure = document.createElement("div");
  figure.className = "np-figure";
  figure.style.height = px(height);
  figure.append(buildImage(seed, width, height));
  return figure;
}

function buildImage(seed: number, width: number, height: number): HTMLElement {
  const image = document.createElement("img");
  image.className = "np-figure-img";
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  image.draggable = false;
  const sourceWidth = clamp(Math.round(width), 120, 720);
  image.width = sourceWidth;
  image.height = Math.max(80, Math.round((sourceWidth * height) / width));
  image.src = imageUrl(seed, sourceWidth, image.height);
  return image;
}

function buildMasthead(): HTMLElement {
  const inner = document.createElement("div");
  inner.className = "np-masthead-inner";
  const title = document.createElement("h1");
  title.className = "np-masthead-title";
  title.textContent = MASTHEAD_TITLE;
  const dateline = document.createElement("p");
  dateline.className = "np-masthead-dateline";
  dateline.textContent = MASTHEAD_DATELINE;
  inner.append(title, dateline);
  return inner;
}

function buildFeature(article: Article): HTMLElement {
  const inner = document.createElement("div");
  inner.className = "np-feature-inner";
  const imageH = clamp(Math.round(innerWidth() * 0.46), 220, 440);
  inner.append(categoryChip(article));
  inner.append(
    clampText(
      "h2",
      "np-headline np-headline-xl",
      article.headline,
      2,
      featureHeadlineLineHeight(),
    ),
  );
  inner.append(picture(article.id, innerWidth(), imageH));
  inner.append(clampText("p", "np-deck", article.deck, 2, LH_DECK));
  inner.append(
    clampText(
      "p",
      "np-body",
      article.body,
      contentWidth < 640 ? 3 : 4,
      LH_BODY,
    ),
  );
  inner.append(bylineEl(article));
  return inner;
}

function buildColumns(article: Article): HTMLElement {
  const inner = document.createElement("div");
  inner.className = "np-columns-inner";
  inner.append(categoryChip(article));
  inner.append(
    clampText("h2", "np-headline np-headline-lg", article.headline, 2, 30),
  );
  inner.append(clampText("p", "np-deck", article.deck, 1, LH_DECK));

  const body = document.createElement("div");
  body.className = "np-column-body";
  body.style.columnCount = String(contentWidth < 560 ? 2 : 3);
  body.style.columnGap = `${COLUMN_GAP}px`;
  body.style.height = "200px";
  body.style.lineHeight = `${LH_BODY}px`;
  body.textContent = `${article.body} ${article.body}`;
  inner.append(body);
  inner.append(bylineEl(article));
  return inner;
}

function buildSplit(article: Article): HTMLElement {
  const inner = document.createElement("div");
  inner.className = "np-split-inner";
  if (article.id % 2 === 0) inner.classList.add("np-split-reverse");

  const figureWidth = Math.round((innerWidth() - COLUMN_GAP) * 0.46);
  const figureHeight = clamp(Math.round(figureWidth * 0.72), 220, 320);
  const figure = document.createElement("div");
  figure.className = "np-figure np-split-figure";
  figure.style.setProperty("--np-fig-width", px(figureWidth));
  figure.style.height = px(figureHeight);
  figure.append(buildImage(article.id, figureWidth, figureHeight));

  const text = document.createElement("div");
  text.className = "np-split-text";
  text.append(categoryChip(article));
  text.append(
    clampText("h2", "np-headline np-headline-lg", article.headline, 3, 30),
  );
  text.append(clampText("p", "np-deck", article.deck, 2, LH_DECK));
  text.append(clampText("p", "np-body", article.body, 4, LH_BODY));
  text.append(bylineEl(article));

  inner.append(figure, text);
  return inner;
}

function buildGridCard(article: Article, cardWidth: number): HTMLElement {
  const card = document.createElement("div");
  card.className = "np-grid-card";
  card.append(picture(article.id, cardWidth, Math.round(cardWidth * 0.66)));
  card.append(categoryChip(article));
  card.append(
    clampText(
      "h3",
      "np-headline np-headline-sm",
      article.headline,
      2,
      LH_GRID_HEAD,
    ),
  );
  card.append(clampText("p", "np-body", article.deck, 2, LH_GRID_TEXT));
  card.append(bylineEl(article));
  return card;
}

function buildGrid(block: Block): HTMLElement {
  const inner = document.createElement("div");
  inner.className = "np-grid-inner";

  const label = document.createElement("p");
  label.className = "np-section-label";
  label.textContent = "More from the desk";
  inner.append(label);

  const row = document.createElement("div");
  row.className = "np-grid-row";
  row.style.gap = `${COLUMN_GAP}px`;
  const cardWidth = (innerWidth() - COLUMN_GAP * 2) / 3;
  for (const article of block.articles) {
    row.append(buildGridCard(article, cardWidth));
  }
  inner.append(row);
  return inner;
}

function buildBriefs(block: Block): HTMLElement {
  const inner = document.createElement("div");
  inner.className = "np-briefs-inner";

  const label = document.createElement("p");
  label.className = "np-section-label";
  label.textContent = "In brief";
  inner.append(label);

  for (const article of block.articles) {
    const brief = document.createElement("div");
    brief.className = "np-brief";
    brief.append(
      clampText(
        "h3",
        "np-headline np-headline-xs",
        article.headline,
        1,
        LH_BRIEF_HEAD,
      ),
    );
    brief.append(clampText("p", "np-body", article.deck, 2, LH_BRIEF_TEXT));
    inner.append(brief);
  }
  return inner;
}

function buildItem(index: number): HTMLElement {
  const block = blocks[index]!;
  const article = block.articles[0];

  const item = document.createElement("section");
  item.className = `np-block np-${block.kind}`;

  const card = document.createElement("article");
  card.className = "np-card";
  card.style.maxWidth = px(contentWidth);

  if (block.kind === "masthead") card.append(buildMasthead());
  else if (block.kind === "feature" && article)
    card.append(buildFeature(article));
  else if (block.kind === "columns" && article)
    card.append(buildColumns(article));
  else if (block.kind === "split" && article) card.append(buildSplit(article));
  else if (block.kind === "grid") card.append(buildGrid(block));
  else if (block.kind === "briefs") card.append(buildBriefs(block));

  item.append(card);
  return item;
}

// --- Heights (measured once per template) ------------------------------------

function measureTemplateHeights(): void {
  contentWidth = canvasWidthForViewport();
  measuredViewportWidth = viewport.clientWidth;
  for (const kind of BLOCK_KINDS) {
    const index = firstIndexByKind[kind];
    if (index === undefined) continue;
    heightByKind[kind] = measureVirtualListItem({
      viewport,
      canvasClassName: "np-canvas",
      index,
      buildItem,
    });
  }
}

function itemHeight(index: number): number {
  return heightByKind[blocks[index]?.kind ?? "feature"] ?? 320;
}

// --- Status bar / controls ---------------------------------------------------

function setTextIfChanged(element: HTMLElement, nextText: string): string {
  if (element.textContent !== nextText) element.textContent = nextText;
  return nextText;
}

function updateInfo(state: VirtualListState = virtualList.state): void {
  const rangeText = `${state.range.start + 1}-${state.range.end} / ${blocks.length} blocks`;
  if (rangeText !== renderedRangeText) {
    renderedRangeText = setTextIfChanged(rangeLabel, rangeText);
  }

  const mountedText = `${state.mountedCount} mounted`;
  if (mountedText !== renderedMountedText) {
    renderedMountedText = setTextIfChanged(mountedLabel, mountedText);
  }

  const layoutText = `${Math.round(contentWidth)}px wide · ${articles.length} articles`;
  if (layoutText !== renderedLayoutText) {
    renderedLayoutText = setTextIfChanged(layoutLabel, layoutText);
  }
}

function bindControls(): void {
  topBtn.addEventListener("click", () => {
    void virtualList.scrollToTop({ behavior: "smooth" });
  });
  bottomBtn.addEventListener("click", () => {
    void virtualList.scrollToBottom({ behavior: "smooth" });
  });
}

function refreshTheme(): void {
  applyDocumentTheme();
  syncThemeButtons();
}

function handleViewportResize(): void {
  if (Math.abs(viewport.clientWidth - measuredViewportWidth) <= 0.5) return;
  measureTemplateHeights();
  virtualList.invalidateMeasurements();
  virtualList.refreshMounted();
  updateInfo();
}

// --- Boot --------------------------------------------------------------------

bindControls();
bindThemeButtons(refreshTheme);
refreshTheme();
await document.fonts.ready;
measureTemplateHeights();

virtualList = createVirtualList({
  viewport,
  canvasClassName: "np-canvas",
  getCount: () => blocks.length,
  getItemHeight: itemHeight,
  buildItem,
  overscanPx: OVERSCAN_PX,
  onRangeChange: updateInfo,
});

const viewportResizeObserver = new ResizeObserver(handleViewportResize);
viewportResizeObserver.observe(viewport);

updateInfo();
document.documentElement.classList.remove("booting");
watchSystemTheme(refreshTheme);
