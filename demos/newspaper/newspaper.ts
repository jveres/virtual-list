import { createItemMeasurer } from "../../src/premeasure.js";
import {
  createVirtualList,
  type VirtualList,
  type VirtualListState,
} from "../../src/virtual-list.js";
import { createImageLoader } from "../gallery/image-loader.js";
import { watchSystemTheme } from "../shared/theme.js";
import {
  at,
  bindThemeButtons,
  mustGet,
  refreshTheme,
} from "../shared/utils.js";

import "../shared/styles.css";
import "./newspaper.css";

// A newspaper / magazine layout virtualized as a feed of editorial "blocks".
// The header select swaps between genuinely different *layouts* — each defines
// its own block templates, rhythm, and typography:
//   Broadsheet — the classic editorial mix (hero, columns, split, grid, briefs)
//   Modular    — a gridded magazine (mosaic, triptych, side-by-side pairs)
//   Reader     — a calm single column (one image-forward story per band)
//   Radar      — a console-style magazine (dispatch cards, ledger strip, notes)
// Every text region is line-clamped to a fixed line count, so a block's height
// depends only on its template and the canvas width, not the (synthetic,
// deterministic) text. The host measures one representative block per template
// and reuses the height — exact heights, no clipping. Switching layout rebuilds
// the feed and re-measures.

const TOTAL_ARTICLES = 1_400;
const MAX_BLOCKS = 720;
const CONTENT_MAX_WIDTH = 1040;
const READER_MAX_WIDTH = 700;
const HORIZONTAL_PADDING = 32;
const COLUMN_GAP = 26;
const OVERSCAN_PX = 900;
const MASTHEAD_TITLE = "The Virtual Times";
const MASTHEAD_DATELINE = "Vol. MMXXVI · No. 1 · Rendered on demand";

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

interface Block {
  kind: string;
  articles: readonly Article[];
}

interface LayoutDef {
  label: string;
  fonts: readonly string[];
  rhythm: readonly string[];
  perBlock: Readonly<Record<string, number>>;
  render: (kind: string, block: Block) => HTMLElement;
}

const VARIANTS = ["broadsheet", "modular", "reader", "radar"] as const;
type Variant = (typeof VARIANTS)[number];

const viewport = mustGet("viewport");
const rangeLabel = mustGet("range-label");
const mountedLabel = mustGet("mounted-label");
const layoutLabel = mustGet("layout-label");
const loadLabel = mustGet("load-label");
const topBtn = mustGet("top-btn", HTMLButtonElement);
const bottomBtn = mustGet("bottom-btn", HTMLButtonElement);
const variantSelect = mustGet("variant-select", HTMLSelectElement);

const heightByKind: Record<string, number> = {};
let variant: Variant = "radar";
let contentWidth = 0;
let measuredViewportWidth = viewport.clientWidth;
type Row = { key: string; index: number; height: number };
let virtualList: VirtualList<Row>;
let renderedRangeText = "";
let renderedMountedText = "";
let renderedLayoutText = "";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function setTextIfChanged(element: HTMLElement, text: string): string {
  element.textContent = text;
  return text;
}

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
  for (let index = 0; index < count; index++) {
    let word = pick(pool, rng());
    // Avoid adjacent duplicates ("the the", "long long"), which read as broken.
    for (let guard = 0; word === out[out.length - 1] && guard < 4; guard++) {
      word = pick(pool, rng());
    }
    out.push(word);
  }
  return out.join(" ");
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

function titleCase(text: string): string {
  return text.replace(/\b\w/g, (char) => char.toUpperCase());
}

const HEADLINE_TRIM = new Set([
  "the",
  "a",
  "as",
  "of",
  "in",
  "for",
  "and",
  "to",
]);

// A headline that doesn't open or close on a bare function word.
function headlineText(rng: () => number): string {
  const parts = words(HEADLINE_WORDS, 5 + Math.floor(rng() * 5), rng).split(
    " ",
  );
  while (parts.length > 3 && HEADLINE_TRIM.has(parts[0] ?? "")) parts.shift();
  while (parts.length > 3 && HEADLINE_TRIM.has(parts.at(-1) ?? "")) parts.pop();
  return titleCase(parts.join(" "));
}

function createArticle(id: number): Article {
  const rng = mulberry32(Math.imul(id + 1, 2654435761));
  return {
    id,
    category: pick(CATEGORIES, rng()),
    headline: headlineText(rng),
    deck: `${capitalize(words(BODY_WORDS, 16 + Math.floor(rng() * 10), rng))}.`,
    body: `${capitalize(words(BODY_WORDS, 90 + Math.floor(rng() * 50), rng))}.`,
    byline: `By ${pick(AUTHORS, rng())}`,
  };
}

const articles: readonly Article[] = Array.from(
  { length: TOTAL_ARTICLES },
  (_, index) => createArticle(index + 1),
);

// --- Shared rendering helpers ------------------------------------------------

const LH_BODY = 25;
const LH_DECK = 24;
const LH_META = 18;
const LH_HEAD_SM = 23;
const LH_HEAD_TEXT = 22;

function px(value: number): string {
  return `${Math.round(value)}px`;
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function canvasWidthForViewport(): number {
  return Math.max(
    260,
    Math.min(CONTENT_MAX_WIDTH, viewport.clientWidth - HORIZONTAL_PADDING),
  );
}

// The effective content column width (Reader is a narrow centered measure).
function columnWidth(): number {
  return variant === "reader"
    ? Math.min(contentWidth, READER_MAX_WIDTH)
    : contentWidth;
}

function bigHeadlineLineHeight(): number {
  return columnWidth() < 640 ? 34 : 46;
}

function clampText(
  tag: string,
  className: string,
  text: string,
  lines: number,
  lineHeight: number,
): HTMLElement {
  const node = el(tag, className);
  node.textContent = text;
  node.style.lineHeight = `${lineHeight}px`;
  node.style.height = px(lines * lineHeight);
  node.style.display = "-webkit-box";
  node.style.setProperty("-webkit-box-orient", "vertical");
  node.style.setProperty("-webkit-line-clamp", String(lines));
  node.style.overflow = "hidden";
  return node;
}

// A fixed-height paragraph without the line-clamp box, so a CSS drop cap can
// float within it (the lede). Overflow is clipped at the fixed height.
function fixedText(
  className: string,
  text: string,
  lines: number,
  lineHeight: number,
): HTMLElement {
  const node = el("p", className);
  node.textContent = text;
  node.style.lineHeight = `${lineHeight}px`;
  node.style.height = px(lines * lineHeight);
  node.style.overflow = "hidden";
  return node;
}

function categoryChip(article: Article): HTMLElement {
  const chip = el("span", "np-category");
  chip.textContent = article.category;
  return chip;
}

function bylineEl(article: Article): HTMLElement {
  const node = el("p", "np-byline");
  node.style.lineHeight = `${LH_META}px`;
  node.style.height = px(LH_META);
  node.textContent = `${article.byline} · No. ${article.id}`;
  return node;
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
  image.dataset.src = `https://picsum.photos/seed/virtual-list-news-${seed}/${image.width}/${image.height}`;
  return image;
}

// A fixed-height figure.
function picture(seed: number, width: number, height: number): HTMLElement {
  const figure = el("div", "np-figure");
  figure.style.height = px(height);
  figure.append(buildImage(seed, width, height));
  return figure;
}

function buildMasthead(): HTMLElement {
  const inner = el("div", "np-masthead-inner");

  const title = el("h1", "np-masthead-title");
  title.textContent = MASTHEAD_TITLE;

  const meta = el("div", "np-masthead-meta");
  const leftRule = el("span", "np-masthead-rule");
  const dateline = el("span", "np-masthead-dateline");
  dateline.textContent = MASTHEAD_DATELINE;
  const rightRule = el("span", "np-masthead-rule");
  meta.append(leftRule, dateline, rightRule);

  inner.append(title, meta);
  return inner;
}

// --- Broadsheet templates ----------------------------------------------------

function buildFeature(article: Article): HTMLElement {
  const inner = el("div", "np-feature-inner");
  const imageH = clamp(Math.round(columnWidth() * 0.46), 220, 440);
  inner.append(categoryChip(article));
  inner.append(
    clampText(
      "h2",
      "np-headline np-headline-xl",
      article.headline,
      2,
      bigHeadlineLineHeight(),
    ),
  );
  inner.append(picture(article.id, columnWidth(), imageH));
  inner.append(clampText("p", "np-deck", article.deck, 2, LH_DECK));
  inner.append(
    fixedText(
      "np-body np-dropcap",
      article.body,
      columnWidth() < 640 ? 4 : 5,
      LH_BODY,
    ),
  );
  inner.append(bylineEl(article));
  return inner;
}

function buildColumns(article: Article): HTMLElement {
  const inner = el("div", "np-columns-inner");
  inner.append(categoryChip(article));
  inner.append(
    clampText("h2", "np-headline np-headline-lg", article.headline, 2, 30),
  );
  inner.append(clampText("p", "np-deck", article.deck, 1, LH_DECK));

  const body = el("div", "np-column-body");
  body.style.columnCount = String(columnWidth() < 560 ? 2 : 3);
  body.style.columnGap = `${COLUMN_GAP}px`;
  body.style.height = "200px";
  body.style.lineHeight = `${LH_BODY}px`;
  body.textContent = `${article.body} ${article.body}`;
  inner.append(body);
  inner.append(bylineEl(article));
  return inner;
}

function buildSplit(article: Article): HTMLElement {
  const inner = el("div", "np-split-inner");
  if (article.id % 2 === 0) inner.classList.add("np-split-reverse");

  const figureWidth = Math.round((columnWidth() - COLUMN_GAP) * 0.46);
  const figureHeight = clamp(Math.round(figureWidth * 0.72), 220, 320);
  const figure = el("div", "np-figure np-split-figure");
  figure.style.setProperty("--np-fig-width", px(figureWidth));
  figure.style.height = px(figureHeight);
  figure.append(buildImage(article.id, figureWidth, figureHeight));

  const text = el("div", "np-split-text");
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

function buildCard(
  article: Article,
  cardWidth: number,
  aspect: number,
  className: string,
): HTMLElement {
  const card = el("div", className);
  card.append(picture(article.id, cardWidth, Math.round(cardWidth * aspect)));
  card.append(categoryChip(article));
  card.append(
    clampText(
      "h3",
      "np-headline np-headline-sm",
      article.headline,
      2,
      LH_HEAD_SM,
    ),
  );
  card.append(clampText("p", "np-body", article.deck, 2, LH_HEAD_TEXT));
  card.append(bylineEl(article));
  return card;
}

function buildGrid(block: Block): HTMLElement {
  const inner = el("div", "np-grid-inner");
  const label = el("p", "np-section-label");
  label.textContent = "More from the desk";
  inner.append(label);

  const row = el("div", "np-grid-row");
  row.style.gap = `${COLUMN_GAP}px`;
  const cardWidth = (columnWidth() - COLUMN_GAP * 2) / 3;
  for (const article of block.articles) {
    row.append(buildCard(article, cardWidth, 0.66, "np-grid-card"));
  }
  inner.append(row);
  return inner;
}

function buildBriefs(block: Block): HTMLElement {
  const inner = el("div", "np-briefs-inner");
  const label = el("p", "np-section-label");
  label.textContent = "In brief";
  inner.append(label);

  for (const article of block.articles) {
    const brief = el("div", "np-brief");
    brief.append(
      clampText(
        "h3",
        "np-headline np-headline-xs",
        article.headline,
        1,
        LH_HEAD_SM,
      ),
    );
    brief.append(clampText("p", "np-body", article.deck, 2, LH_HEAD_TEXT));
    inner.append(brief);
  }
  return inner;
}

function broadsheetRender(kind: string, block: Block): HTMLElement {
  const lead = block.articles[0];
  if (kind === "feature" && lead) return buildFeature(lead);
  if (kind === "columns" && lead) return buildColumns(lead);
  if (kind === "split" && lead) return buildSplit(lead);
  if (kind === "grid") return buildGrid(block);
  if (kind === "briefs") return buildBriefs(block);
  return el("div", "");
}

// --- Modular templates -------------------------------------------------------

function buildMosaic(block: Block): HTMLElement {
  const lead = at(block.articles, 0);
  const inner = el("div", "np-mosaic-inner");
  inner.style.gap = `${COLUMN_GAP}px`;

  const main = el("div", "np-mosaic-main");
  const mainWidth = Math.round((columnWidth() - COLUMN_GAP) * 0.6);
  main.append(picture(lead.id, mainWidth, Math.round(mainWidth * 0.6)));
  main.append(categoryChip(lead));
  main.append(
    clampText("h2", "np-headline np-headline-lg", lead.headline, 2, 30),
  );
  main.append(clampText("p", "np-deck", lead.deck, 2, LH_DECK));
  main.append(bylineEl(lead));

  const side = el("div", "np-mosaic-side");
  for (const article of block.articles.slice(1)) {
    const item = el("div", "np-mosaic-item");
    item.append(categoryChip(article));
    item.append(
      clampText(
        "h3",
        "np-headline np-headline-sm",
        article.headline,
        2,
        LH_HEAD_SM,
      ),
    );
    item.append(clampText("p", "np-body", article.deck, 1, LH_HEAD_TEXT));
    side.append(item);
  }

  inner.append(main, side);
  return inner;
}

function buildTriptych(block: Block): HTMLElement {
  const inner = el("div", "np-triptych-inner");
  inner.style.gap = `${COLUMN_GAP}px`;
  const cardWidth = (columnWidth() - COLUMN_GAP * 2) / 3;
  for (const article of block.articles) {
    inner.append(buildCard(article, cardWidth, 0.82, "np-triptych-card"));
  }
  return inner;
}

function buildPair(block: Block): HTMLElement {
  const inner = el("div", "np-pair-inner");
  inner.style.gap = `${COLUMN_GAP}px`;
  const cardWidth = (columnWidth() - COLUMN_GAP) / 2;
  for (const article of block.articles) {
    const card = el("div", "np-pair-card");
    card.append(picture(article.id, cardWidth, Math.round(cardWidth * 0.58)));
    card.append(categoryChip(article));
    card.append(
      clampText("h2", "np-headline np-headline-lg", article.headline, 2, 30),
    );
    card.append(clampText("p", "np-deck", article.deck, 2, LH_DECK));
    card.append(clampText("p", "np-body", article.body, 2, LH_BODY));
    card.append(bylineEl(article));
    inner.append(card);
  }
  return inner;
}

function modularRender(kind: string, block: Block): HTMLElement {
  if (kind === "mosaic") return buildMosaic(block);
  if (kind === "triptych") return buildTriptych(block);
  if (kind === "pair") return buildPair(block);
  return el("div", "");
}

// --- Reader templates --------------------------------------------------------

function buildStory(block: Block): HTMLElement {
  const article = at(block.articles, 0);
  const inner = el("div", "np-story-inner");
  inner.append(categoryChip(article));
  inner.append(
    clampText(
      "h1",
      "np-headline np-headline-xl",
      article.headline,
      2,
      bigHeadlineLineHeight(),
    ),
  );
  inner.append(clampText("p", "np-deck", article.deck, 2, LH_DECK));
  inner.append(
    picture(article.id, columnWidth(), Math.round(columnWidth() * 0.6)),
  );
  inner.append(fixedText("np-body np-dropcap", article.body, 6, LH_BODY));
  inner.append(bylineEl(article));
  return inner;
}

function buildAside(block: Block): HTMLElement {
  const article = at(block.articles, 0);
  const inner = el("div", "np-aside-inner");
  inner.append(categoryChip(article));
  inner.append(
    clampText(
      "h3",
      "np-headline np-headline-sm",
      article.headline,
      2,
      LH_HEAD_SM,
    ),
  );
  inner.append(clampText("p", "np-body", article.deck, 2, LH_HEAD_TEXT));
  return inner;
}

function readerRender(kind: string, block: Block): HTMLElement {
  if (kind === "story") return buildStory(block);
  if (kind === "aside") return buildAside(block);
  return el("div", "");
}

// --- Radar templates (a console-style magazine) ------------------------------
// Adopts the *visual* language of a changelog "release radar" — bordered panels
// with a serif day numeral and headline (italic accent), monospace metadata, and
// a Newsreader synopsis — but carries the demo's own editorial articles,
// styled as dated magazine dispatches rather than software releases. Every region
// is line-clamped to a fixed line count, so each template measures to one exact,
// content-independent height. Colour lives in CSS variables, so the variant
// follows the light/dark theme toggle.

const RD_ISO = 16;
const RD_DAY = 56;
const RD_MONTH = 26;
const RD_META = 18;
const RD_THEME = 17;
const RD_HEAD = 38;
const RD_SYN = 24;
const RD_VAL = 30;
const RD_KEY = 16;
const RD_NOTE = 23;
const RD_NARROW = 680;

const RD_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const RD_DOTS = [
  "rd-green",
  "rd-violet",
  "rd-blue",
  "rd-amber",
  "rd-rose",
] as const;
const RD_NOTE_KEYS = ["In this edition", "Editor's note"] as const;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function dotClass(seed: number): string {
  const index = ((seed % RD_DOTS.length) + RD_DOTS.length) % RD_DOTS.length;
  return RD_DOTS[index] ?? "rd-green";
}

interface IssueMeta {
  iso: string;
  day: string;
  month: string;
}

function issueMeta(article: Article): IssueMeta {
  const rng = mulberry32(Math.imul(article.id + 17, 2246822519));
  const month = Math.floor(rng() * 12);
  const day = 1 + Math.floor(rng() * 28);
  return {
    iso: `2026 · ${pad2(month + 1)} · ${pad2(day)}`,
    day: pad2(day),
    month: RD_MONTHS[month] ?? "June",
  };
}

// A single fixed-height line that renders the glyph at full size — no line-clamp
// box, so a large serif numeral is not clipped by -webkit-box metrics.
function fixedLine(
  tag: string,
  className: string,
  text: string,
  lineHeight: number,
): HTMLElement {
  const node = el(tag, className);
  node.textContent = text;
  node.style.lineHeight = `${lineHeight}px`;
  node.style.height = px(lineHeight);
  node.style.whiteSpace = "nowrap";
  node.style.overflow = "hidden";
  return node;
}

// A headline whose trailing words carry an italic accent, built from DOM nodes
// (no innerHTML) inside the same fixed line-clamp box used everywhere else.
function radarHeadline(article: Article, lines: number): HTMLElement {
  const node = el("h3", "np-headline rc-headline");
  node.style.lineHeight = `${RD_HEAD}px`;
  node.style.height = px(lines * RD_HEAD);
  node.style.display = "-webkit-box";
  node.style.setProperty("-webkit-box-orient", "vertical");
  node.style.setProperty("-webkit-line-clamp", String(lines));
  node.style.overflow = "hidden";
  const parts = article.headline.split(" ");
  const tailCount = Math.min(2, Math.max(1, parts.length - 1));
  const head = parts.slice(0, parts.length - tailCount).join(" ");
  if (head.length > 0) node.append(document.createTextNode(`${head} `));
  const em = el("em", "rc-em");
  em.textContent = `${parts.slice(parts.length - tailCount).join(" ")}.`;
  node.append(em);
  return node;
}

function statLine(text: string, strong: boolean): HTMLElement {
  const node = el(strong ? "strong" : "span", "rc-stat-line");
  node.textContent = text;
  return node;
}

function buildDispatch(block: Block): HTMLElement {
  const lead = at(block.articles, 0);
  const meta = issueMeta(lead);
  const isFeatured = lead.id === 1;
  const dot = dotClass(lead.id);

  const inner = el("div", isFeatured ? "rc-grid rc-latest" : "rc-grid");
  if (columnWidth() < RD_NARROW) inner.classList.add("rc-grid-narrow");

  const date = el("div", "rc-date");
  const dateTop = el("div", "rc-date-top");
  dateTop.append(fixedLine("div", "rc-iso", meta.iso, RD_ISO));
  dateTop.append(fixedLine("div", "rc-day", meta.day, RD_DAY));
  dateTop.append(fixedLine("div", "rc-month", meta.month, RD_MONTH));
  dateTop.append(fixedLine("div", "rc-year", `No. ${lead.id}`, RD_META));
  const pill = el("div", isFeatured ? "rc-pill rc-pill-latest" : "rc-pill");
  pill.textContent = isFeatured ? "featured" : "archive";
  date.append(dateTop, pill);

  const body = el("div", "rc-body");
  const kicker = fixedLine(
    "div",
    isFeatured ? "rc-theme" : `rc-theme ${dot}`,
    `${lead.category} · Dispatch`,
    RD_THEME,
  );
  const headline = radarHeadline(lead, 2);
  if (!isFeatured) headline.classList.add(dot);
  body.append(
    kicker,
    headline,
    clampText("p", "rc-synopsis", lead.body, 3, RD_SYN),
    fixedLine("div", "rc-byline", lead.byline, RD_META),
  );

  const action = el("div", "rc-action");
  const cta = el("span", "rc-cta");
  cta.append(document.createTextNode("Read the story"));
  cta.append(el("span", "rc-arrow"));
  const stat = el("div", "rc-stat");
  stat.append(
    statLine(`${4 + (lead.id % 9)} min read`, false),
    statLine(`~${1 + (lead.id % 5)}k words`, true),
    statLine(lead.category, false),
  );
  action.append(cta, stat);

  inner.append(date, body, action);
  return inner;
}

function buildLedger(block: Block): HTMLElement {
  const inner = el("div", "rd-ledger");
  if (columnWidth() < RD_NARROW) inner.classList.add("rd-ledger-narrow");
  block.articles.slice(0, 4).forEach((article, index) => {
    const meta = issueMeta(article);
    const cell = el("div", `rd-cell ${dotClass(article.id + index)}`);
    cell.append(fixedLine("div", "rd-key", article.category, RD_KEY));
    cell.append(fixedLine("div", "rd-val", `No. ${article.id}`, RD_VAL));
    cell.append(
      fixedLine(
        "div",
        "rd-sub",
        `${article.byline.replace("By ", "")} · ${meta.iso}`,
        RD_KEY,
      ),
    );
    inner.append(cell);
  });
  return inner;
}

function buildNote(block: Block): HTMLElement {
  const inner = el("div", "rd-note");
  if (columnWidth() < RD_NARROW) inner.classList.add("rd-note-narrow");
  block.articles.slice(0, 2).forEach((article, index) => {
    const col = el("div", "rd-note-col");
    col.append(
      fixedLine("div", "rd-note-key", RD_NOTE_KEYS[index] ?? "Notes", RD_KEY),
    );
    col.append(
      clampText(
        "p",
        "rd-note-body",
        `${article.deck} ${article.body}`,
        4,
        RD_NOTE,
      ),
    );
    inner.append(col);
  });
  return inner;
}

function radarRender(kind: string, block: Block): HTMLElement {
  if (kind === "dispatch") return buildDispatch(block);
  if (kind === "ledger") return buildLedger(block);
  if (kind === "note") return buildNote(block);
  return el("div", "");
}

// --- Layouts -----------------------------------------------------------------

function isVariant(value: string): value is Variant {
  return (VARIANTS as readonly string[]).includes(value);
}

const LAYOUTS: Record<Variant, LayoutDef> = {
  broadsheet: {
    label: "Broadsheet",
    fonts: ["600 40px Fraunces", "900 64px Fraunces", "400 16px Newsreader"],
    rhythm: ["feature", "split", "grid", "columns", "briefs", "split", "grid"],
    perBlock: { feature: 1, split: 1, grid: 3, columns: 1, briefs: 4 },
    render: broadsheetRender,
  },
  modular: {
    label: "Modular",
    fonts: ["800 40px Archivo", "700 18px Archivo"],
    rhythm: ["mosaic", "triptych", "pair", "triptych", "mosaic", "pair"],
    perBlock: { mosaic: 4, triptych: 3, pair: 2 },
    render: modularRender,
  },
  reader: {
    label: "Reader",
    fonts: ["500 40px Fraunces", "400 18px Newsreader"],
    rhythm: ["story", "story", "aside", "story", "story", "aside"],
    perBlock: { story: 1, aside: 1 },
    render: readerRender,
  },
  radar: {
    label: "Radar",
    fonts: [
      "300 52px Fraunces",
      "400 30px Fraunces",
      "italic 400 22px Fraunces",
      "400 15px Newsreader",
      '500 11px "JetBrains Mono"',
      '400 11px "JetBrains Mono"',
    ],
    rhythm: [
      "dispatch",
      "dispatch",
      "ledger",
      "dispatch",
      "note",
      "dispatch",
      "dispatch",
      "ledger",
    ],
    perBlock: { dispatch: 4, ledger: 4, note: 2 },
    render: radarRender,
  },
};

let activeLayout: LayoutDef = LAYOUTS.radar;
let blocks: Block[] = [];
let firstIndexByKind: Record<string, number> = {};

function buildBlocks(layout: LayoutDef): Block[] {
  const result: Block[] = [{ kind: "masthead", articles: [] }];
  let cursor = 0;
  let rhythmIndex = 0;
  while (result.length < MAX_BLOCKS) {
    const kind = layout.rhythm[rhythmIndex % layout.rhythm.length]!;
    rhythmIndex++;
    const need = layout.perBlock[kind] ?? 1;
    if (cursor + need > articles.length) break;
    result.push({ kind, articles: articles.slice(cursor, cursor + need) });
    cursor += need;
  }
  return result;
}

function indexKinds(): void {
  firstIndexByKind = {};
  blocks.forEach((block, index) => {
    const kind = templateKey(block, index);
    if (firstIndexByKind[kind] === undefined) {
      firstIndexByKind[kind] = index;
    }
  });
}

function buildItem(index: number): HTMLElement {
  const block = at(blocks, index);
  const item = el("section", `np-block np-${block.kind}`);
  // The masthead (index 0) ends in its own rule, so the first story skips its
  // top rule to avoid stacking dividers.
  if (index === 1) item.classList.add("np-flush-top");

  const card = el("article", "np-card");
  card.style.maxWidth = px(columnWidth());
  card.append(
    block.kind === "masthead"
      ? buildMasthead()
      : activeLayout.render(block.kind, block),
  );

  item.append(card);
  return item;
}

// --- Heights (measured once per template) ------------------------------------

function measureTemplateHeights(): void {
  contentWidth = canvasWidthForViewport();
  measuredViewportWidth = viewport.clientWidth;
  const entries = Object.entries(firstIndexByKind);
  const heights = measurer.measureMany(
    entries.map(([, index]) => buildItem(index)),
  );
  entries.forEach(([kind], index) => {
    heightByKind[kind] = at(heights, index);
  });
}

function templateKey(block: Block, index: number): string {
  return `${block.kind}${index === 1 ? ":flush" : ""}`;
}

function rows(): Row[] {
  return blocks.map((block, index) => ({
    key: `${variant}:${index}`,
    index,
    height: heightByKind[templateKey(block, index)] ?? 320,
  }));
}

// --- Status bar / controls ---------------------------------------------------

function updateInfo(state: VirtualListState = virtualList.state): void {
  const rangeText = `${state.start + 1}-${state.end} / ${blocks.length} blocks`;
  if (rangeText !== renderedRangeText) {
    renderedRangeText = setTextIfChanged(rangeLabel, rangeText);
  }

  const mountedText = `${state.end - state.start} mounted`;
  if (mountedText !== renderedMountedText) {
    renderedMountedText = setTextIfChanged(mountedLabel, mountedText);
  }

  const layoutText = `${Math.round(columnWidth())}px column · ${articles.length} articles`;
  if (layoutText !== renderedLayoutText) {
    renderedLayoutText = setTextIfChanged(layoutLabel, layoutText);
  }
}

async function ensureFonts(fonts: readonly string[]): Promise<void> {
  await Promise.all(fonts.map((font) => document.fonts.load(font))).catch(
    () => undefined,
  );
}

async function applyVariant(next: Variant): Promise<void> {
  const generation = ++layoutGeneration;
  await ensureFonts(LAYOUTS[next].fonts);
  if (disposed || generation !== layoutGeneration) return;
  await virtualList.updateWindow(
    () => {
      variant = next;
      activeLayout = LAYOUTS[next];
      document.body.dataset.variant = next;
      blocks = buildBlocks(activeLayout);
      indexKinds();
      measureTemplateHeights();
      return { items: rows(), anchor: { key: `${variant}:0`, offset: 0 } };
    },
    lifetime.signal,
    { interrupt: true },
  );
}

function bindControls(): void {
  topBtn.addEventListener("click", () => {
    void virtualList.scrollTo("start", { behavior: "smooth" });
  });
  bottomBtn.addEventListener("click", () => {
    void virtualList.scrollTo("end", { behavior: "smooth" });
  });
  variantSelect.addEventListener("change", () => {
    const next = variantSelect.value;
    if (isVariant(next)) void applyVariant(next);
  });
}

function handleViewportResize(): void {
  if (Math.abs(viewport.clientWidth - measuredViewportWidth) <= 0.5) return;
  void virtualList.updateWindow(() => {
    if (
      disposed ||
      Math.abs(viewport.clientWidth - measuredViewportWidth) <= 0.5
    )
      return null;
    measureTemplateHeights();
    return { items: rows(), anchor: "viewport" };
  }, lifetime.signal);
}

// --- Boot --------------------------------------------------------------------

let disposed = false;
let layoutGeneration = 0;
const lifetime = new AbortController();
const measurer = createItemMeasurer({ viewport });
const imageLoader = createImageLoader({ viewport, concurrency: 4 });

blocks = buildBlocks(activeLayout);
indexKinds();
document.body.dataset.variant = variant;
variantSelect.value = variant;
bindThemeButtons(refreshTheme);
refreshTheme();
loadLabel.textContent = "virtualized layouts";

// Heights are measured from rendered text, so the editorial fonts must be in
// before the first measurement — otherwise blocks would be sized with fallback
// metrics and shift once the real faces swap in. Preload the default variant's
// faces plus the few cross-variant extras so the first switch stays reflow-free.
await document.fonts.ready;
await ensureFonts([
  ...activeLayout.fonts,
  "400 16px Newsreader",
  "italic 400 18px Newsreader",
  "600 12px Archivo",
]);
measureTemplateHeights();

virtualList = createVirtualList(viewport, {
  items: rows(),
  key: (row) => row.key,
  height: (row) => row.height,
  render: (row) => buildItem(row.index),
  boot: "start",
  overscanPx: OVERSCAN_PX,
  onMount: (element) => {
    imageLoader.update({
      add: Array.from(
        element.querySelectorAll<HTMLImageElement>("img[data-src]"),
        (img) => ({ img, src: img.dataset.src ?? "" }),
      ),
    });
  },
  onUnmount: (element) => {
    const images = Array.from(element.querySelectorAll("img"));
    imageLoader.update({ remove: images });
    imageLoader.forget(images.map((img) => img.dataset.src ?? ""));
    for (const img of images) img.removeAttribute("src");
  },
  onState: (state) => {
    updateInfo(state);
    imageLoader.reprioritize();
  },
});
bindControls();

const viewportResizeObserver = new ResizeObserver(handleViewportResize);
viewportResizeObserver.observe(viewport);

updateInfo();
document.documentElement.classList.remove("booting");
watchSystemTheme(refreshTheme);
window.addEventListener("pagehide", () => {
  disposed = true;
  lifetime.abort();
  viewportResizeObserver.disconnect();
  virtualList.dispose();
  measurer.dispose();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
