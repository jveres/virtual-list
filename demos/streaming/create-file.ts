import { MAX_ATTACHMENT_BYTES, storedAttachments } from "./attachments.js";
import {
  type GeneratedFile,
  MAX_LOCAL_FILE_BYTES,
  storedGeneratedFiles,
} from "./generated-files.js";

const MAX_TEMPLATE_BYTES = 1_000_000;

/** Labels only images in this request's selected context; never fetches URLs. */
export function fileImageContext(input: readonly Record<string, unknown>[]): {
  input: Record<string, unknown>[];
  images: ReadonlyMap<string, string>;
} {
  const images = new Map<string, string>();
  const labeled = input.map((item) => {
    if (!Array.isArray(item.content)) return item;
    const content = item.content.flatMap((part: unknown) => {
      if (
        !part ||
        typeof part !== "object" ||
        !("type" in part) ||
        part.type !== "input_image" ||
        !("image_url" in part) ||
        typeof part.image_url !== "string"
      )
        return [part];
      const url = part.image_url;
      if (url.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 64)
        return [part];
      const match =
        /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
      if (!match?.[2]) return [part];
      const encoded = match[2];
      const size =
        (encoded.length / 4) * 3 -
        (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
      if (
        !storedAttachments([
          {
            name: `image.${match[1]}`,
            mimeType: `image/${match[1]}`,
            size,
            dataUrl: url,
          },
        ]).length
      )
        return [part];
      const id = String(images.size + 1);
      images.set(id, url);
      return [
        {
          type: "input_text",
          text: `Image reference for create_file: {{attachment:${id}}} (the following image).`,
        },
        part,
      ];
    });
    return { ...item, content };
  });
  return { input: labeled, images };
}

export const CREATE_FILE_TOOL = {
  type: "function",
  name: "create_file",
  description:
    'Create a downloadable UTF-8 text file (HTML, Markdown, CSV, JSON, SVG, or source code). Provide complete content, not a code fence. To embed an available image, use its labeled {{attachment:N}} reference as a quoted URL, e.g. <img src="{{attachment:1}}">. The tool inserts the original data URL locally; never reproduce base64 or ask the user to select the image again. Only use references supplied beside images in the current context. No code execution or binary formats such as PDF, DOCX, ZIP. Maximum 1 MB of text before embedding, 16 MiB including embedded images.',
  strict: true,
  parameters: {
    type: "object",
    properties: {
      filename: {
        type: "string",
        description:
          "Filename with a text-format extension, without directories.",
      },
      content: {
        type: "string",
        description: "Complete literal UTF-8 file content.",
      },
    },
    required: ["filename", "content"],
    additionalProperties: false,
  },
};

/** Decode model arguments into inert persisted bytes; never evaluate or write a path. */
export function createTextFile(
  argumentsJSON: string,
  fileId: string,
  images: ReadonlyMap<string, string> = new Map(),
): GeneratedFile {
  if (argumentsJSON.length > MAX_TEMPLATE_BYTES * 6 + 1024)
    throw new Error("File exceeds the 1 MB limit.");
  const args: unknown = JSON.parse(argumentsJSON);
  if (
    !args ||
    typeof args !== "object" ||
    !("filename" in args) ||
    !("content" in args) ||
    typeof args.content !== "string"
  )
    throw new Error(
      "create_file requires a filename and complete text content.",
    );
  if (
    args.content.length > MAX_TEMPLATE_BYTES ||
    new TextEncoder().encode(args.content).length > MAX_TEMPLATE_BYTES
  )
    throw new Error(
      "File text exceeds the 1 MB limit before embedding images.",
    );
  // Bound expansion before allocating the final string, including repeated references.
  let expandedBytes = new TextEncoder().encode(args.content).length;
  const content = args.content.replace(
    /\{\{attachment:([^{}]*)\}\}/g,
    (placeholder, id: string) => {
      const url = images.get(id);
      if (!url)
        throw new Error(
          `Unknown image reference ${placeholder}. Use only references from the current context.`,
        );
      expandedBytes += url.length - placeholder.length;
      if (expandedBytes > MAX_LOCAL_FILE_BYTES)
        throw new Error(
          "File exceeds the 16 MiB limit after embedding images.",
        );
      return url;
    },
  );
  const file = storedGeneratedFiles([
    { fileId, filename: args.filename, content },
  ])[0];
  if (!file)
    throw new Error(
      "Invalid text file or content exceeds the 16 MiB UTF-8 limit.",
    );
  if (
    !/\.(?:html?|md|txt|csv|tsv|json|xml|svg|css|js|mjs|cjs|ts|tsx|jsx|py|sh|sql|ya?ml|toml|ini|log|tex|c|h|cpp|rs|go|java)$/i.test(
      file.filename,
    )
  )
    throw new Error(
      "Use a text-format extension such as .html, .md, .csv, or .json; binary file generation is not supported.",
    );
  return file;
}
