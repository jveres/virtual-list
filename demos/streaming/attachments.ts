/** Local file bytes travel with the turn, including offline history/export. */
export interface ChatAttachment {
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
}

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

const FILE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  html: "text/html",
  xml: "application/xml",
  css: "text/css",
  js: "text/javascript",
  ts: "text/plain",
  tsx: "text/plain",
  jsx: "text/plain",
  py: "text/x-python",
  rs: "text/plain",
  c: "text/plain",
  cpp: "text/plain",
  h: "text/plain",
  java: "text/plain",
  go: "text/plain",
  sh: "text/plain",
  sql: "text/plain",
  yaml: "text/plain",
  yml: "text/plain",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  rtf: "application/rtf",
  odt: "application/vnd.oasis.opendocument.text",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export const ATTACHMENT_ACCEPT = Object.keys(FILE_TYPES)
  .map((extension) => `.${extension}`)
  .join(",");

function mimeForName(name: string): string | undefined {
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  return Object.hasOwn(FILE_TYPES, extension)
    ? FILE_TYPES[extension]
    : undefined;
}

function validateFiles(
  files: readonly Pick<ChatAttachment, "name" | "size">[],
): void {
  if (files.length > MAX_ATTACHMENTS)
    throw new Error("Attach up to 10 files per message.");
  let total = 0;
  for (const file of files) {
    if (!mimeForName(file.name))
      throw new Error(`${file.name}: unsupported file type.`);
    if (!Number.isSafeInteger(file.size) || file.size <= 0)
      throw new Error(`${file.name}: the file is empty or invalid.`);
    if (file.size > MAX_ATTACHMENT_BYTES)
      throw new Error(`${file.name}: files must be 10 MB or smaller.`);
    total += file.size;
  }
  if (total > MAX_MESSAGE_ATTACHMENT_BYTES)
    throw new Error("Attachments must total 20 MB or less per message.");
}

/** Validate the whole selection before reading; a rejected batch adds nothing. */
export async function readAttachments(
  files: readonly File[],
  existing: readonly ChatAttachment[] = [],
): Promise<ChatAttachment[]> {
  validateFiles([...existing, ...files]);
  const attachments: ChatAttachment[] = [];
  for (const file of files) {
    const mimeType = mimeForName(file.name);
    if (!mimeType) throw new Error(`${file.name}: unsupported file type.`);
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () =>
        typeof reader.result === "string"
          ? resolve(reader.result)
          : reject(new Error(`Could not read ${file.name}.`));
      reader.onerror = reader.onabort = () =>
        reject(new Error(`Could not read ${file.name}.`));
      reader.readAsDataURL(file.slice(0, file.size, mimeType));
    });
    attachments.push({ name: file.name, mimeType, size: file.size, dataUrl });
  }
  return attachments;
}

/** Treat imported/local storage metadata as untrusted, including its URLs. */
export function storedAttachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return [];
  const result: ChatAttachment[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return [];
    const { name, mimeType, size, dataUrl } = entry;
    if (
      typeof name !== "string" ||
      typeof mimeType !== "string" ||
      typeof size !== "number" ||
      typeof dataUrl !== "string" ||
      mimeForName(name) !== mimeType
    )
      return [];
    const prefix = `data:${mimeType};base64,`;
    if (
      !dataUrl.startsWith(prefix) ||
      dataUrl.length > prefix.length + Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4
    )
      return [];
    const encoded = dataUrl.slice(prefix.length);
    if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
      return [];
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    if ((encoded.length / 4) * 3 - padding !== size) return [];
    result.push({ name, mimeType, size, dataUrl });
  }
  try {
    validateFiles(result);
    return result;
  } catch {
    return [];
  }
}

export function attachmentInput(
  attachment: ChatAttachment,
): Record<string, unknown> {
  return attachment.mimeType.startsWith("image/")
    ? { type: "input_image", image_url: attachment.dataUrl, detail: "auto" }
    : {
        type: "input_file",
        filename: attachment.name,
        file_data: attachment.dataUrl,
      };
}

function openAttachment(attachment: ChatAttachment): void {
  const [validated] = storedAttachments([attachment]);
  if (!validated) return;
  const encoded = validated.dataUrl.slice(validated.dataUrl.indexOf(",") + 1);
  const bytes = Uint8Array.from(atob(encoded), (character) =>
    character.charCodeAt(0),
  );
  // Active documents must not execute in a blob URL with the app's origin.
  const type =
    validated.mimeType === "text/html" ||
    validated.mimeType === "application/xml"
      ? "text/plain"
      : validated.mimeType;
  const url = URL.createObjectURL(new File([bytes], validated.name, { type }));
  try {
    // Keep this synchronous with the click so popup blockers see the user gesture.
    window.open(url, "_blank", "noopener,noreferrer");
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

/** No file contents or filenames are interpreted as HTML. */
export function attachmentChip(attachment: ChatAttachment): HTMLElement {
  const chip = document.createElement("div");
  chip.className = "attachment-chip";
  if (attachment.mimeType.startsWith("image/")) {
    const image = document.createElement("img");
    image.src = attachment.dataUrl;
    image.alt = "";
    image.width = image.height = 40;
    chip.append(image);
  }
  const label = document.createElement("span");
  label.className = "attachment-name";
  label.textContent = attachment.name;
  label.title = attachment.name;
  const size = document.createElement("span");
  size.className = "attachment-size";
  size.textContent =
    attachment.size < 1024 * 1024
      ? `${Math.max(1, Math.ceil(attachment.size / 1024))} KB`
      : `${(attachment.size / (1024 * 1024)).toFixed(1)} MB`;
  if (attachment.mimeType.startsWith("image/")) {
    chip.append(label, size);
  } else {
    chip.classList.add("attachment-file");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "attachment-open";
    open.title = `Open ${attachment.name} in a new tab`;
    open.setAttribute("aria-label", open.title);
    open.append(label, size);
    open.addEventListener("click", () => openAttachment(attachment));
    chip.append(open);
  }
  return chip;
}
