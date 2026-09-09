/** Remote artifact references, not uploaded inputs or executable URLs. */
export interface GeneratedFile {
  fileId: string;
  containerId?: string;
  filename: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
}

function downloadName(value: string, fallback: string): string {
  const basename = value.replaceAll("\\", "/").split("/").at(-1) ?? "";
  // Never use a server-supplied path or control characters as a local name.
  const name = Array.from(basename)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127 && !(code >= 0x202a && code <= 0x202e);
    })
    .join("")
    .trim();
  return name && name !== "." && name !== ".." ? name : fallback;
}

/** Validate stored references too: imported history is untrusted input. */
export function storedGeneratedFiles(value: unknown): GeneratedFile[] {
  if (!Array.isArray(value)) return [];
  const files: GeneratedFile[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !validId(entry.fileId) ||
      typeof entry.filename !== "string" ||
      (entry.containerId !== undefined && !validId(entry.containerId))
    )
      continue;
    const key = `${entry.containerId ?? ""}/${entry.fileId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    files.push({
      fileId: entry.fileId,
      ...(entry.containerId !== undefined
        ? { containerId: entry.containerId }
        : {}),
      filename: downloadName(entry.filename, entry.fileId),
    });
  }
  return files;
}

export function filesFromAnnotations(value: unknown): GeneratedFile[] {
  if (!Array.isArray(value)) return [];
  return storedGeneratedFiles(
    value.flatMap((annotation) => {
      if (!isRecord(annotation)) return [];
      if (annotation.type === "container_file_citation") {
        if (!validId(annotation.container_id)) return [];
        return [
          {
            containerId: annotation.container_id,
            fileId: annotation.file_id,
            filename: annotation.filename,
          },
        ];
      }
      if (annotation.type === "file_path") {
        return [
          {
            fileId: annotation.file_id,
            filename: annotation.filename ?? annotation.file_id,
          },
        ];
      }
      // file_citation refers to a source, not a newly generated artifact.
      return [];
    }),
  );
}

/** Also recovers artifacts from replies saved before file UI existed. */
export function filesFromOutput(output: unknown): GeneratedFile[] {
  if (!Array.isArray(output)) return [];
  return storedGeneratedFiles(
    output.flatMap((item) => {
      if (
        !isRecord(item) ||
        item.type !== "message" ||
        !Array.isArray(item.content)
      )
        return [];
      return item.content.flatMap((part) =>
        isRecord(part) ? filesFromAnnotations(part.annotations) : [],
      );
    }),
  );
}

/** Authenticate only to the fixed OpenAI origin; never to an annotation URL. */
export async function fetchGeneratedFile(
  file: GeneratedFile,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const safe = storedGeneratedFiles([file])[0];
  if (!safe) throw new Error("Invalid generated-file reference.");
  if (!apiKey.trim())
    throw new Error(
      "Enter your OpenAI API key in AI settings to download this file.",
    );
  const path = safe.containerId
    ? `containers/${encodeURIComponent(safe.containerId)}/files/${encodeURIComponent(safe.fileId)}`
    : `files/${encodeURIComponent(safe.fileId)}`;
  let response: Response;
  try {
    response = await fetch(`https://api.openai.com/v1/${path}/content`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
      redirect: "error",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(
      "Could not download the file. Check your API key, connection, and browser access to OpenAI.",
    );
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 410)
      throw new Error(
        "This file is no longer available. Its container may have expired; regenerate the response to create it again.",
      );
    if (response.status === 401 || response.status === 403)
      throw new Error(
        "This API key cannot access the file. Use the key/project that generated it.",
      );
    throw new Error(`File download failed (${response.status}). Try again.`);
  }
  // Artifacts can contain HTML/SVG/code: download bytes, never execute them.
  return new Blob([await response.blob()], {
    type: "application/octet-stream",
  });
}

const rowFiles = new WeakMap<HTMLElement, readonly GeneratedFile[]>();

function sandboxFilename(href: string): string | null {
  const path = /^sandbox:\/mnt\/data\/([^?#]+)/i.exec(href)?.[1];
  if (!path) return null;
  try {
    const decoded = decodeURIComponent(path);
    const parts = decoded.split("/");
    if (
      decoded.includes("\\") ||
      parts.some((part) => !part || part === "." || part === "..")
    )
      return null;
    return parts.at(-1) ?? null;
  } catch {
    return null;
  }
}

function bindSandboxLinks(
  row: HTMLElement,
  files: readonly GeneratedFile[],
): void {
  const bound = rowFiles.has(row);
  rowFiles.set(row, files);
  if (bound) return;
  const activate = (event: MouseEvent) => {
    const link =
      event.target instanceof Element
        ? event.target.closest<HTMLAnchorElement>("a[href]")
        : null;
    const href = link?.getAttribute("href")?.trim() ?? "";
    if (!/^sandbox:/i.test(href)) return;
    if (event.type === "auxclick" && event.button !== 1) return;
    // Capture before the live markdown viewer stops bubbling. Never let a
    // sandbox path navigate, open a tab, or become an authenticated URL.
    event.preventDefault();
    event.stopPropagation();
    const filename = sandboxFilename(href);
    const matches = (rowFiles.get(row) ?? []).filter(
      (file) => file.filename === filename,
    );
    const content = row.querySelector<HTMLElement>(".message-content");
    content?.querySelector(".generated-link-status")?.remove();
    const match = matches[0];
    if (matches.length === 1 && match) {
      const index = (rowFiles.get(row) ?? []).indexOf(match);
      const button = row.querySelectorAll<HTMLButtonElement>(
        ".generated-file-download",
      )[index];
      if (button) {
        button.click();
        return;
      }
    }
    const status = document.createElement("div");
    status.className = "generated-file-status generated-link-status";
    status.setAttribute("role", "status");
    status.textContent =
      matches.length > 1
        ? "More than one generated file matches this link. Use a Download button below."
        : "No generated file matches this sandbox link yet. Wait for the reply to finish, or ask the assistant to generate the file again.";
    content?.append(status);
  };
  row.addEventListener("click", activate, true);
  row.addEventListener("auxclick", activate, true);
}

/** Keep download controls outside the markdown viewer's owned children. */
export function syncGeneratedFiles(
  row: HTMLElement,
  files: readonly GeneratedFile[],
  getApiKey: () => string,
): void {
  bindSandboxLinks(row, files);
  const content = row.querySelector<HTMLElement>(".message-content");
  if (!content) return;
  let list = content.querySelector<HTMLElement>(".message-generated-files");
  if (files.length === 0) {
    list?.remove();
    return;
  }
  const signature = JSON.stringify(files);
  if (list?.dataset.files !== signature) {
    list?.remove();
    list = document.createElement("div");
    list.className = "message-generated-files";
    list.dataset.files = signature;
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", "Generated files");
    const hint = document.createElement("div");
    hint.className = "generated-files-hint";
    hint.textContent = "Generated files · Download before they expire";
    list.append(hint);
    for (const file of files) {
      const item = document.createElement("div");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "attachment-chip generated-file-download";
      button.textContent = `Download ${file.filename}`;
      const status = document.createElement("div");
      status.className = "generated-file-status";
      status.setAttribute("role", "status");
      button.addEventListener("click", async () => {
        button.disabled = true;
        status.textContent = "Downloading…";
        try {
          const blob = await fetchGeneratedFile(
            file,
            getApiKey(),
            AbortSignal.timeout(60_000),
          );
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = file.filename;
          document.body.append(link);
          link.click();
          link.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
          status.textContent = "Download started.";
        } catch (error) {
          status.textContent =
            error instanceof Error
              ? error.message
              : "Download failed. Try again.";
        } finally {
          button.disabled = false;
        }
      });
      item.append(button, status);
      list.append(item);
    }
  }
  if (content.lastElementChild !== list) content.append(list);
}
