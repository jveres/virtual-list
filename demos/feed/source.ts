import type { Page } from "../../src/paging";

export type FeedSource = "bsky" | "lemmy";
export type FeedCursor = { endpoint: string; token: string };
type FeedMedia = {
  preview: string;
  url: string;
  alt: string;
  width: number;
  height: number;
};
export type FeedPost = {
  key: string;
  author: string;
  title: string;
  text: string;
  markdown: boolean;
  date: string;
  url: string;
  media: FeedMedia[];
  expanded: boolean;
};

// A continuation is pinned to the
// exact server AND API version that issued it; refresh starts a new session.
const bskyEndpoint = "https://public.api.bsky.app/xrpc/app.bsky.feed.getFeed";
const discoverFeed =
  "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot";
const lemmyEndpoints = [
  "https://lemmy.world",
  "https://lemmy.ml",
  "https://programming.dev",
  "https://sh.itjust.works",
].flatMap((origin) => [
  `${origin}/api/v4/post/list`,
  `${origin}/api/v3/post/list`,
]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function safeUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}

function dimension(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function bskyMedia(value: unknown, depth = 0): FeedMedia[] {
  if (depth > 2) return [];
  const embed = record(value);
  const images = Array.isArray(embed.images) ? embed.images : [];
  return images
    .slice(0, 4)
    .flatMap((value): FeedMedia[] => {
      const image = record(value);
      const preview = safeUrl(image.thumb) || safeUrl(image.fullsize);
      if (!preview) return [];
      const ratio = record(image.aspectRatio);
      return [
        {
          preview,
          url: safeUrl(image.fullsize) || preview,
          alt: string(image.alt),
          width: dimension(ratio.width, 16),
          height: dimension(ratio.height, 9),
        },
      ];
    })
    .concat(bskyMediaChild(embed.media, depth));
}

function bskyMediaChild(value: unknown, depth: number): FeedMedia[] {
  return value ? bskyMedia(value, depth + 1) : [];
}

function bskyPost(value: unknown): FeedPost | null {
  const post = record(record(value).post);
  const author = record(post.author);
  const body = record(post.record);
  const uri = string(post.uri);
  if (!uri || !string(author.handle)) return null;
  const media = bskyMedia(post.embed);
  if (!string(body.text) && !media.length) return null;
  const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri);
  return {
    key: `bsky:${uri}`,
    author: string(author.displayName) || `@${string(author.handle)}`,
    title: "",
    text: string(body.text),
    markdown: false,
    date: string(body.createdAt) || string(post.indexedAt),
    url: match
      ? `https://bsky.app/profile/${encodeURIComponent(match[1] ?? "")}/post/${encodeURIComponent(match[2] ?? "")}`
      : "",
    media,
    expanded: false,
  };
}

function lemmyPost(value: unknown, origin: string): FeedPost | null {
  const view = record(value);
  const post = record(view.post);
  const creator = record(view.creator);
  const community = record(view.community);
  const id = typeof post.id === "number" ? String(post.id) : string(post.id);
  const remoteId =
    safeUrl(post.ap_id) ||
    (id ? `${origin}/post/${encodeURIComponent(id)}` : "");
  if (!remoteId || !string(post.name)) return null;
  const details = record(view.image_details);
  const preview = safeUrl(post.thumbnail_url) || safeUrl(details.link);
  return {
    key: `lemmy:${remoteId}`,
    author: `${string(creator.display_name) || string(creator.name)} in ${string(community.title) || string(community.name)}`,
    title: string(post.name),
    text: string(post.body),
    markdown: true,
    date: string(post.published_at) || string(post.published),
    url: safeUrl(post.url) || remoteId,
    media: preview
      ? [
          {
            preview,
            url: safeUrl(post.url) || safeUrl(details.link) || preview,
            alt: string(post.alt_text) || string(post.name),
            width: dimension(details.width, 16),
            height: dimension(details.height, 9),
          },
        ]
      : [],
    expanded: false,
  };
}

export async function fetchFeedPage(
  source: FeedSource,
  cursor: FeedCursor | undefined,
  limit: number,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<Page<FeedPost, FeedCursor>> {
  const endpoints = source === "bsky" ? [bskyEndpoint] : lemmyEndpoints;
  if (cursor && !endpoints.includes(cursor.endpoint))
    throw new Error("Cursor belongs to a different feed");
  let lastError: unknown = new Error("No public feed responded");
  for (const endpoint of cursor ? [cursor.endpoint] : endpoints) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error("Feed request timed out")),
      10_000,
    );
    try {
      const url = new URL(endpoint);
      url.searchParams.set(
        "limit",
        String(
          Math.min(
            source === "bsky" ? 100 : 50,
            Math.max(1, Math.floor(limit) || 25),
          ),
        ),
      );
      if (source === "bsky") {
        url.searchParams.set("feed", discoverFeed);
        if (cursor?.token) url.searchParams.set("cursor", cursor.token);
      } else {
        const v4 = url.pathname.includes("/v4/");
        url.searchParams.set("sort", v4 ? "new" : "New");
        url.searchParams.set("type_", v4 ? "all" : "All");
        url.searchParams.set("show_nsfw", "false");
        if (cursor?.token) url.searchParams.set("page_cursor", cursor.token);
      }
      const response = await request(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
        credentials: "omit",
      });
      if (!response.ok) throw new Error(`${url.host}: HTTP ${response.status}`);
      const data = record(await response.json());
      controller.signal.throwIfAborted();
      const rows: unknown =
        source === "bsky" ? data.feed : (data.items ?? data.posts);
      if (!Array.isArray(rows))
        throw new Error(`${url.host}: invalid feed response`);
      const items = rows.flatMap((row): FeedPost[] => {
        const post =
          source === "bsky" ? bskyPost(row) : lemmyPost(row, url.origin);
        return post ? [post] : [];
      });
      const token = string(source === "bsky" ? data.cursor : data.next_page);
      return {
        items,
        // Neither public feed promises stable backward replay. Do not disguise
        // a fresh head fetch as restoration of an evicted page.
        start: { available: false },
        end:
          token && token !== cursor?.token
            ? { available: true, cursor: { endpoint, token } }
            : { available: false },
      };
    } catch (error) {
      signal.throwIfAborted();
      lastError = error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
  }
  throw lastError;
}
