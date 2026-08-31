import type { ChatToolCall } from "../shared/chat-ui.js";
import { mustGet } from "../shared/utils.js";

export type AIProvider = "simulated" | "openai";

export interface AIToolSettings {
  webSearch: boolean;
  imageGeneration: boolean;
  codeInterpreter: boolean;
}

export interface AISettings {
  provider: AIProvider;
  apiKey: string;
  model: string;
  /** How many transcript turns each request carries as context; 0 = all. */
  contextTurns: number;
  /** Built-in Responses API tools to request; support varies by model. */
  tools: AIToolSettings;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** One persisted turn of the OpenAI conversation. */
export interface StoredTurn {
  role: "user" | "assistant";
  markdown: string;
  toolCalls?: ChatToolCall[];
}

export const DEFAULT_OPENAI_MODEL = "gpt-5-mini";
export const DEFAULT_CONTEXT_TURNS = 12;

const STORAGE_KEY = "virtual-list:ai-settings";
const HISTORY_KEY = "virtual-list:openai-history";
const RESPONSES_URL = "https://api.openai.com/v1/responses";

// Steers replies toward the block structures (tables, code fences, lists) that
// exercise row measurement — the whole reason this demo streams markdown.
const SYSTEM_PROMPT = `You are the assistant inside a virtual-list streaming demo.
Answer in GitHub-flavored markdown and prefer structured output — headings,
lists, tables, and fenced code blocks — whenever they fit the answer.
Use the available tools (web search, image generation, code execution) when
they help answer the question.`;

// A generated image embedded in a message as a base64 data URI. Stripping
// matters twice: request context (megabytes of base64 would be sent back to
// the API as text tokens) and the localStorage quota fallback.
const GENERATED_IMAGE_RE =
  /!\[([^\]]*)\]\(data:image\/[a-z.+-]+;base64,[^)]*\)/g;

export function stripGeneratedImages(markdown: string): string {
  return markdown.replace(GENERATED_IMAGE_RE, "*[generated image]*");
}

function defaultToolSettings(): AIToolSettings {
  // Web search and image generation are broadly supported and make the chat
  // feel real; code interpreter is opt-in (slower turns, container cost).
  return { webSearch: true, imageGeneration: true, codeInterpreter: false };
}

function defaultSettings(): AISettings {
  return {
    provider: "simulated",
    apiKey: "",
    model: DEFAULT_OPENAI_MODEL,
    contextTurns: DEFAULT_CONTEXT_TURNS,
    tools: defaultToolSettings(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function storedToolSettings(value: unknown): AIToolSettings {
  const defaults = defaultToolSettings();
  if (!isRecord(value)) return defaults;
  return {
    webSearch:
      typeof value.webSearch === "boolean"
        ? value.webSearch
        : defaults.webSearch,
    imageGeneration:
      typeof value.imageGeneration === "boolean"
        ? value.imageGeneration
        : defaults.imageGeneration,
    codeInterpreter:
      typeof value.codeInterpreter === "boolean"
        ? value.codeInterpreter
        : defaults.codeInterpreter,
  };
}

function readStoredSettings(): AISettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSettings();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return defaultSettings();
    return {
      provider: parsed.provider === "openai" ? "openai" : "simulated",
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      model:
        typeof parsed.model === "string" && parsed.model !== ""
          ? parsed.model
          : DEFAULT_OPENAI_MODEL,
      contextTurns:
        typeof parsed.contextTurns === "number" &&
        Number.isInteger(parsed.contextTurns) &&
        parsed.contextTurns >= 0
          ? parsed.contextTurns
          : DEFAULT_CONTEXT_TURNS,
      tools: storedToolSettings(parsed.tools),
    };
  } catch {
    return defaultSettings();
  }
}

// In-memory copy so provider switches keep working within a session even when
// storage is unavailable (private windows, blocked site data).
let settings: AISettings | null = null;

export function getAISettings(): AISettings {
  settings ??= readStoredSettings();
  return settings;
}

export function saveAISettings(next: AISettings): void {
  settings = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage may be blocked; the in-memory copy above still applies.
  }
}

// Persisted tool calls, validated back into shape; a live "running" entry is
// never stored (persistence coerces it to "error"), so only settled states
// load.
function storedToolCalls(value: unknown): ChatToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: ChatToolCall[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    if (entry.status !== "done" && entry.status !== "error") continue;
    calls.push({
      name: entry.name,
      status: entry.status,
      durationMs: typeof entry.durationMs === "number" ? entry.durationMs : 0,
      input: typeof entry.input === "string" ? entry.input : "",
      output: typeof entry.output === "string" ? entry.output : "",
    });
  }
  return calls.length > 0 ? calls : undefined;
}

/**
 * The persisted OpenAI conversation — kept separate from the seeded simulated
 * transcript so real chats accumulate across reloads and the demo can exercise
 * genuinely long histories.
 */
export function loadOpenAIHistory(): StoredTurn[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const turns: StoredTurn[] = [];
    for (const entry of parsed) {
      if (!isRecord(entry)) continue;
      if (entry.role !== "user" && entry.role !== "assistant") continue;
      if (typeof entry.markdown !== "string" || entry.markdown === "") continue;
      const toolCalls = storedToolCalls(entry.toolCalls);
      turns.push({
        role: entry.role,
        markdown: entry.markdown,
        ...(toolCalls ? { toolCalls } : {}),
      });
    }
    return turns;
  } catch {
    return [];
  }
}

export function saveOpenAIHistory(turns: readonly StoredTurn[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(turns));
  } catch {
    // Likely quota: generated images are large even as JPEG. Retry with the
    // image payloads stripped so at least the text history survives.
    try {
      const stripped = turns.map((turn) => ({
        ...turn,
        markdown: stripGeneratedImages(turn.markdown),
      }));
      localStorage.setItem(HISTORY_KEY, JSON.stringify(stripped));
    } catch {
      // Storage blocked or still over quota; the in-memory transcript lives on.
    }
  }
}

export function clearOpenAIHistory(): void {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    // Storage blocked; nothing was persisted anyway.
  }
}

async function errorDetail(response: Response): Promise<string> {
  let detail = `${response.status} ${response.statusText}`.trim();
  try {
    const body: unknown = await response.json();
    if (
      isRecord(body) &&
      isRecord(body.error) &&
      typeof body.error.message === "string"
    ) {
      detail = `${detail}: ${body.error.message}`;
    }
  } catch {
    // Non-JSON error body; the status line is enough.
  }
  return detail;
}

export type OpenAIStreamChunk =
  | { kind: "text"; text: string }
  | { kind: "image"; id: string; markdown: string }
  | { kind: "image-partial"; id: string; markdown: string }
  | { kind: "tool-start"; id: string; name: string; input: string }
  | {
      kind: "tool-end";
      id: string;
      name: string;
      ok: boolean;
      input: string;
      output: string;
    };

// The image tool as requested: JPEG for payload size, with progressive
// partial previews so the reply shows the image forming while it generates.
const IMAGE_TOOL_CONFIG = {
  type: "image_generation",
  output_format: "jpeg",
  partial_images: 2,
} as const;

const { type: _imageToolType, ...imageToolParams } = IMAGE_TOOL_CONFIG;
const IMAGE_TOOL_REQUESTED_INPUT = JSON.stringify(imageToolParams);

// The enabled tools as the request's `tools` array.
function requestTools(tools: AIToolSettings): Record<string, unknown>[] {
  const list: Record<string, unknown>[] = [];
  if (tools.webSearch) list.push({ type: "web_search" });
  if (tools.imageGeneration) list.push({ ...IMAGE_TOOL_CONFIG });
  if (tools.codeInterpreter) {
    list.push({ type: "code_interpreter", container: { type: "auto" } });
  }
  return list;
}

// The image call's parameters, as the pretty-printed JSON the tool-call panel
// shows in its input slot.
function imageCallInput(item: Record<string, unknown>): string {
  const fields: Record<string, string> = {};
  for (const key of ["size", "quality", "output_format", "background"]) {
    const value = item[key];
    if (typeof value === "string") fields[key] = value;
  }
  return JSON.stringify(fields, null, 1).replace(/\n\s*/g, " ");
}

function toolCallId(item: Record<string, unknown>): string {
  return typeof item.id === "string" ? item.id : "tool";
}

// The text a finished code_interpreter run printed, if any.
function codeInterpreterLogs(item: Record<string, unknown>): string {
  if (!Array.isArray(item.outputs)) return "";
  const parts: string[] = [];
  for (const output of item.outputs) {
    if (isRecord(output) && typeof output.logs === "string") {
      parts.push(output.logs);
    }
  }
  return parts.join("\n").trim();
}

// One `data:` SSE payload from the Responses API → the chunks it carries.
// Failure events throw so the caller surfaces them like request errors.
function chunksFromEvent(payload: string): OpenAIStreamChunk[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return [];

  if (parsed.type === "response.output_text.delta") {
    return typeof parsed.delta === "string" && parsed.delta !== ""
      ? [{ kind: "text", text: parsed.delta }]
      : [];
  }

  // A tool call announces itself before it has results — surface it as a
  // running panel right away. Added items carry no parameters yet, so a
  // per-tool placeholder stands in until the finished call replaces it.
  if (parsed.type === "response.output_item.added") {
    const item = parsed.item;
    if (!isRecord(item) || typeof item.type !== "string") return [];
    const id = toolCallId(item);
    if (item.type === "image_generation_call") {
      const input = imageCallInput(item);
      return [
        {
          kind: "tool-start",
          id,
          name: "image_generation",
          input: input === "{}" ? IMAGE_TOOL_REQUESTED_INPUT : input,
        },
      ];
    }
    if (item.type === "web_search_call") {
      return [
        {
          kind: "tool-start",
          id,
          name: "web_search",
          input: "(searching the web…)",
        },
      ];
    }
    if (item.type === "code_interpreter_call") {
      return [
        {
          kind: "tool-start",
          id,
          name: "code_interpreter",
          input: "(writing code…)",
        },
      ];
    }
    return [];
  }

  // Progressive preview: a low-res frame of the image mid-generation.
  if (parsed.type === "response.image_generation_call.partial_image") {
    const b64 =
      typeof parsed.partial_image_b64 === "string"
        ? parsed.partial_image_b64
        : "";
    if (b64 === "") return [];
    const format =
      typeof parsed.output_format === "string"
        ? parsed.output_format
        : IMAGE_TOOL_CONFIG.output_format;
    return [
      {
        kind: "image-partial",
        id: typeof parsed.item_id === "string" ? parsed.item_id : "image",
        markdown: `![Generating image…](data:image/${format};base64,${b64})`,
      },
    ];
  }

  // A finished tool-call item settles its panel; the image call also carries
  // the whole generated image as base64.
  if (parsed.type === "response.output_item.done") {
    const item = parsed.item;
    if (!isRecord(item) || typeof item.type !== "string") return [];
    const id = toolCallId(item);
    const ok = item.status !== "failed";

    if (item.type === "image_generation_call") {
      const result = typeof item.result === "string" ? item.result : "";
      const imageOk = ok && result !== "";
      const format =
        typeof item.output_format === "string" ? item.output_format : "png";
      const output = imageOk
        ? typeof item.revised_prompt === "string" && item.revised_prompt !== ""
          ? item.revised_prompt
          : `Generated a ${format} image; it is embedded in the reply below.`
        : "Image generation failed.";
      const chunks: OpenAIStreamChunk[] = [
        {
          kind: "tool-end",
          id,
          name: "image_generation",
          ok: imageOk,
          input: imageCallInput(item),
          output,
        },
      ];
      if (imageOk) {
        chunks.push({
          kind: "image",
          id,
          markdown: `![Generated image](data:image/${format};base64,${result})`,
        });
      }
      return chunks;
    }

    if (item.type === "web_search_call") {
      return [
        {
          kind: "tool-end",
          id,
          name: "web_search",
          ok,
          input: isRecord(item.action) ? JSON.stringify(item.action) : "{}",
          output: ok
            ? "Search completed; results are cited in the reply."
            : "Search failed.",
        },
      ];
    }

    if (item.type === "code_interpreter_call") {
      const logs = codeInterpreterLogs(item);
      return [
        {
          kind: "tool-end",
          id,
          name: "code_interpreter",
          ok,
          input:
            typeof item.code === "string" && item.code !== ""
              ? item.code
              : "{}",
          output: ok
            ? logs || "Completed with no output."
            : "Execution failed.",
        },
      ];
    }

    return [];
  }

  if (parsed.type === "error") {
    throw new Error(
      typeof parsed.message === "string" ? parsed.message : "stream error",
    );
  }
  if (parsed.type === "response.failed") {
    const response = parsed.response;
    throw new Error(
      isRecord(response) &&
        isRecord(response.error) &&
        typeof response.error.message === "string"
        ? response.error.message
        : "response failed",
    );
  }

  return [];
}

/**
 * Streams a reply from the OpenAI Responses API, yielding text deltas and
 * finished generated images as they arrive. The key goes straight from this
 * browser to api.openai.com — there is no backend. Throws with a readable
 * message on any failure; aborting `signal` ends the stream silently (fetch
 * rejects with an AbortError the caller owns).
 */
export async function* streamOpenAIChat(
  turns: readonly ChatTurn[],
  { apiKey, model, tools }: Pick<AISettings, "apiKey" | "model" | "tools">,
  signal: AbortSignal,
): AsyncGenerator<OpenAIStreamChunk, void, undefined> {
  if (!apiKey) {
    throw new Error(
      "no API key configured — open the AI settings in the statusbar and paste an OpenAI key",
    );
  }

  const toolList = requestTools(tools);
  const response = await fetch(RESPONSES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      instructions: SYSTEM_PROMPT,
      input: turns,
      ...(toolList.length > 0 ? { tools: toolList } : {}),
    }),
    signal,
  });

  if (!response.ok) throw new Error(await errorDetail(response));
  if (!response.body) throw new Error("response had no readable body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are newline-delimited; the trailing partial line stays
      // buffered until its terminator arrives in a later chunk.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice("data:".length).trim();
        if (payload === "") continue;
        yield* chunksFromEvent(payload);
      }
    }
  } finally {
    // Also reached when the consumer stops iterating early (user cancel):
    // release the connection instead of letting the body stream run on.
    void reader.cancel().catch(() => {});
  }
}

/**
 * Verifies a key against the API with a lightweight authenticated request.
 * Returns a human-readable verdict — never throws.
 */
export async function testOpenAIKey(apiKey: string): Promise<string> {
  if (!apiKey) return "No key entered.";
  try {
    const response = await fetch("https://api.openai.com/v1/models?limit=1", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (response.ok) return "Key accepted by api.openai.com.";
    return `Key rejected: ${await errorDetail(response)}`;
  } catch {
    // Auth failures are unreadable from the page (OpenAI omits CORS headers
    // on 401s), so an opaque failure here is almost always a rejected key.
    return "Rejected or blocked: a 401 in the browser console means the key is invalid; no status at all means the network blocked the request.";
  }
}

// What the stored key looks like without revealing it: enough to spot a
// stale, truncated, or mangled paste.
function keyHint(apiKey: string): string {
  if (apiKey === "") return "No key stored in this browser.";
  const start = apiKey.slice(0, 7);
  const end = apiKey.length > 11 ? apiKey.slice(-4) : "";
  return `Stored key: ${start}…${end} (${apiKey.length} chars)`;
}

export interface AISettingsPanelOptions {
  /** Fires after the provider setting changed and was persisted. */
  onProviderChange?: (provider: AIProvider) => void;
  /** Fires after the stored OpenAI history was cleared. */
  onClearHistory?: () => void;
}

/** Wires the header's AI settings popover: load, persist, open/close. */
export function initAISettingsPanel(
  options: AISettingsPanelOptions = {},
): void {
  const root = mustGet("ai-settings");
  const toggle = mustGet("ai-settings-btn", HTMLButtonElement);
  const panel = mustGet("ai-settings-panel");
  const providerSelect = mustGet("ai-provider", HTMLSelectElement);
  const keyInput = mustGet("ai-api-key", HTMLInputElement);
  const modelInput = mustGet("ai-model", HTMLInputElement);
  const contextSelect = mustGet("ai-context", HTMLSelectElement);
  const clearHistoryBtn = mustGet("ai-clear-history", HTMLButtonElement);
  const testKeyBtn = mustGet("ai-test-key", HTMLButtonElement);
  const keyStatus = mustGet("ai-key-status");
  const webSearchInput = mustGet("ai-tool-web-search", HTMLInputElement);
  const imageToolInput = mustGet("ai-tool-image", HTMLInputElement);
  const codeToolInput = mustGet("ai-tool-code", HTMLInputElement);

  const stored = getAISettings();
  providerSelect.value = stored.provider;
  keyInput.value = stored.apiKey;
  modelInput.value = stored.model;
  keyStatus.textContent = keyHint(stored.apiKey);
  webSearchInput.checked = stored.tools.webSearch;
  imageToolInput.checked = stored.tools.imageGeneration;
  codeToolInput.checked = stored.tools.codeInterpreter;
  contextSelect.value = String(stored.contextTurns);
  // A stored value the markup doesn't offer leaves the select unselected;
  // snap it back to the default option.
  if (contextSelect.selectedIndex < 0) {
    contextSelect.value = String(DEFAULT_CONTEXT_TURNS);
  }

  const syncToggle = () => {
    const active = getAISettings().provider === "openai";
    toggle.classList.toggle("active", active);
    toggle.textContent = active ? "AI: OpenAI" : "AI: Simulated";
  };

  const persist = () => {
    const previousProvider = getAISettings().provider;
    const contextTurns = Number(contextSelect.value);
    const next: AISettings = {
      provider: providerSelect.value === "openai" ? "openai" : "simulated",
      // Keys are printable ASCII; pastes routed through rich-text apps can
      // pick up invisible characters (zero-width spaces survive trim) that
      // make a correct-looking key fail auth. Strip everything else.
      apiKey: keyInput.value.replace(/[^\x21-\x7E]/g, ""),
      model: modelInput.value.trim() || DEFAULT_OPENAI_MODEL,
      tools: {
        webSearch: webSearchInput.checked,
        imageGeneration: imageToolInput.checked,
        codeInterpreter: codeToolInput.checked,
      },
      contextTurns:
        Number.isInteger(contextTurns) && contextTurns >= 0
          ? contextTurns
          : DEFAULT_CONTEXT_TURNS,
    };
    saveAISettings(next);
    syncToggle();
    keyStatus.textContent = keyHint(next.apiKey);
    if (next.provider !== previousProvider) {
      options.onProviderChange?.(next.provider);
    }
  };

  const setOpen = (open: boolean) => {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  };

  toggle.addEventListener("click", () => setOpen(!!panel.hidden));
  providerSelect.addEventListener("change", persist);
  keyInput.addEventListener("input", persist);
  modelInput.addEventListener("input", persist);
  contextSelect.addEventListener("change", persist);
  webSearchInput.addEventListener("change", persist);
  imageToolInput.addEventListener("change", persist);
  codeToolInput.addEventListener("change", persist);
  clearHistoryBtn.addEventListener("click", () => {
    clearOpenAIHistory();
    options.onClearHistory?.();
  });
  testKeyBtn.addEventListener("click", () => {
    keyStatus.textContent = "Testing…";
    testKeyBtn.disabled = true;
    void testOpenAIKey(getAISettings().apiKey)
      .then((verdict) => {
        keyStatus.textContent = verdict;
      })
      .finally(() => {
        testKeyBtn.disabled = false;
      });
  });

  document.addEventListener("pointerdown", (event) => {
    if (panel.hidden) return;
    if (event.target instanceof Node && root.contains(event.target)) return;
    setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || panel.hidden) return;
    setOpen(false);
    toggle.focus();
  });

  syncToggle();
}
