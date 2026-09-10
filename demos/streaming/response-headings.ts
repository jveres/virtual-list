import { renderToHtml } from "markdown-viewer";
import { messageParts, type OrderedMessage } from "../shared/message-order.js";

export interface ResponseHeading {
  /** Ordinal among the response's rendered H1/H2 elements, not a slug. */
  index: number;
  level: 1 | 2;
  label: string;
}

/** Use the message renderer's parser, including its tool-separated text blocks.
 * The generated HTML stays a string; only plain heading labels leave here. */
export function responseHeadings(message: OrderedMessage): ResponseHeading[] {
  const headings: ResponseHeading[] = [];
  for (const part of messageParts(message)) {
    if (part.kind !== "text" || !part.text.trim()) continue;
    renderToHtml(part.text, {
      hooks: {
        onCodeBlock: () => "",
        onImage: () => "",
        onHeading: ({ level, text }) => {
          if (level === 1 || level === 2)
            headings.push({
              index: headings.length,
              level,
              label: text.replace(/\s+/g, " ").trim() || "Untitled section",
            });
          return "";
        },
      },
    });
  }
  return headings;
}
