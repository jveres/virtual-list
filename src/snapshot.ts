import type { AnchorPolicy, ExplicitAnchor } from "./geometry";
import type { Edge } from "./reach";

export type AnchorRequest = AnchorPolicy | ExplicitAnchor;
export type DeclaredItem<T> = { item: T; height: number };

/** Snapshot bookkeeping is independent of DOM rows and browser timing. */
export interface PreparedSnapshot<T, R> {
  keys: readonly string[];
  newRows: Map<string, R>;
  anchor: AnchorPolicy;
  target: ExplicitAnchor | null;
  deferred: Map<string, T>;
  declaredItems: Map<string, DeclaredItem<T>> | null;
  partial: boolean;
}

const SLOT_KEY_PREFIX = "\u0000edge:";
export function slotKey(edge: Edge, key: string): string {
  return `${SLOT_KEY_PREFIX}${edge}:${key}`;
}
export function isSlotKey(key: string): boolean {
  return key.startsWith(SLOT_KEY_PREFIX);
}

/** Validate and index input before any row is rendered. */
export function indexItems<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  height: ((item: T) => number) | null,
): {
  itemKeys: string[];
  itemByKey: Map<string, T>;
  declaredItems: Map<string, DeclaredItem<T>> | null;
} {
  const itemKeys = items.map(keyOf);
  const itemByKey = new Map<string, T>();
  const declaredItems = height ? new Map<string, DeclaredItem<T>>() : null;
  for (let index = 0; index < items.length; index++) {
    const key = itemKeys[index] as string;
    if (isSlotKey(key))
      throw new Error(`item key "${key}" uses the reserved edge-slot prefix`);
    if (itemByKey.has(key)) throw new Error(`duplicate key "${key}"`);
    const item = items[index] as T;
    itemByKey.set(key, item);
    if (height) declaredItems?.set(key, { item, height: height(item) });
  }
  return { itemKeys, itemByKey, declaredItems };
}

/** Omitted anchors inherit held intent; explicit policies replace it. */
export function createPrepared<T, R>(
  keys: readonly string[],
  requested: AnchorRequest | undefined,
  previous: PreparedSnapshot<T, R> | null = null,
  partial = false,
): PreparedSnapshot<T, R> {
  const named = typeof requested === "object" ? requested : null;
  return {
    keys,
    anchor:
      typeof requested === "string"
        ? requested
        : named !== null
          ? "viewport"
          : (previous?.anchor ?? "auto"),
    target:
      named ?? (requested === undefined ? (previous?.target ?? null) : null),
    newRows: new Map(),
    deferred: new Map(),
    declaredItems: null,
    partial,
  };
}

/** Identify teardown work without changing either snapshot's ownership. */
export function supersededRows<R>(
  previous: ReadonlyMap<string, R>,
  adopted: ReadonlySet<string>,
  touchedKeys?: Iterable<string>,
): R[] {
  const superseded: R[] = [];
  for (const key of touchedKeys ?? previous.keys()) {
    if (adopted.has(key)) continue;
    const row = previous.get(key);
    if (row !== undefined) superseded.push(row);
  }
  return superseded;
}

/**
 * Transfer a successful patch into the held snapshot. Call only after
 * rendering, measurement, rollback-sensitive work, and disposal checks.
 * Untouched maps and the pending order are reused, not cloned.
 */
export function mergePrepared<T, R>(
  previous: PreparedSnapshot<T, R> | null,
  prepared: PreparedSnapshot<T, R>,
  touchedKeys: Iterable<string>,
): PreparedSnapshot<T, R> {
  if (!previous || !prepared.partial) return prepared;
  for (const key of touchedKeys) {
    previous.newRows.delete(key);
    previous.deferred.delete(key);
  }
  for (const [key, row] of prepared.newRows) previous.newRows.set(key, row);
  for (const [key, item] of prepared.deferred) previous.deferred.set(key, item);
  for (const [key, entry] of prepared.declaredItems ?? [])
    previous.declaredItems?.set(key, entry);
  return { ...previous, anchor: prepared.anchor, target: prepared.target };
}
