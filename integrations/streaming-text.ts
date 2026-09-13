/** Syntactic shape only; URL safety remains the Markdown renderer's responsibility. */
export const EMBEDDED_IMAGE_PATTERN =
  "!\\[[^\\]]*\\]\\(data:image\\/[a-z.+-]+;base64,[^)]*\\)";
const trailingImage = new RegExp(`${EMBEDDED_IMAGE_PATTERN}$`);

/** Display-only normalization. Always preserve the raw source for finalization/storage. */
export function streamingMarkdownText(markdown: string): string {
  const trimmed = markdown.trimEnd();
  return trailingImage.test(trimmed) ? `${trimmed}\n\n` : trimmed;
}
