/**
 * The contract suite of src/ (tests/unit/virtual-list.test.ts) runs against
 * virtual-list-next with its harness default switched from "same-height" to
 * "live" — the one commit rule next keeps. These tests are excluded, each
 * for a stated reason. Everything else in that suite must pass.
 */

/** Pin the old modes' held semantics; they fail on src/ as well once the harness is live. */
const modeSemantics = [
  "a mid-gesture render that returns a replacement swaps it in at the declared height",
  "a mid-gesture render that throws leaves the row unknown, the commit lands, and the next preparation re-renders it",
  "uses the declared height without measuring, and renders a mid-phase change in place at the settle",
  "reports both sides of a mounted same-height promotion",
  "should commit a changed declarative pin with a held snapshot",
  "an explicit anchor replaces the pending policy",
  "an omitted anchor inherits the pending snapshot's explicit policy",
  "freezes a mounted row mid-gesture: the same-key update renders fresh off-scroller and swaps at settle",
  "freezes committed rows outside the window too: a mid-phase remount shows committed content",
  "keeps geometry immutable for changes made outside setItems, committing their height at settle",
  "promotes an equal-height update at once during a phase: swapped into the slot, no geometry change",
  "promotion leaves a pending page load (and its anchor) waiting for settle",
  "rows grown under a pinned landing commit on the pin's stance",
  "a retained row that changed while detached is observed on remount and queued without geometry change",
  "rolls back a failed preparation: built rows destroyed once, held and committed state intact",
];

/** Request a mode or option next removed (one commit rule; idle preparation always on). */
const removedOptions = [
  'scrollingUpdates: "freeze" holds even an equal-height update until settle',
  "should immediately apply an interrupting snapshot while preserving its explicit anchor",
  "a held snapshot with an explicit viewport anchor overrides the pin stance",
  "a settle whose commit starts a follow glide keeps following through the glide",
  "should prepare a held page mid-phase only when enabled (false)",
];

/** Assert the detached measurement root or wrapper release that next replaced. */
const measuredInPlace = [
  "premeasures every fresh row in one detached layout batch",
  "should release off-screen wrappers without losing element-local state",
  "should preserve retained elements and recover after a batched remeasurement fails",
  "should stop before handoff when a protected-key callback aborts",
  "should report teardown failure after a render-time abort without leaking other rows",
];

/**
 * Pin that an in-place item update cancels a staged window job. next keeps
 * staging (the rows stay valid) and asks the updater again at the commit,
 * adopting the staged rows by item identity, so a page lands while a reply
 * streams (next/tests/foundation.test.ts, "lands a page mid-stream").
 */
const stagingThroughUpdates = [
  "should invalidate a cached staged source after an in-place item update",
];

export const knownDifferences = [
  ...modeSemantics,
  ...removedOptions,
  ...measuredInPlace,
  ...stagingThroughUpdates,
];

const literal = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A test-name pattern that skips the known differences. */
export const parityPattern = new RegExp(
  `^(?!.*(?:${knownDifferences.map(literal).join("|")})).*$`,
);
