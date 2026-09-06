import type { Page } from "../../src/paging";
import type { Edge } from "../../src/virtual-list";
import { conversation } from "../shared/chat-data";
import { at } from "../shared/utils";

export const PAGE_SIZE = 64;
export const RETAIN_MESSAGES = PAGE_SIZE * 3;
export const MESSAGES_PER_DAY = 8;

export interface HistoryMessage {
  kind: "message";
  key: string;
  index: number;
  group: number;
  role: "user" | "assistant";
  markdown: string;
}

export interface HistoryHeader {
  kind: "header";
  key: string;
  group: number;
}

export type HistoryRow = HistoryMessage | HistoryHeader;
export type HistoryPage = Page<HistoryMessage, number>;

/** Project only retained messages, including a header for a partial first day. */
export function projectHistory(
  messages: readonly HistoryMessage[],
  previous: readonly HistoryRow[] = [],
): HistoryRow[] {
  const headers = new Map(
    previous.flatMap((row) =>
      row.kind === "header" ? [[row.group, row] as const] : [],
    ),
  );
  const rows: HistoryRow[] = [];
  let group = -1;
  for (const message of messages) {
    if (message.group !== group) {
      group = message.group;
      rows.push(
        headers.get(group) ?? { kind: "header", key: `day:${group}`, group },
      );
    }
    rows.push(message);
  }
  return rows;
}

/**
 * A simulated indexed history service. Only a requested range is materialized;
 * the 10,000-message archive is a count, not an array or a rendered document.
 * Cursors are exclusive boundaries, so an around-page can continue both ways
 * without fetching the intervening history or depending on old page numbers.
 */
export class HistorySource {
  #total: number;
  readonly #latency: number;

  constructor(total = 10_000, latency = 180) {
    if (!Number.isSafeInteger(total) || total < 1)
      throw new RangeError("history total must be a positive safe integer");
    if (!Number.isFinite(latency) || latency < 0)
      throw new RangeError("history latency must be finite and nonnegative");
    this.#total = total;
    this.#latency = latency;
  }

  get total(): number {
    return this.#total;
  }

  append(count = 100): void {
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      !Number.isSafeInteger(this.#total + count)
    )
      throw new RangeError(
        "append count must be a positive safe integer within the history limit",
      );
    this.#total += count;
  }

  async around(index: number, signal: AbortSignal): Promise<HistoryPage> {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.#total)
      throw new RangeError("history index is outside the archive");
    await this.#wait(signal);
    signal.throwIfAborted();
    // Center the target, keep whole days where possible, and fill the page
    // back from the end instead of returning a tiny last-page fragment.
    const desired =
      Math.floor(Math.max(0, index - PAGE_SIZE / 2) / MESSAGES_PER_DAY) *
      MESSAGES_PER_DAY;
    const first = Math.min(desired, Math.max(0, this.#total - PAGE_SIZE));
    return this.#page(first, Math.min(this.#total, first + PAGE_SIZE));
  }

  async load({
    edge,
    cursor,
    signal,
  }: {
    edge: Edge;
    cursor: number;
    signal: AbortSignal;
  }): Promise<HistoryPage> {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.#total)
      throw new RangeError("history cursor is outside the archive");
    await this.#wait(signal);
    signal.throwIfAborted();
    return edge === "start"
      ? this.#page(Math.max(0, cursor - PAGE_SIZE), cursor)
      : this.#page(cursor, Math.min(this.#total, cursor + PAGE_SIZE));
  }

  #page(first: number, end: number): HistoryPage {
    return {
      items: Array.from(
        { length: end - first },
        (_, offset): HistoryMessage => {
          const index = first + offset;
          return {
            kind: "message",
            key: `message:${index}`,
            index,
            group: Math.floor(index / MESSAGES_PER_DAY),
            ...at(conversation, index % conversation.length),
          };
        },
      ),
      start:
        first > 0 ? { available: true, cursor: first } : { available: false },
      end:
        end < this.#total
          ? { available: true, cursor: end }
          : { available: false },
    };
  }

  async #wait(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#latency === 0) return;
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, this.#latency);
      signal.addEventListener("abort", abort, { once: true });
    });
    signal.throwIfAborted();
  }
}
