import { EMBEDDED_IMAGE_PATTERN as GENERATED_IMAGE_PATTERN } from "../../integrations/index.js";
import type { ChatToolCall } from "../shared/chat-ui.js";
import { mustGet } from "../shared/utils.js";
import {
  attachmentInput,
  type ChatAttachment,
  storedAttachments,
} from "./attachments.js";
import {
  type ImportedTranscript,
  type TranscriptSelection,
  type TranscriptTree,
  validateStoredTranscriptTree,
} from "./branching-transcript.js";
import { CHATGPT_RELAY_HEADERS, initChatGPTSettings } from "./chatgpt.js";
import {
  CREATE_FILE_TOOL,
  createTextFile,
  fileImageContext,
} from "./create-file.js";
import {
  filesFromAnnotations,
  filesFromOutput,
  type GeneratedFile,
  storedGeneratedFiles,
} from "./generated-files.js";

type AIProvider = "simulated" | "openai" | "chatgpt";
type RemoteProvider = Exclude<AIProvider, "simulated">;

interface AIToolSettings {
  webSearch: boolean;
  imageGeneration: boolean;
  codeInterpreter: boolean;
  fileDownload?: boolean;
}

interface AISettings {
  provider: AIProvider;
  apiKey: string;
  model: string;
  chatgptModel: string;
  /** How many transcript turns each request carries as context; 0 = all. */
  contextTurns: number;
  /** Built-in Responses API tools to request; support varies by model. */
  tools: AIToolSettings;
  /** Request reasoning summaries and show them as "thinking" panels. */
  reasoningSummary: boolean;
}

export interface ResponseState {
  provider?: RemoteProvider;
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
  /** A user-stopped assistant response, including one with no text yet. */
  stopped?: true;
  attachments?: ChatAttachment[];
  generatedFiles?: GeneratedFile[];
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
    return turn.responseState.output.map((item) => {
      if (item.type !== "image_generation_call") return item;
      // Image output carries metadata (action, revised_prompt, format, etc.)
      // that the Responses input schema does not accept. Keep the stored
      // output intact, but replay only the image call's input fields.
      const { id, type, status, result } = item;
      return { id, type, status, result };
    });
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
    state?.provider !== "chatgpt" &&
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
export { GENERATED_IMAGE_PATTERN };

const GENERATED_IMAGE_RE = new RegExp(GENERATED_IMAGE_PATTERN, "g");

// Generated images are stripped from the request context: megabytes of
// base64 would go back to the API as text tokens.
export function stripGeneratedImages(markdown: string): string {
  return markdown.replace(GENERATED_IMAGE_RE, "*[generated image]*");
}

function defaultToolSettings(): AIToolSettings {
  // Web search and image generation are broadly supported and make the chat
  // feel real; code interpreter is opt-in (slower turns, container cost).
  return {
    webSearch: true,
    imageGeneration: true,
    codeInterpreter: false,
    fileDownload: true,
  };
}

function defaultSettings(): AISettings {
  return {
    provider: "simulated",
    apiKey: "",
    model: DEFAULT_OPENAI_MODEL,
    chatgptModel: "",
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
    fileDownload:
      typeof value.fileDownload === "boolean"
        ? value.fileDownload
        : defaults.fileDownload,
  };
}

function readStoredSettings(): AISettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSettings();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return defaultSettings();
    return {
      provider:
        parsed.provider === "chatgpt"
          ? "chatgpt"
          : parsed.provider === "openai"
            ? "openai"
            : "simulated",
      chatgptModel:
        typeof parsed.chatgptModel === "string" ? parsed.chatgptModel : "",
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
      ...(typeof entry.markdownOffset === "number" &&
      Number.isSafeInteger(entry.markdownOffset) &&
      entry.markdownOffset >= 0
        ? { markdownOffset: entry.markdownOffset }
        : {}),
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
    const generatedFiles =
      entry.role === "assistant"
        ? storedGeneratedFiles([
            ...storedGeneratedFiles(entry.generatedFiles),
            ...filesFromOutput(responseState?.output),
          ])
        : [];
    const toolCalls = storedToolCalls(entry.toolCalls);
    const stopped = entry.role === "assistant" && entry.stopped === true;
    if (
      typeof entry.markdown !== "string" ||
      (entry.markdown === "" &&
        !stopped &&
        !responseState &&
        generatedFiles.length === 0 &&
        attachments.length === 0 &&
        !toolCalls?.length)
    )
      continue;
    const sentAt =
      typeof entry.sentAt === "number" &&
      Number.isFinite(new Date(entry.sentAt).getTime())
        ? entry.sentAt
        : undefined;
    turns.push({
      role: entry.role,
      markdown: entry.markdown,
      ...(stopped ? { stopped: true as const } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      ...(sentAt !== undefined ? { sentAt } : {}),
      ...(responseState ? { responseState } : {}),
      ...(generatedFiles.length ? { generatedFiles } : {}),
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
    (value.provider === undefined ||
      value.provider === "openai" ||
      value.provider === "chatgpt") &&
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
              "function_call",
              "function_call_output",
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
// A failed write must not make a provider switch restore older persisted data.
// Undefined means this session has not changed the conversation yet.
type RemoteHistory =
  | readonly StoredTurn[]
  | { turns: readonly StoredTurn[]; tree: TranscriptTree };
const sessionHistories = new Map<RemoteProvider, RemoteHistory>();

function validateRemoteHistory(value: unknown): ImportedTranscript {
  if (isRecord(value) && !Array.isArray(value)) {
    return (
      validateStoredTranscriptTree(value.tree) ?? {
        turns: validateStoredTurns(value.turns),
        tree: null,
      }
    );
  }
  return { turns: validateStoredTurns(value), tree: null };
}

function historyProvider(): RemoteProvider {
  return getAISettings().provider === "chatgpt" ? "chatgpt" : "openai";
}

function historyRecord(provider: RemoteProvider): string {
  return provider === "chatgpt" ? "chatgpt-history" : HISTORY_RECORD_KEY;
}

function queueHistoryWrite(
  write: (db: IDBDatabase) => IDBRequest,
  onCommitted?: () => void,
): void {
  historyWriteChain = historyWriteChain.then(async () => {
    try {
      const db = await historyDb();
      await new Promise<void>((resolve, reject) => {
        const request = write(db);
        const transaction = request.transaction;
        if (!transaction) {
          reject(new Error("IndexedDB write has no transaction"));
          return;
        }
        transaction.oncomplete = () => resolve();
        transaction.onabort = transaction.onerror = () =>
          reject(transaction.error ?? new Error("IndexedDB write failed"));
      });
      onCommitted?.();
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
export async function loadOpenAIHistory(
  provider = historyProvider(),
): Promise<StoredTurn[]> {
  return (await loadOpenAIConversation(provider)).turns;
}

export async function loadOpenAIConversation(
  provider = historyProvider(),
): Promise<ImportedTranscript> {
  await historyWriteChain;
  let sessionHistory = sessionHistories.get(provider);
  if (sessionHistory !== undefined)
    return validateRemoteHistory(sessionHistory);
  try {
    const db = await historyDb();
    const stored = await new Promise<unknown>((resolve, reject) => {
      const request = db
        .transaction(HISTORY_STORE, "readonly")
        .objectStore(HISTORY_STORE)
        .get(historyRecord(provider));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("IndexedDB read failed"));
    });
    // A send may have happened while the database read was pending.
    sessionHistory = sessionHistories.get(provider);
    if (sessionHistory !== undefined)
      return validateRemoteHistory(sessionHistory);
    if (stored !== undefined) return validateRemoteHistory(stored);
    const legacy = provider === "openai" ? readLegacyHistory() : [];
    if (legacy.length > 0) {
      queueHistorySave(legacy, provider, removeLegacyHistory);
    }
    return { turns: legacy, tree: null };
  } catch {
    sessionHistory = sessionHistories.get(provider);
    if (sessionHistory !== undefined)
      return validateRemoteHistory(sessionHistory);
    return {
      turns: provider === "openai" ? readLegacyHistory() : [],
      tree: null,
    };
  }
}

// Fire-and-forget by design: persistence runs on send/stream-end hot paths.
// Callers always pass freshly built arrays, so deferring the structured
// clone into the queued write is safe.
export function saveOpenAIHistory(
  turns: readonly StoredTurn[],
  provider = historyProvider(),
  tree?: TranscriptTree,
): void {
  const history = tree ? { turns, tree } : turns;
  sessionHistories.set(provider, history);
  queueHistorySave(history, provider);
}

function queueHistorySave(
  turns: RemoteHistory,
  provider: RemoteProvider,
  onCommitted?: () => void,
): void {
  queueHistoryWrite(
    (db) =>
      db
        .transaction(HISTORY_STORE, "readwrite")
        .objectStore(HISTORY_STORE)
        .put(turns, historyRecord(provider)),
    onCommitted,
  );
}

function clearOpenAIHistory(): void {
  const provider = historyProvider();
  sessionHistories.set(provider, []);
  if (provider === "openai") removeLegacyHistory();
  queueHistoryWrite((db) =>
    db
      .transaction(HISTORY_STORE, "readwrite")
      .objectStore(HISTORY_STORE)
      .delete(historyRecord(provider)),
  );
}

export interface SimulatedHistory {
  markdown: string;
  nextResponse: number;
  changed: boolean;
  /** Untrusted until checked against the parsed transcript tree. */
  selection?: unknown;
}

// A separate record preserves the simulated version tree without touching
// the real-provider history or requiring an IndexedDB schema migration.
const SIMULATED_HISTORY_RECORD_KEY = "simulated-history";
const SIMULATED_SELECTION_RECORD_KEY = "simulated-selection";
let sessionSimulatedHistory: SimulatedHistory | undefined;
let sessionSimulatedRevision: string | undefined;

export async function loadSimulatedHistory(): Promise<SimulatedHistory | null> {
  await historyWriteChain;
  if (sessionSimulatedHistory) return sessionSimulatedHistory;
  try {
    const db = await historyDb();
    const [stored, selection] = await new Promise<[unknown, unknown]>(
      (resolve, reject) => {
        const transaction = db.transaction(HISTORY_STORE, "readonly");
        const store = transaction.objectStore(HISTORY_STORE);
        const historyRequest = store.get(SIMULATED_HISTORY_RECORD_KEY);
        const selectionRequest = store.get(SIMULATED_SELECTION_RECORD_KEY);
        transaction.oncomplete = () =>
          resolve([historyRequest.result, selectionRequest.result]);
        transaction.onabort = transaction.onerror = () =>
          reject(transaction.error);
      },
    );
    if (sessionSimulatedHistory) return sessionSimulatedHistory;
    if (!isRecord(stored) || typeof stored.markdown !== "string") return null;
    const choices =
      isRecord(selection) &&
      typeof stored.revision === "string" &&
      selection.revision === stored.revision
        ? selection
        : null;
    const progress = choices ?? stored;
    sessionSimulatedRevision =
      typeof stored.revision === "string" ? stored.revision : undefined;
    sessionSimulatedHistory = {
      markdown: stored.markdown,
      nextResponse:
        typeof progress.nextResponse === "number" &&
        Number.isSafeInteger(progress.nextResponse) &&
        progress.nextResponse >= 0
          ? progress.nextResponse
          : 0,
      changed: progress.changed === true,
      ...(choices ? { selection: choices.selection } : {}),
    };
    return sessionSimulatedHistory;
  } catch {
    return sessionSimulatedHistory ?? null;
  }
}

export function saveSimulatedHistory(
  history: Omit<SimulatedHistory, "selection">,
): void {
  sessionSimulatedHistory = history;
  // getRandomValues also works when the demo is served over local-network HTTP.
  const revision = Array.from(
    crypto.getRandomValues(new Uint32Array(4)),
    (value) => value.toString(16),
  ).join("-");
  sessionSimulatedRevision = revision;
  queueHistoryWrite((db) => {
    const store = db
      .transaction(HISTORY_STORE, "readwrite")
      .objectStore(HISTORY_STORE);
    store.delete(SIMULATED_SELECTION_RECORD_KEY);
    return store.put({ ...history, revision }, SIMULATED_HISTORY_RECORD_KEY);
  });
}

/** Persist navigation without cloning the unchanged Markdown/attachment bytes. */
export function saveSimulatedSelection(
  selection: TranscriptSelection,
  nextResponse: number,
  changed: boolean,
): boolean {
  const revision = sessionSimulatedRevision;
  if (!sessionSimulatedHistory || !revision) return false;
  const snapshot = {
    selectedRootId: selection.selectedRootId,
    nodes: selection.nodes.map((node) => ({ ...node })),
  };
  sessionSimulatedHistory = {
    ...sessionSimulatedHistory,
    selection: snapshot,
    nextResponse,
    changed,
  };
  queueHistoryWrite((db) =>
    db
      .transaction(HISTORY_STORE, "readwrite")
      .objectStore(HISTORY_STORE)
      .put(
        { revision, selection: snapshot, nextResponse, changed },
        SIMULATED_SELECTION_RECORD_KEY,
      ),
  );
  return true;
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
  | { kind: "files"; files: GeneratedFile[] }
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

  if (parsed.type === "response.output_text.annotation.added") {
    const files = filesFromAnnotations([parsed.annotation]);
    return files.length ? [{ kind: "files", files }] : [];
  }
  if (parsed.type === "response.content_part.done") {
    const files = isRecord(parsed.part)
      ? filesFromAnnotations(parsed.part.annotations)
      : [];
    return files.length ? [{ kind: "files", files }] : [];
  }

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
    if (item.type === "function_call" && item.name === "create_file") {
      return [
        {
          kind: "tool-start",
          id,
          name: "create_file",
          input: "Preparing a downloadable text file…",
        },
      ];
    }
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

    if (item.type === "message") {
      const files = filesFromOutput([item]);
      return files.length ? [{ kind: "files", files }] : [];
    }

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
 * they arrive. API keys go directly to api.openai.com; ChatGPT uses the
 * local OAuth relay with complete caller-owned context. Throws with a readable
 * message on any failure; aborting `signal` ends the stream silently (fetch
 * rejects with an AbortError the caller owns).
 */
async function* streamOpenAIResponse(
  context: ResponseContext,
  {
    apiKey,
    model,
    tools,
    reasoningSummary,
    provider = "openai",
  }: Pick<AISettings, "apiKey" | "model" | "tools" | "reasoningSummary"> & {
    provider?: AIProvider;
  },
  signal: AbortSignal,
): AsyncGenerator<OpenAIStreamChunk, void, undefined> {
  const oauth = provider === "chatgpt";
  if (!oauth && !apiKey) {
    throw new Error(
      "no API key configured — open the AI settings in the header and paste an OpenAI key",
    );
  }

  const toolList = requestTools(tools);
  const fileDownload = oauth && tools.fileDownload !== false;
  if (fileDownload) toolList.push(CREATE_FILE_TOOL);
  const request = (chained: boolean) =>
    fetch(oauth ? "/__chatgpt/responses" : RESPONSES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(oauth
          ? CHATGPT_RELAY_HEADERS
          : { authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({
        model,
        stream: true,
        instructions:
          SYSTEM_PROMPT +
          (fileDownload
            ? "\nWhen asked for a downloadable text file, use create_file instead of pasting its content in the reply. After success, briefly link to the returned download_url. Never claim a file exists before the tool succeeds. create_file does not execute code or generate binary formats."
            : ""),
        store: !oauth,
        include: ["reasoning.encrypted_content"],
        input: chained && !oauth ? context.input : context.fallbackInput,
        ...(chained && !oauth && context.previousResponseId
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
    !oauth &&
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
  const completedItems = new Map<number, Record<string, unknown>>();
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
          event.type === "response.output_item.done" &&
          isRecord(event.item)
        ) {
          const index =
            Number.isInteger(event.output_index) &&
            Number(event.output_index) >= 0
              ? Number(event.output_index)
              : completedItems.size;
          completedItems.set(index, event.item);
        }
        if (
          isRecord(event) &&
          event.type === "response.completed" &&
          isRecord(event.response)
        ) {
          const state = {
            ...(oauth ? { provider: "chatgpt" as const } : {}),
            id: event.response.id,
            model:
              typeof event.response.model === "string"
                ? event.response.model
                : model,
            contextStart: context.contextStart,
            contextTurns: context.contextTurns,
            // Subscription streams can send every item via output_item.done
            // and an empty output array in the terminal response envelope.
            output:
              Array.isArray(event.response.output) &&
              event.response.output.length
                ? event.response.output
                : [...completedItems]
                    .sort(([a], [b]) => a - b)
                    .map(([, item]) => item),
          };
          if (validResponseState(state)) {
            // Streamed items already emitted their file annotations.
            const files = filesFromOutput(event.response.output);
            if (files.length) yield { kind: "files", files };
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

/** Subscription-only local tool loop; API-token requests keep their existing behavior. */
export async function* streamOpenAIChat(
  context: ResponseContext,
  settings: Parameters<typeof streamOpenAIResponse>[1],
  signal: AbortSignal,
): AsyncGenerator<OpenAIStreamChunk, void, undefined> {
  if (
    settings.provider !== "chatgpt" ||
    settings.tools.fileDownload === false
  ) {
    yield* streamOpenAIResponse(context, settings, signal);
    return;
  }
  const imageContext = fileImageContext(context.fallbackInput);
  let current = {
    ...context,
    input: imageContext.input,
    fallbackInput: imageContext.input,
  };
  let output: Record<string, unknown>[] = [];
  const seenCalls = new Set<string>();
  for (let round = 0; round < 4; round++) {
    signal.throwIfAborted();
    let completed: ResponseState | undefined;
    for await (const chunk of streamOpenAIResponse(current, settings, signal)) {
      if (chunk.kind === "response-completed") completed = chunk.state;
      else yield chunk;
    }
    if (!completed) throw new Error("Response ended without completion state.");
    signal.throwIfAborted();
    const calls = completed.output.filter(
      (item) => item.type === "function_call",
    );
    output = output.concat(completed.output);
    const files: GeneratedFile[] = [];
    const feedback: OpenAIStreamChunk[] = [];
    for (const call of calls) {
      if (
        typeof call.call_id !== "string" ||
        !/^[a-zA-Z0-9_-]+$/.test(call.call_id) ||
        seenCalls.has(call.call_id)
      )
        throw new Error("Invalid or repeated function call identifier.");
      seenCalls.add(call.call_id);
      if (seenCalls.size > 8)
        throw new Error("File tool call limit reached (8 per reply).");
      let result: Record<string, unknown>;
      try {
        if (call.name !== "create_file" || typeof call.arguments !== "string")
          throw new Error("Unsupported function call.");
        const file = createTextFile(
          call.arguments,
          `local_${completed.id}_${call.call_id}`,
          imageContext.images,
        );
        files.push(file);
        result = {
          filename: file.filename,
          download_url: `sandbox:/mnt/data/${encodeURIComponent(file.filename)}`,
        };
      } catch (error) {
        result = {
          error:
            error instanceof Error
              ? error.message
              : "Could not create the file.",
        };
      }
      output.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(result),
      });
      feedback.push({
        kind: "tool-end",
        id: toolCallId(call),
        name: typeof call.name === "string" ? call.name : "create_file",
        ok: !("error" in result),
        input:
          typeof result.filename === "string" ? result.filename : "create_file",
        output: JSON.stringify(result),
      });
    }
    // Save the complete call/output pairs before yielding files or starting another request.
    const state = { ...completed, output };
    yield { kind: "response-completed", state };
    yield* feedback;
    if (files.length) yield { kind: "files", files };
    if (!calls.length) return;
    const input = imageContext.input.concat(
      replayTurn({ role: "assistant", markdown: "", responseState: state }),
    );
    current = { ...context, input, fallbackInput: input };
  }
  throw new Error(
    "File tool continuation limit reached. Created files remain available below.",
  );
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
  /** Whether the simulated conversation differs from its built-in history. */
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
  const chatgptModelInput = mustGet("ai-chatgpt-model", HTMLInputElement);
  const chatgptSettings = initChatGPTSettings();
  const contextSelect = mustGet("ai-context", HTMLSelectElement);
  const clearHistoryBtn = mustGet("ai-clear-history", HTMLButtonElement);
  const testKeyBtn = mustGet("ai-test-key", HTMLButtonElement);
  const keyStatus = mustGet("ai-key-status");
  const webSearchInput = mustGet("ai-tool-web-search", HTMLInputElement);
  const imageToolInput = mustGet("ai-tool-image", HTMLInputElement);
  const codeToolInput = mustGet("ai-tool-code", HTMLInputElement);
  const fileToolInput = mustGet("ai-tool-file", HTMLInputElement);
  const reasoningInput = mustGet("ai-reasoning", HTMLInputElement);

  const stored = getAISettings();
  providerSelect.value = stored.provider;
  keyInput.value = stored.apiKey;
  modelInput.value = stored.model;
  chatgptModelInput.value = stored.chatgptModel;
  keyStatus.textContent = keyHint(stored.apiKey);
  webSearchInput.checked = stored.tools.webSearch;
  imageToolInput.checked = stored.tools.imageGeneration;
  codeToolInput.checked = stored.tools.codeInterpreter;
  fileToolInput.checked = stored.tools.fileDownload !== false;
  reasoningInput.checked = stored.reasoningSummary;
  contextSelect.value = String(stored.contextTurns);
  // A stored value the markup doesn't offer leaves the select unselected;
  // snap it back to the default option.
  if (contextSelect.selectedIndex < 0) {
    contextSelect.value = String(DEFAULT_CONTEXT_TURNS);
  }

  const syncToggle = () => {
    // The header icon lights accent while the real provider is active.
    toggle.classList.toggle("active", getAISettings().provider !== "simulated");
  };

  // Under the simulated provider nothing but the provider choice shows —
  // plus, once an edit or import has changed the built-in conversation, the way
  // back to it; every OpenAI-specific input, action, and note belongs to
  // OpenAI.
  const providerFields = panel.querySelectorAll<HTMLElement>("[data-provider]");
  const syncProviderFields = () => {
    for (const field of providerFields) {
      field.hidden =
        !field.dataset.provider?.split(" ").includes(providerSelect.value) ||
        (field.dataset.provider === "simulated" &&
          options.canRestoreConversation?.() !== true);
    }
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
      provider:
        providerSelect.value === "chatgpt"
          ? "chatgpt"
          : providerSelect.value === "openai"
            ? "openai"
            : "simulated",
      chatgptModel: chatgptModelInput.value.trim(),
      // Keys are printable ASCII; pastes routed through rich-text apps can
      // pick up invisible characters (zero-width spaces survive trim) that
      // make a correct-looking key fail auth. Strip everything else.
      apiKey: keyInput.value.replace(/[^\x21-\x7E]/g, ""),
      model: modelInput.value.trim() || DEFAULT_OPENAI_MODEL,
      tools: {
        webSearch: webSearchInput.checked,
        imageGeneration: imageToolInput.checked,
        codeInterpreter: codeToolInput.checked,
        fileDownload: fileToolInput.checked,
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
      chatgptSettings.close();
      options.onProviderChange?.(next.provider);
      if (next.provider === "chatgpt") chatgptSettings.open();
    }
  };

  toggle.addEventListener("click", () => {
    if (panel.open) {
      panel.close();
      return;
    }
    syncProviderFields(); // An import since the last open may show a field.
    panel.showModal();
    if (getAISettings().provider === "chatgpt") chatgptSettings.open();
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
  chatgptModelInput.addEventListener("input", persist);
  contextSelect.addEventListener("change", persist);
  webSearchInput.addEventListener("change", persist);
  imageToolInput.addEventListener("change", persist);
  codeToolInput.addEventListener("change", persist);
  fileToolInput.addEventListener("change", persist);
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
