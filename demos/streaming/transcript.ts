// The chat's Markdown transcript: what the download button writes and what
// the import button reads back. Human-readable first — role markers, day
// headings, tool-call summaries — with an HTML comment per turn carrying
// what Markdown cannot show (the send time, the tool payloads), so a file
// round-trips without loss and still renders cleanly in any viewer.
import type { ChatToolCall } from "../shared/chat-ui.js";
import { type StoredTurn, validateStoredTurns } from "./openai.js";

export interface TranscriptMessage extends StoredTurn {
  status?: string;
}

export interface TranscriptDays<M extends TranscriptMessage> {
  dayOf: (message: M) => number;
  dayLabel: (day: number) => string;
}

const TITLE = "# streaming-chat transcript";
const DAY_TAG = "<!-- day -->";
const TURN_TAG = "<!-- turn ";
const USER_MARKER = "**User**";
const ASSISTANT_MARKER = "**Assistant**";

/** An HTML comment cannot contain `--`: escape it inside the JSON. */
function commentSafe(json: string): string {
  return json.replace(/--/g, "-\\u002d");
}

export function transcriptMarkdown<M extends TranscriptMessage>(
  messages: readonly M[],
  days: TranscriptDays<M>,
): string {
  const lines: string[] = [TITLE, ""];
  let currentDay: number | undefined;
  for (const message of messages) {
    const day = days.dayOf(message);
    if (day !== currentDay) {
      currentDay = day;
      lines.push(DAY_TAG, `## ${days.dayLabel(day)}`, "");
    }
    lines.push(message.role === "user" ? USER_MARKER : ASSISTANT_MARKER);
    const meta: Record<string, unknown> = {};
    if (message.sentAt !== undefined) meta.sentAt = message.sentAt;
    if (message.toolCalls?.length) {
      meta.toolCalls = message.toolCalls.map(
        ({ name, status, durationMs, input, output }) => ({
          name,
          status,
          durationMs,
          input,
          output,
        }),
      );
    }
    if (Object.keys(meta).length > 0) {
      lines.push(`${TURN_TAG}${commentSafe(JSON.stringify(meta))} -->`);
    }
    lines.push("");
    for (const call of message.toolCalls ?? []) {
      lines.push(
        `> Tool call \`${call.name}\` (${call.status}, ${Math.round(call.durationMs)}ms)`,
        "",
      );
    }
    const body = message.markdown.trim();
    if (body) lines.push(body, "");
    else if (message.status && message.status !== "done") {
      lines.push(`_(${message.status})_`, "");
    }
  }
  return lines.join("\n");
}

const TOOL_SUMMARY = /^> Tool call `([^`]+)` \((\w+), (\d+)ms\)$/;
const STATUS_PLACEHOLDER = /^_\((\w+)\)_$/;

interface ParsedTurn {
  role: "user" | "assistant";
  meta: Record<string, unknown> | null;
  summaries: ChatToolCall[];
  body: string[];
}

function nextNonBlank(lines: readonly string[], from: number): string {
  for (let i = from; i < lines.length; i++) {
    if (lines[i]?.trim() !== "") return lines[i] as string;
  }
  return "";
}

function isMarker(line: string): boolean {
  return line === USER_MARKER || line === ASSISTANT_MARKER;
}

/**
 * Parse a transcript back into stored turns. Fenced code is opaque (a
 * marker inside a code block is text); a day heading is skipped when it
 * carries the day tag, or — in a file written before the tags — when a
 * role marker follows it.
 */
export function parseTranscriptMarkdown(text: string): StoredTurn[] {
  const lines = text.split(/\r?\n/);
  const turns: ParsedTurn[] = [];
  let current: ParsedTurn | null = null;
  let inFence = false;
  let skipHeading = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (current && /^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      current.body.push(line);
      continue;
    }
    if (inFence) {
      current?.body.push(line);
      continue;
    }
    if (i === 0 && line === TITLE) continue;
    if (line === DAY_TAG) {
      skipHeading = true;
      continue;
    }
    if (line.startsWith("## ")) {
      const legacyDay = !skipHeading && isMarker(nextNonBlank(lines, i + 1));
      if (skipHeading || legacyDay) {
        skipHeading = false;
        continue;
      }
    }
    if (isMarker(line)) {
      current = {
        role: line === USER_MARKER ? "user" : "assistant",
        meta: null,
        summaries: [],
        body: [],
      };
      turns.push(current);
      continue;
    }
    if (!current) continue;
    // The prelude — before the first body line — holds the turn's comment
    // and the tool-call summaries.
    if (current.body.length === 0) {
      if (line.startsWith(TURN_TAG) && line.endsWith(" -->")) {
        try {
          const parsed: unknown = JSON.parse(
            line.slice(TURN_TAG.length, -" -->".length),
          );
          current.meta =
            typeof parsed === "object" && parsed !== null
              ? (parsed as Record<string, unknown>)
              : {};
        } catch {
          current.meta = {};
        }
        continue;
      }
      const summary = TOOL_SUMMARY.exec(line);
      if (summary) {
        current.summaries.push({
          name: summary[1] as string,
          status: summary[2] === "done" ? "done" : "error",
          durationMs: Number(summary[3]),
          input: "",
          output: "",
        });
        continue;
      }
      if (line.trim() === "") continue;
    }
    current.body.push(line);
  }
  return validateStoredTurns(
    turns.map((turn) => {
      const markdown = turn.body.join("\n").trim();
      return {
        role: turn.role,
        markdown: STATUS_PLACEHOLDER.test(markdown) ? "" : markdown,
        sentAt: turn.meta?.sentAt,
        toolCalls:
          turn.meta?.toolCalls ??
          (turn.summaries.length > 0 ? turn.summaries : undefined),
      };
    }),
  );
}
