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

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function nextFence(line: string, open: string | null): string | null {
  const match = FENCE.exec(line);
  const fence = match?.[1];
  if (!fence) return open;
  if (open === null) {
    return fence.startsWith("`") && match?.[2]?.includes("`") ? null : fence;
  }
  return fence[0] === open[0] &&
    fence.length >= open.length &&
    !match?.[2]?.trim()
    ? null
    : open;
}

/** A body cut inside a code block (a reply stopped mid-fence) is closed, so the next turn's marker stays a marker. */
function closeFences(body: string): string {
  let open: string | null = null;
  for (const line of body.split("\n")) {
    open = nextFence(line, open);
  }
  return open === null ? body : `${body}\n${open}`;
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
    if (message.attachments?.length) meta.attachments = message.attachments;
    // A call still running when the file is written is stored as
    // persistence stores it: settled, as an error.
    const toolCalls = message.toolCalls?.map(
      ({ name, status, durationMs, input, output }) => ({
        name,
        status: status === "running" ? "error" : status,
        durationMs,
        input,
        output,
      }),
    );
    if (toolCalls?.length) meta.toolCalls = toolCalls;
    if (Object.keys(meta).length > 0) {
      lines.push(`${TURN_TAG}${commentSafe(JSON.stringify(meta))} -->`);
    }
    lines.push("");
    for (const call of toolCalls ?? []) {
      lines.push(
        `> Tool call \`${call.name.replace(/[\r\n`]/g, " ")}\` (${call.status}, ${Math.round(call.durationMs)}ms)`,
        "",
      );
    }
    const body = closeFences(message.markdown.trim());
    // Length framing makes role markers, comments, and status-like text in a
    // real body opaque, without duplicating large embedded images in metadata.
    if (body)
      lines.push(
        `<!-- body ${body.split("\n").length} -->`,
        body,
        "<!-- /body -->",
        "",
      );
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
  framed: boolean;
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
 * marker inside a code block is text) up to the closing fence of the same
 * kind; the serializer closes every fence it writes. A day heading is
 * skipped when it carries the day tag, or — in a file written before the
 * tags, which has none — when a role marker follows it.
 */
export function parseTranscriptMarkdown(text: string): StoredTurn[] {
  const lines = text.split(/\r?\n/);
  const tagged = lines.includes(DAY_TAG);
  const turns: ParsedTurn[] = [];
  let current: ParsedTurn | null = null;
  let openFence: string | null = null;
  let skipHeading = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const fence: string | null = current ? nextFence(line, openFence) : null;
    if (fence !== openFence) {
      openFence = fence;
      current?.body.push(line);
      continue;
    }
    if (openFence !== null) {
      current?.body.push(line);
      continue;
    }
    if (line === DAY_TAG) {
      skipHeading = true;
      continue;
    }
    if (line.startsWith("## ")) {
      const legacyDay = !tagged && isMarker(nextNonBlank(lines, i + 1));
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
        framed: false,
      };
      turns.push(current);
      continue;
    }
    if (!current) continue;
    // The prelude — before the first body line — holds the turn's comment
    // and the tool-call summaries.
    if (current.body.length === 0) {
      const bodyFrame = /^<!-- body (\d+) -->$/.exec(line);
      if (bodyFrame) {
        const count = Number(bodyFrame[1]);
        if (
          !Number.isSafeInteger(count) ||
          count < 1 ||
          count > lines.length - i - 2 ||
          lines[i + count + 1] !== "<!-- /body -->"
        )
          throw new Error(
            "The transcript body is truncated or has invalid length metadata.",
          );
        current.body = lines.slice(i + 1, i + 1 + count);
        current.framed = true;
        i += count + 1;
        continue;
      }
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
      // The comment's calls carry the payloads; the summaries stand in
      // when a hand-edited comment yields none.
      const fromMeta = validateStoredTurns([
        { role: turn.role, markdown: "-", toolCalls: turn.meta?.toolCalls },
      ])[0]?.toolCalls;
      return {
        role: turn.role,
        markdown:
          !turn.framed && STATUS_PLACEHOLDER.test(markdown) ? "" : markdown,
        sentAt: turn.meta?.sentAt,
        attachments: turn.meta?.attachments,
        toolCalls:
          fromMeta ?? (turn.summaries.length > 0 ? turn.summaries : undefined),
      };
    }),
  );
}
