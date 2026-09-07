import type { ChatToolCall } from "../shared/chat-ui.js";
import { mustGet } from "../shared/utils.js";
import {
  attachmentInput,
  type ChatAttachment,
  storedAttachments,
} from "./attachments.js";

type AIProvider = "simulated" | "openai";

interface AIToolSettings {
  webSearch: boolean;
  imageGeneration: boolean;
  codeInterpreter: boolean;
}

interface AISettings {
  provider: AIProvider;
  apiKey: string;
  model: string;
  /** How many transcript turns each request carries as context; 0 = all. */
  contextTurns: number;
  /** Built-in Responses API tools to request; support varies by model. */
  tools: AIToolSettings;
  /** Request reasoning summaries and show them as "thinking" panels. */
  reasoningSummary: boolean;
}

export interface ResponseState {
  id: string;
  model: string;
  /** Index in the complete active branch, not the virtualized window. */
  contextStart: number;
  contextTurns: number;
  output: Record<string, unknown>[];
}

export interface ResponseContext {
  input: Record<string, unknown>[];
  fallbackInput: Record<string, unknown>[];
  previousResponseId?: string;
  contextStart: number;
  contextTurns: number;
}

/** One persisted turn of the OpenAI conversation. */
export interface StoredTurn {
  attachments?: ChatAttachment[];
  responseState?: ResponseState;
  role: "user" | "assistant";
  markdown: string;
  toolCalls?: ChatToolCall[];
  /** When the turn was sent (epoch ms); absent on turns stored before dates. */
  sentAt?: number;
}

/** Rebuild actual API content, never send base64 as text tokens. */
function replayTurn(turn: StoredTurn): Record<string, unknown>[] {
  if (turn.role === "user" && turn.attachments?.length) {
    return [
      {
        role: "user",
        content: [
          ...(turn.markdown
            ? [{ type: "input_text", text: turn.markdown }]
            : []),
          ...turn.attachments.map(attachmentInput),
        ],
      },
    ];
  }
  if (turn.role === "assistant" && turn.responseState?.output.length) {
    return turn.responseState.output;
  }
  const items: Record<string, unknown>[] = [
    { role: turn.role, content: stripGeneratedImages(turn.markdown) },
  ];
  const images = [
    ...turn.markdown.matchAll(new RegExp(GENERATED_IMAGE_PATTERN, "g")),
  ];
  for (const image of images) {
    const url = image[0].slice(image[0].indexOf("(data:") + 1, -1);
    items.push({
      role: "user",
      content: [
        {
          type: "input_text",
          text: "Image from the preceding conversation turn:",
        },
        { type: "input_image", image_url: url, detail: "auto" },
      ],
    });
  }
  return items;
}

export function buildResponseContext(
  transcript: readonly StoredTurn[],
  contextTurns: number,
  model: string,
): ResponseContext {
  const turns = transcript.filter(
    (turn) =>
      turn.markdown !== "" || turn.responseState || turn.attachments?.length,
  );
  const contextStart =
    contextTurns > 0 ? Math.max(0, turns.length - contextTurns) : 0;
  const selected = turns.slice(contextStart);
  const fallbackInput = selected.flatMap(replayTurn);
  const parent = turns.at(-2);
  const state = parent?.role === "assistant" ? parent.responseState : undefined;
  // A moving last-N window must not silently inherit the chain's older turns.
  // The immediate parent also keeps edits, retries, and branches independent.
  const canChain =
    turns.at(-1)?.role === "user" &&
    selected.length >= 2 &&
    state?.model === model &&
    state.contextStart === contextStart &&
    state.contextTurns === contextTurns;
  return {
    input: canChain ? selected.slice(-1).flatMap(replayTurn) : fallbackInput,
    fallbackInput,
    ...(canChain ? { previousResponseId: state.id } : {}),
    contextStart,
    contextTurns,
  };
}

const DEFAULT_OPENAI_MODEL = "gpt-5-mini";
const DEFAULT_CONTEXT_TURNS = 12;

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

/** The Markdown shape of an embedded generated image (one source for every regex over it). */
export const GENERATED_IMAGE_PATTERN =
  "!\\[[^\\]]*\\]\\(data:image\\/[a-z.+-]+;base64,[^)]*\\)";
const GENERATED_IMAGE_RE = new RegExp(GENERATED_IMAGE_PATTERN, "g");

// Generated images are stripped from the request context: megabytes of
// base64 would go back to the API as text tokens.
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
    reasoningSummary: true,
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
      reasoningSummary:
        typeof parsed.reasoningSummary === "boolean"
          ? parsed.reasoningSummary
          : true,
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

function saveAISettings(next: AISettings): void {
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

// Any stored value → validated turns; shared by the IndexedDB record (a
// structured-clone array), the legacy localStorage JSON, and an imported
// transcript.
export function validateStoredTurns(value: unknown): StoredTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: StoredTurn[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (entry.role !== "user" && entry.role !== "assistant") continue;
    const attachments =
      entry.role === "user" ? storedAttachments(entry.attachments) : [];
    const responseState =
      entry.role === "assistant" && validResponseState(entry.responseState)
        ? entry.responseState
        : undefined;
    if (
      typeof entry.markdown !== "string" ||
      (entry.markdown === "" && !responseState && attachments.length === 0)
    )
      continue;
    const toolCalls = storedToolCalls(entry.toolCalls);
    const sentAt =
      typeof entry.sentAt === "number" && Number.isFinite(entry.sentAt)
        ? entry.sentAt
        : undefined;
    turns.push({
      role: entry.role,
      markdown: entry.markdown,
      ...(attachments.length ? { attachments } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      ...(sentAt !== undefined ? { sentAt } : {}),
      ...(responseState ? { responseState } : {}),
    });
  }
  return turns;
}

function validResponseState(value: unknown): value is ResponseState {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.startsWith("resp_") &&
    typeof value.model === "string" &&
    Number.isInteger(value.contextStart) &&
    Number(value.contextStart) >= 0 &&
    Number.isInteger(value.contextTurns) &&
    Number(value.contextTurns) >= 0 &&
    Array.isArray(value.output) &&
    value.output.every(
      (item) =>
        isRecord(item) &&
        typeof item.type === "string" &&
        (item.type === "message"
          ? item.role === "assistant" && Array.isArray(item.content)
          : [
              "reasoning",
              "image_generation_call",
              "web_search_call",
              "code_interpreter_call",
            ].includes(item.type)),
    )
  );
}

// The pre-IndexedDB store; still read as a migration source and as the
// fallback when IndexedDB is unavailable (some private windows).
function readLegacyHistory(): StoredTurn[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    return validateStoredTurns(JSON.parse(raw));
  } catch {
    return [];
  }
}

function removeLegacyHistory(): void {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    // Storage blocked; nothing to remove anyway.
  }
}

const HISTORY_DB = "virtual-list-demo";
const HISTORY_STORE = "openai-history";
const HISTORY_RECORD_KEY = "history";

let historyDbPromise: Promise<IDBDatabase> | null = null;

function historyDb(): Promise<IDBDatabase> {
  historyDbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(HISTORY_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(HISTORY_STORE)) {
        request.result.createObjectStore(HISTORY_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB open failed"));
  });
  return historyDbPromise;
}

// Writes run strictly in call order; loads wait for pending writes so a
// provider switch right after a send reads the just-persisted turns.
let historyWriteChain: Promise<void> = Promise.resolve();

function queueHistoryWrite(write: (db: IDBDatabase) => IDBRequest): void {
  historyWriteChain = historyWriteChain.then(async () => {
    try {
      const db = await historyDb();
      await new Promise<void>((resolve, reject) => {
        const request = write(db);
        request.onsuccess = () => resolve();
        request.onerror = () =>
          reject(request.error ?? new Error("IndexedDB write failed"));
      });
    } catch {
      // Storage unavailable; the in-memory transcript lives on.
    }
  });
}

/**
 * The persisted OpenAI conversation — kept separate from the seeded simulated
 * transcript so real chats accumulate across reloads and the demo can
 * exercise genuinely long histories. Stored in IndexedDB (localStorage's
 * ~5MB quota silently ate generated images); an existing localStorage
 * history migrates on first load.
 */
export async function loadOpenAIHistory(): Promise<StoredTurn[]> {
  await historyWriteChain;
  try {
    const db = await historyDb();
    const stored = await new Promise<unknown>((resolve, reject) => {
      const request = db
        .transaction(HISTORY_STORE, "readonly")
        .objectStore(HISTORY_STORE)
        .get(HISTORY_RECORD_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("IndexedDB read failed"));
    });
    if (stored !== undefined) return validateStoredTurns(stored);
    const legacy = readLegacyHistory();
    if (legacy.length > 0) {
      saveOpenAIHistory(legacy);
      removeLegacyHistory();
    }
    return legacy;
  } catch {
    return readLegacyHistory();
  }
}

// Fire-and-forget by design: persistence runs on send/stream-end hot paths.
// Callers always pass freshly built arrays, so deferring the structured
// clone into the queued write is safe.
export function saveOpenAIHistory(turns: readonly StoredTurn[]): void {
  queueHistoryWrite((db) =>
    db
      .transaction(HISTORY_STORE, "readwrite")
      .objectStore(HISTORY_STORE)
      .put(turns, HISTORY_RECORD_KEY),
  );
}

function clearOpenAIHistory(): void {
  removeLegacyHistory();
  queueHistoryWrite((db) =>
    db
      .transaction(HISTORY_STORE, "readwrite")
      .objectStore(HISTORY_STORE)
      .delete(HISTORY_RECORD_KEY),
  );
}

/**
 * The message and code of an API error object, wherever the event put
 * them: `{message, code}` at the top level, or nested under `error`.
 */
export function apiErrorDetail(value: unknown, fallback: string): string {
  const source = isRecord(value) && isRecord(value.error) ? value.error : value;
  if (!isRecord(source)) return fallback;
  const message =
    typeof source.message === "string" && source.message !== ""
      ? source.message
      : fallback;
  const code = typeof source.code === "string" ? source.code : null;
  return code ? `${message} (${code})` : message;
}

async function errorDetail(response: Response): Promise<string> {
  let detail = `${response.status} ${response.statusText}`.trim();
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && isRecord(body.error)) {
      detail = `${detail}: ${apiErrorDetail(body, "request failed")}`;
    }
  } catch {
    // Non-JSON error body; the status line is enough.
  }
  return detail;
}

type OpenAIStreamChunk =
  | { kind: "response-completed"; state: ResponseState }
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

// A finished reasoning item's streamed summary parts, joined.
function reasoningSummaryText(item: Record<string, unknown>): string {
  if (!Array.isArray(item.summary)) return "";
  const parts: string[] = [];
  for (const part of item.summary) {
    if (isRecord(part) && typeof part.text === "string" && part.text !== "") {
      parts.push(part.text);
    }
  }
  return parts.join("\n\n").trim();
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
function chunksFromEvent(parsed: unknown): OpenAIStreamChunk[] {
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
    // Reasoning items share the tool-call lifecycle, so the model's thinking
    // phases surface as panels too: running while it reasons, settled with
    // the streamed summary when the phase completes.
    if (item.type === "reasoning") {
      return [
        { kind: "tool-start", id, name: "thinking", input: "(reasoning…)" },
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

    if (item.type === "reasoning") {
      const summary = reasoningSummaryText(item);
      return [
        {
          kind: "tool-end",
          id,
          name: "thinking",
          ok,
          input: "(internal reasoning; summary below)",
          output:
            summary ||
            "No summary provided — the model reasoned without emitting one.",
        },
      ];
    }

    return [];
  }

  // The API reports a failure two ways, and its message sits at the top
  // level or under `error` depending on the event: an `error` event
  // (an exhausted balance arrives here as insufficient_quota, mid-stream),
  // or a `response.failed` event carrying the failed response.
  if (parsed.type === "error") {
    throw new Error(apiErrorDetail(parsed, "stream error"));
  }
  if (parsed.type === "response.failed") {
    throw new Error(apiErrorDetail(parsed.response, "response failed"));
  }
  if (parsed.type === "response.incomplete") {
    throw new Error(
      "Response incomplete; its partial output was not saved as a chain anchor.",
    );
  }

  return [];
}

/**
 * Streams a reply from the OpenAI Responses API, yielding text deltas,
 * tool-call starts and ends, and partial and finished generated images as
 * they arrive. The key goes straight from this
 * browser to api.openai.com — there is no backend. Throws with a readable
 * message on any failure; aborting `signal` ends the stream silently (fetch
 * rejects with an AbortError the caller owns).
 */
export async function* streamOpenAIChat(
  context: ResponseContext,
  {
    apiKey,
    model,
    tools,
    reasoningSummary,
  }: Pick<AISettings, "apiKey" | "model" | "tools" | "reasoningSummary">,
  signal: AbortSignal,
): AsyncGenerator<OpenAIStreamChunk, void, undefined> {
  if (!apiKey) {
    throw new Error(
      "no API key configured — open the AI settings in the header and paste an OpenAI key",
    );
  }

  const toolList = requestTools(tools);
  const request = (chained: boolean) =>
    fetch(RESPONSES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        stream: true,
        instructions: SYSTEM_PROMPT,
        store: true,
        include: ["reasoning.encrypted_content"],
        input: chained ? context.input : context.fallbackInput,
        ...(chained && context.previousResponseId
          ? { previous_response_id: context.previousResponseId }
          : {}),
        ...(toolList.length > 0 ? { tools: toolList } : {}),
        // Reasoning models stream a summary of their thinking; raw chain of
        // thought is never exposed. Support varies by model, hence the toggle.
        ...(reasoningSummary ? { reasoning: { summary: "auto" } } : {}),
      }),
      signal,
    });

  let response = await request(true);
  if (
    !response.ok &&
    context.previousResponseId &&
    (response.status === 400 || response.status === 404)
  ) {
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    const error =
      isRecord(body) && isRecord(body.error) ? body.error : undefined;
    if (
      error?.code === "previous_response_not_found" ||
      (error?.param === "previous_response_id" &&
        error.code === "resource_not_found")
    ) {
      response = await request(false);
    }
  }

  if (!response.ok) throw new Error(await errorDetail(response));
  if (!response.body) throw new Error("response had no readable body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error("Response stream ended before completion.");
      }
      buffer += decoder.decode(value, { stream: true });
      // SSE events are newline-delimited; the trailing partial line stays
      // buffered until its terminator arrives in a later chunk.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice("data:".length).trim();
        if (payload === "") continue;
        let event: unknown;
        try {
          event = JSON.parse(payload);
        } catch {
          event = null;
        }
        if (
          isRecord(event) &&
          event.type === "response.completed" &&
          isRecord(event.response)
        ) {
          const state = {
            id: event.response.id,
            model,
            contextStart: context.contextStart,
            contextTurns: context.contextTurns,
            output: event.response.output,
          };
          if (validResponseState(state)) {
            yield { kind: "response-completed", state };
            return;
          }
        }
        yield* chunksFromEvent(event);
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
async function testOpenAIKey(apiKey: string): Promise<string> {
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

interface AISettingsPanelOptions {
  /** Fires after the provider setting changed and was persisted. */
  onProviderChange?: (provider: AIProvider) => void;
  /** Fires after the stored OpenAI history was cleared. */
  onClearHistory?: () => void;
  /** Whether an import has replaced the simulated conversation. */
  canRestoreConversation?: () => boolean;
  /** Fires when the user asks for the built-in conversation back. */
  onRestoreConversation?: () => void;
}

/** Wires the header's AI settings dialog: load, persist, open/close. */
export function initAISettingsPanel(
  options: AISettingsPanelOptions = {},
): void {
  const toggle = mustGet("ai-settings-btn", HTMLButtonElement);
  const panel = mustGet("ai-settings-panel", HTMLDialogElement);
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
  const reasoningInput = mustGet("ai-reasoning", HTMLInputElement);

  const stored = getAISettings();
  providerSelect.value = stored.provider;
  keyInput.value = stored.apiKey;
  modelInput.value = stored.model;
  keyStatus.textContent = keyHint(stored.apiKey);
  webSearchInput.checked = stored.tools.webSearch;
  imageToolInput.checked = stored.tools.imageGeneration;
  codeToolInput.checked = stored.tools.codeInterpreter;
  reasoningInput.checked = stored.reasoningSummary;
  contextSelect.value = String(stored.contextTurns);
  // A stored value the markup doesn't offer leaves the select unselected;
  // snap it back to the default option.
  if (contextSelect.selectedIndex < 0) {
    contextSelect.value = String(DEFAULT_CONTEXT_TURNS);
  }

  const syncToggle = () => {
    // The header icon lights accent while the real provider is active.
    toggle.classList.toggle("active", getAISettings().provider === "openai");
  };

  // Under the simulated provider nothing but the provider choice shows —
  // plus, once an import has replaced the built-in conversation, the way
  // back to it; every OpenAI-specific input, action, and note belongs to
  // OpenAI.
  const openAIFields = panel.querySelectorAll<HTMLElement>(
    '[data-provider="openai"]',
  );
  const simulatedFields = panel.querySelectorAll<HTMLElement>(
    '[data-provider="simulated"]',
  );
  const syncProviderFields = () => {
    const openAI = providerSelect.value === "openai";
    for (const field of openAIFields) field.hidden = !openAI;
    const restorable = !openAI && options.canRestoreConversation?.() === true;
    for (const field of simulatedFields) field.hidden = !restorable;
  };
  syncProviderFields();
  mustGet("ai-restore-conversation", HTMLButtonElement).addEventListener(
    "click",
    () => {
      options.onRestoreConversation?.();
      syncProviderFields();
    },
  );

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
      reasoningSummary: reasoningInput.checked,
      contextTurns:
        Number.isInteger(contextTurns) && contextTurns >= 0
          ? contextTurns
          : DEFAULT_CONTEXT_TURNS,
    };
    saveAISettings(next);
    syncToggle();
    syncProviderFields();
    keyStatus.textContent = keyHint(next.apiKey);
    if (next.provider !== previousProvider) {
      options.onProviderChange?.(next.provider);
    }
  };

  toggle.addEventListener("click", () => {
    if (panel.open) {
      panel.close();
      return;
    }
    syncProviderFields(); // An import since the last open may show a field.
    panel.showModal();
    // Move initial focus to the dialog surface so opening doesn't
    // focus-activate the first select control.
    panel.focus();
  });
  // Light dismiss: a click on the backdrop (the dialog element itself, never
  // its content) closes; Escape is native dialog behavior.
  panel.addEventListener("click", (event) => {
    if (event.target === panel) panel.close();
  });
  providerSelect.addEventListener("change", persist);
  keyInput.addEventListener("input", persist);
  modelInput.addEventListener("input", persist);
  contextSelect.addEventListener("change", persist);
  webSearchInput.addEventListener("change", persist);
  imageToolInput.addEventListener("change", persist);
  codeToolInput.addEventListener("change", persist);
  reasoningInput.addEventListener("change", persist);
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

  syncToggle();
}
