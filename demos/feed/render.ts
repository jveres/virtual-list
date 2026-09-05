import { renderMarkdown } from "../shared/markdown";
import { type FeedPost, safeUrl } from "./source";

const allowedTags = new Set(
  "a blockquote br code em h1 h2 h3 h4 hr li ol p pre strong table tbody td th thead tr ul".split(
    " ",
  ),
);
const droppedTags = new Set(
  "embed iframe link math meta object script style svg".split(" "),
);

// Rebuild a small allowlisted DOM, as in main's public-feed demo. No remote
// attributes, styles, handlers, or HTML images survive markdown rendering.
function safeMarkdown(markdown: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = renderMarkdown(markdown);
  const output = document.createDocumentFragment();
  const append = (node: Node, parent: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.appendChild(document.createTextNode(node.textContent ?? ""));
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.tagName.toLowerCase();
    if (droppedTags.has(tag)) return;
    if (tag === "img") {
      parent.appendChild(
        document.createTextNode(node.getAttribute("alt") ?? ""),
      );
      return;
    }
    const element = allowedTags.has(tag) ? document.createElement(tag) : null;
    if (element && tag === "a") {
      const url = safeUrl(node.getAttribute("href"));
      if (url) {
        element.setAttribute("href", url);
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer nofollow");
      }
    }
    for (const child of node.childNodes) append(child, element ?? parent);
    if (element) parent.appendChild(element);
  };
  for (const child of template.content.childNodes) append(child, output);
  return output;
}

function link(url: string): HTMLAnchorElement {
  const element = document.createElement("a");
  element.href = url;
  element.target = "_blank";
  element.rel = "noopener noreferrer nofollow";
  return element;
}

type TextLayout = {
  update: () => void;
  content: HTMLElement;
  observer?: ResizeObserver;
  frame?: number;
};
const textLayouts = new WeakMap<HTMLElement, TextLayout>();

export function renderPost(
  post: FeedPost,
  toggle: (key: string) => void,
  width = document.documentElement.clientWidth,
): HTMLElement {
  const article = document.createElement("article");
  article.className = "feed-post";
  article.dataset.postKey = post.key;
  const meta = document.createElement("div");
  meta.className = "post-meta";
  const date = new Date(post.date);
  meta.textContent = `${post.author}${Number.isNaN(date.getTime()) ? "" : ` · ${date.toLocaleString()}`}`;
  article.append(meta);
  if (post.title) {
    const title = document.createElement("h2");
    title.textContent = post.title;
    article.append(title);
  }
  const body = document.createElement("div");
  body.className = `post-body ${post.markdown ? "markdown" : "plaintext"}`;
  const content = document.createElement("div");
  content.className = "post-text";
  if (post.markdown) content.append(safeMarkdown(post.text));
  else content.textContent = post.text;
  body.append(content);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "text-toggle";
  button.textContent = post.expanded ? "Show less" : "Show more";
  button.setAttribute("aria-expanded", String(post.expanded));
  button.addEventListener("click", () => toggle(post.key));
  article.append(body, button);
  const update = (): void => {
    if (!content.isConnected) return;
    const limit = Number.parseFloat(getComputedStyle(body).fontSize) * 18;
    const overflows = content.getBoundingClientRect().height > limit + 1;
    button.hidden = !overflows;
    body.classList.toggle("collapsed", overflows && !post.expanded);
  };
  // Decide from laid-out text, not character count. This is off-scroller and
  // happens before the runtime's row premeasurement, so hidden controls never
  // reserve a spurious button or a faded band in the measured snapshot.
  const probe = document.createElement("div");
  Object.assign(probe.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: `${width}px`,
    visibility: "hidden",
    pointerEvents: "none",
  });
  probe.append(article);
  document.body.append(probe);
  try {
    update();
  } finally {
    article.remove();
    probe.remove();
  }
  textLayouts.set(article, { update, content });
  const mediaItems = post.media.slice(0, 4);
  const grid = document.createElement("div");
  grid.className = `post-media count-${mediaItems.length}`;
  for (const media of mediaItems) {
    const anchor = link(media.url);
    anchor.className = "post-image";
    anchor.setAttribute("aria-label", media.alt || "Open post image");
    if (mediaItems.length === 1)
      anchor.style.aspectRatio = `${media.width} / ${media.height}`;
    const image = document.createElement("img");
    image.alt = media.alt;
    image.width = media.width;
    image.height = media.height;
    image.dataset.src = media.preview;
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    anchor.append(image);
    grid.append(anchor);
  }
  if (mediaItems.length) article.append(grid);
  return article;
}

export function mountPost(element: HTMLElement): void {
  const layout = textLayouts.get(element);
  if (layout) {
    layout.update();
    layout.observer?.disconnect();
    // ResizeObserver delivery must not mutate an observed ancestor's size in
    // the same delivery (WebKit reports an undelivered-notifications loop).
    layout.observer = new ResizeObserver(() => {
      if (layout.frame !== undefined) return;
      layout.frame = requestAnimationFrame(() => {
        layout.frame = undefined;
        layout.update();
      });
    });
    layout.observer.observe(layout.content);
  }
  for (const image of element.querySelectorAll<HTMLImageElement>(
    "img[data-src]",
  )) {
    if (!image.hasAttribute("src")) image.src = image.dataset.src ?? "";
  }
}

export function unmountPost(element: HTMLElement): void {
  const layout = textLayouts.get(element);
  layout?.observer?.disconnect();
  if (layout) {
    layout.observer = undefined;
    if (layout.frame !== undefined) cancelAnimationFrame(layout.frame);
    layout.frame = undefined;
  }
  for (const image of element.querySelectorAll("img"))
    image.removeAttribute("src");
}
