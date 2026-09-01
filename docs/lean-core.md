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
2. **Clean cut.** No compatibility wrapper, no porting scaffold. The old
   runtime, its tests, and every demo except streaming chat were deleted in
   this branch's first commit; `main` is the behavioral baseline for
   comparison. The streaming demo stays in-tree as the acceptance target
   (excluded from typecheck until the lean runtime can host it).
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
I6. A discrete in-row height change (a toggled disclosure) commits in the
    same painted frame as the change — no one-frame tear.

Performance floor: O(log n) offsets, bounded mounted DOM, no layout reads in
scroll handlers, parity with `main` at 60/120Hz and on the 10k-row
variable-height benchmark.

Performance checklist (non-blocking, revisit at the benchmark gate):
- `Geometry.window` scans forward from `start` (O(k log n)); replace with a
  direct `indexAt(bottom)` lookup.

## API contract (complete surface — additions require architecture review)

```ts
const list = createVirtualList(viewport, {
  items,                       // owned keyed snapshot
  key: (item) => string,       // unique per item — duplicates are rejected
  render: (item, existing?) => HTMLElement,
  estimateSize?: number | ((item) => number),   // finite and > 0 — enforced
  onState?, onReachStart?, onReachEnd?,
});

list.setItems(next, { anchor?: "auto" | "viewport" | "end" | "none" });
list.scrollTo(key | "start" | "end", { align?, behavior? });  // align:"start" ⇒ I5 reserve
list.state;                   // read-only snapshot
list.dispose();
```

Internally, one logical update is one geometry transaction (I4): anchor
intent is captured on the old geometry (`capture`), mutations apply
(`setKeys`/`measure`/`pin`), and `resolve` returns one absolute scroll
target computed against the final geometry — so end-follow always reaches
the measured end, never an estimated one (I2).

`anchor: "auto"` follows the end only for end-compatible updates while at
the end — the old keys are an unchanged prefix of the new (pure appends, or
the identical list carrying streaming measurements). Prepends, reorders,
and replacements preserve the viewport even at the end. A removed anchor
falls to its first surviving successor, inheriting the in-row offset
(replacement, not backwards navigation); with no successor, the predecessor
end-aligned.

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
An explicit command issued while a gesture is active is deferred (latest
wins) and executes at settle, where it outranks the anchor policies; it is
never dropped and never fights the user's finger.

End-follow is explicit runtime state, not a per-commit re-derivation:
engaged when a commit lands at the end, disengaged when the user scrolls
upward, re-engaged when they return to the end. A gesture may refuse an
end-resolved commit's write, but the intent survives and the settle flush
lands on the (new) end exactly (I2).

`onReachStart/End` fire on entering an 800px proximity zone and re-arm only
after leaving a wider 1200px exit zone — boundary oscillation inside the
hysteresis band cannot refire them (I3).

## Verification gates

- The session bug gauntlet as scripted scenarios: toggle-collapse at bottom,
  expand/collapse over the reserve, stream-end stillness, scroll-away during
  image then return, rapid edge re-entry, interrupted smooth scroll.
- Real browsers (Chromium/Firefox/WebKit); jsdom cannot see any of this.
- Dev-mode per-frame invariant assertions (I1–I6).
- Recorded scroll traces compared old vs new on identical data.
- API pressure test: the full streaming chat demo without one escape hatch.

## Execution order

1. Clean slate: delete the old runtime, its tests, and every demo except
   streaming chat. Done in this branch's first commit; `main` is the
   comparison baseline.
2. Step 1: keyed geometry kernel (`src/geometry.ts`, pure, no DOM) +
   invariant property tests. **Review checkpoint.**
3. Commit pipeline + scroll arbiter + gesture sensor.
4. Chat mode (end-follow, pin-to-top reserve, edge overlays); host the
   streaming demo on the lean runtime; gauntlet against `main`.
5. Re-introduce further demos only as lean-core features earn them.
