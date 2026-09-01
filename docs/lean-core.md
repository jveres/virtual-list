# lean-core

A from-scratch rewrite of the virtualizer runtime. The old code is a
behavioral reference and a test oracle, never a porting source — rewriting is
the point; porting would preserve the spaghetti. Unused code is deleted on
this branch (git keeps history). A dramatic LOC decrease is an explicit goal,
not a hope.

## Directives (fixed)

1. **Pin-to-top carries over.** The send flow — anchor a message to the
   viewport top, reserving scrollable space below until real content consumes
   it — works very well today and is a first-class contract item, not an
   adapter afterthought.
2. **Clean cut.** No compatibility wrapper, no incremental hollowing of the
   old orchestrator. New runtime lives in `src/lean/` beside the old one
   until the demos migrate; then the old runtime is deleted.
3. **Rewrite, don't port.** The two proven assets — Fenwick-based layout and
   the adaptive browser gesture handling — are preserved as *behavior*:
   re-derived from scratch against a written quirk list and the ported unit
   harnesses (e.g. the integer-floor scrollTop test), not copy-pasted.

## Invariants (the definition of correct)

I1. The visible anchor's viewport coordinate never changes when items are
    prepended, appended, removed, measured, or updated.
I2. While following the end, streaming growth stays pinned with no terminal
    jump — landing is exact on integer-rounding engines (WebKit floors
    scrollTop writes; glides must advance ≥1px/frame).
I3. Edge loading never changes scroll geometry: loaders are overlays;
    `onReachStart/End` are proximity signals only.
I4. One logical data update = one atomic commit (reconcile → measure →
    correct → publish). Host callbacks run after the commit; calls made from
    them are inputs to the next commit. No reentrancy machinery.
I5. Pin-to-top: `scrollTo(key, { align: "start" })` on a tail item reserves
    the shortfall as core-owned geometry. The reserve is consumed by content
    growth and regrown by shrinkage symmetrically; it is never destroyed by
    a transient change and never collapses out from under the viewport
    (the tail-gap lessons, as invariants).
6.  A discrete in-row height change (a toggled disclosure) commits in the
    same painted frame as the change — no one-frame tear.

Performance floor: O(log n) offsets, bounded mounted DOM, no layout reads in
scroll handlers, parity with `main` at 60/120Hz and on the 10k-row
variable-height benchmark.

## API contract (complete surface — additions require architecture review)

```ts
const list = createVirtualList(viewport, {
  items,                       // owned keyed snapshot
  key: (item) => string,
  render: (item, existing?) => HTMLElement,
  estimateSize?: number | ((item) => number),
  onState?, onReachStart?, onReachEnd?,
});

list.setItems(next, { anchor?: "auto" | "viewport" | "end" | "none" });
list.scrollTo(key | "start" | "end", { align?, behavior? });  // align:"start" ⇒ I5 reserve
list.state;                   // read-only snapshot
list.dispose();
```

`anchor: "auto"`: prepend → preserve first visible key; append at end →
stay at end; append elsewhere → preserve viewport; changed row → preserve
anchor; removed anchor → nearest surviving key.

Identity is the key; indexes are derived positions. Heights live in one
internal cache keyed by identity: estimates for unseen keys, learned
measurements after mount, ResizeObserver corrections inside the same commit.
Detached premeasure is an optimization only (it cannot see undecoded
images — proven); correctness comes from anchored in-commit correction.

## Architecture

```
keyed snapshot → size/index model (Fenwick + key↔index)
             → anchor commit (reconcile, measure, correct — once, non-reentrant)
             → DOM renderer (mount/update/position/unmount by key)
gesture sensor (browser-adaptive) gates when commits may apply
```

One scroll arbiter owns every scrollTop write, one policy per frame:
user gesture > explicit command > end-anchor > position-anchor.

## Verification gates

- The session bug gauntlet as scripted scenarios: toggle-collapse at bottom,
  expand/collapse over the reserve, stream-end stillness, scroll-away during
  image then return, rapid edge re-entry, interrupted smooth scroll.
- Real browsers (Chromium/Firefox/WebKit); jsdom cannot see any of this.
- Dev-mode per-frame invariant assertions (I1–I6).
- Recorded scroll traces compared old vs new on identical data.
- API pressure test: the full streaming chat demo without one escape hatch.

## Execution order

1. Strip all unused code from the old runtime on this branch (demos stay
   green — they are the oracle).
2. `src/lean/` step 1: keyed geometry kernel (pure, no DOM) + invariant
   property tests. **Review checkpoint.**
3. Commit pipeline + scroll arbiter + gesture sensor.
4. Chat mode (end-follow, pin-to-top reserve, edge overlays); port the
   streaming demo behind a flag; gauntlet.
5. Remaining demos; delete the old runtime and its tests.
