import { describe, expect, it } from "vitest";
import {
  type FeedCursor,
  fetchFeedPage,
  safeUrl,
} from "../../demos/feed/source";

function signal(): AbortSignal {
  return new AbortController().signal;
}
function continuation(
  page: Awaited<ReturnType<typeof fetchFeedPage>>,
): FeedCursor {
  if (!page.end.available) throw new Error("Expected continuation");
  return page.end.cursor;
}
const post = {
  post: {
    uri: "at://did:plc:alice/app.bsky.feed.post/123",
    author: { handle: "alice.test", displayName: "Alice" },
    record: {
      text: "Hello <script>world</script>",
      createdAt: "2026-09-05T10:00:00Z",
    },
  },
};

describe("public feed source", () => {
  it("should omit an empty cursor when checking the Lemmy head on a pinned endpoint", async () => {
    const urls: URL[] = [];
    const request: typeof fetch = async (input) => {
      urls.push(new URL(String(input)));
      return Response.json({ posts: [], next_page: "next" });
    };

    await fetchFeedPage(
      "lemmy",
      { endpoint: "https://lemmy.world/api/v3/post/list", token: "" },
      25,
      signal(),
      request,
    );

    expect(urls[0]?.pathname).toBe("/api/v3/post/list");
    expect(urls[0]?.searchParams.has("page_cursor")).toBe(false);
  });
  it("should retain a continuation on an empty page", async () => {
    const request: typeof fetch = async () =>
      Response.json({ feed: [], cursor: "opaque-next" });

    const page = await fetchFeedPage("bsky", undefined, 25, signal(), request);

    expect(page.items).toEqual([]);
    expect(page.start).toEqual({ available: false });
    expect(continuation(page).token).toBe("opaque-next");
  });

  it("should normalize Bluesky text without interpreting it as HTML", async () => {
    const request: typeof fetch = async () => Response.json({ feed: [post] });

    const page = await fetchFeedPage("bsky", undefined, 25, signal(), request);

    expect(page.items).toEqual([
      {
        key: "bsky:at://did:plc:alice/app.bsky.feed.post/123",
        author: "Alice",
        title: "",
        text: "Hello <script>world</script>",
        markdown: false,
        date: "2026-09-05T10:00:00Z",
        url: "https://bsky.app/profile/did%3Aplc%3Aalice/post/123",
        media: [],
        expanded: false,
      },
    ]);
    expect(page.end).toEqual({ available: false });
  });

  it("should pin Lemmy continuations to the responding host and API version", async () => {
    const urls: URL[] = [];
    const request: typeof fetch = async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      if (url.pathname.includes("v4"))
        return new Response(null, { status: 404 });
      if (url.searchParams.has("page_cursor"))
        return new Response(null, { status: 503 });
      return Response.json({
        posts: [
          {
            post: { id: 42, name: "Title", body: "**Hello**" },
            creator: { name: "Alice" },
            community: { name: "dev" },
          },
        ],
        next_page: "opaque",
      });
    };
    const page = await fetchFeedPage("lemmy", undefined, 25, signal(), request);

    await expect(
      fetchFeedPage("lemmy", continuation(page), 25, signal(), request),
    ).rejects.toThrow("HTTP 503");

    expect(urls.map((url) => url.pathname)).toEqual([
      "/api/v4/post/list",
      "/api/v3/post/list",
      "/api/v3/post/list",
    ]);
    expect(urls.at(-1)?.searchParams.get("page_cursor")).toBe("opaque");
    expect(page.items[0]?.key).toBe("lemmy:https://lemmy.world/post/42");
    expect(page.items[0]?.markdown).toBe(true);
  });

  it("should stop when a server repeats its cursor", async () => {
    const request: typeof fetch = async () =>
      Response.json({ feed: [post], cursor: "same" });
    const initial = await fetchFeedPage(
      "bsky",
      undefined,
      25,
      signal(),
      request,
    );

    const next = await fetchFeedPage(
      "bsky",
      continuation(initial),
      25,
      signal(),
      request,
    );

    expect(next.end).toEqual({ available: false });
  });

  it("should reject malformed pages and permit retry with the same continuation", async () => {
    let malformed = true;
    const request: typeof fetch = async () =>
      Response.json(malformed ? { error: "not a page" } : { feed: [post] });
    const cursor = {
      endpoint: "https://public.api.bsky.app/xrpc/app.bsky.feed.getFeed",
      token: "retry-me",
    };

    await expect(
      fetchFeedPage("bsky", cursor, 25, signal(), request),
    ).rejects.toThrow("invalid feed response");
    malformed = false;
    const page = await fetchFeedPage("bsky", cursor, 25, signal(), request);

    expect(page.items).toHaveLength(1);
  });

  it("should reject a late response after cancellation without trying another instance", async () => {
    const controller = new AbortController();
    const urls: string[] = [];
    const request: typeof fetch = async (input) => {
      urls.push(String(input));
      controller.abort();
      return Response.json({ posts: [], next_page: "stale" });
    };

    await expect(
      fetchFeedPage("lemmy", undefined, 25, controller.signal, request),
    ).rejects.toThrow();

    expect(urls).toHaveLength(1);
  });

  it("should ignore malformed items and unsafe media URLs", async () => {
    const request: typeof fetch = async () =>
      Response.json({
        feed: [
          null,
          {},
          {
            post: {
              ...post.post,
              embed: {
                images: [
                  { thumb: "javascript:alert(1)" },
                  {
                    thumb: "https://example.com/photo.jpg",
                    aspectRatio: { width: -1, height: "bad" },
                  },
                ],
              },
            },
          },
        ],
        cursor: "next",
      });

    const page = await fetchFeedPage("bsky", undefined, 25, signal(), request);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.media).toEqual([
      {
        preview: "https://example.com/photo.jpg",
        url: "https://example.com/photo.jpg",
        alt: "",
        width: 16,
        height: 9,
      },
    ]);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "/relative",
    "https://user:pass@example.com",
    null,
  ])("should reject unsafe URL %s", (value) => {
    expect(safeUrl(value)).toBe("");
  });
});
