# lean-core-v2

The second from-scratch attempt. v1 (branch `lean-core`, kept for
reference) proved the small API and the keyed geometry kernel, but its DOM
runtime tried to compensate *after* mutations — estimates, ResizeObserver
corrections, gesture translations, exceptions for "safe" updates — and
thereby re-entered the browser-specific failure space `main` had already
solved. v2 is built on the two cornerstones v1 missed, ported from `main`
as preserved primitives, with the smaller API built around them.

## The two cornerstones

1. **Cross-browser scrollend detection** — the scroll-settle controller:
   per-engine heuristics (Chromium wheel-idle windows and single-scrollend
   sequences, Firefox edge stability windows against APZ ghost ends, Safari
   rubber-band tails, a scrollend+cooldown default) that tell PRECISELY when
   structural changes to the scroller are possible. Ported verbatim from
   `main` (`src/scroll-settle.ts`); its behavior is empirically verified and
   is not re-derived.
2. **Chunk premeasurement** — items are built and measured OFF-scroller
   (a detached, width-synced measurement root) before they ever enter the
   scroll surface, so no DOM mutation of the scroller happens during
   scrolling and heights are real, not estimated, at commit time. Ported
   from `main`'s detached item measurer.

## The core contract (normative)

1. During an active native scroll, the scroll surface's **geometry is
   immutable**: key order, measured extents, offsets, canvas size, and the
   scroll range do not change. Window reconciliation — mounting and
   unmounting already-known, premeasured rows at their fixed positions —
   continues freely throughout the scroll; without it a long momentum
   scroll would run into blank gaps. Positioning within fixed geometry is
   not a structural change.
2. New chunks may be fetched, rendered, and measured **off-scroller**.
3. Only after the proven cross-browser settle signal may the runtime
   **atomically commit**, in one frame:
   - keys,
   - pre-measured heights,
   - canvas geometry,
   - the mounted window,
   - one anchor-preserving scroll position.
4. Same-key, size-changing updates — streaming text, disclosure toggles,
   image decode, font swaps — are geometry changes and follow the same
   rule: premeasured off-scroller and settle-gated, or rendered into
   **dimensionally stable placeholders** (a fixed-extent row box the
   content fills without changing the box) until they can commit. No
   exception path re-admits mid-scroll geometry drift; while the surface
   is idle, such updates commit immediately (premeasured, same pipeline).

Corollaries: no ResizeObserver-driven mid-gesture geometry correction, no
gesture-time canvas translation, no "safe update" exceptions. What v1
handled with compensation machinery simply cannot occur: heights are known
before mount, and geometry changes only at settle.

Known engine bound (accepted, from `main`): wheel/trackpad engines do not
expose fingers-down state, so a motionless hold — no wheel deltas, no
scroll motion — is indistinguishable from a release. Firefox/Chromium
settle (and commit) after their quiet windows even under resting fingers;
at a loadable edge Firefox's stability window bounds this. A settle during
actual motion is a defect; a settle during a long motionless hold is the
documented limit of the platform.

## Preserved from v1 (signed off there, carried forward)

- `src/fenwick.ts` + `src/geometry.ts`: the pure keyed geometry kernel
  (capture → mutate → resolve transactions, anchor policies, pin-to-top
  reserve I5) with its oracle/property tests. Its role narrows: heights fed
  to it are premeasured, not estimated-then-corrected.
- `src/glide.ts`: the programmatic glide (exact landing, ≥1px/frame on
  floored engines, endpoint rebase).
- The v1 API surface as the goal shape:
  `createVirtualList(viewport, { items, key, render, estimateSize?,
  onState?, onReachStart/End?, onUnmount? })`,
  `setItems(items, { anchor? })`, `scrollTo(target, { align?, behavior? })
  → Promise<boolean>`, `state`, `dispose()` — details re-reviewed when the
  runtime is built on the new foundation.
- Invariants I1–I6 stand as the definition of correct; their *mechanisms*
  change (I6's "same painted frame" is satisfied by premeasured commits,
  not RO-synchronous corrections).

## Verification vehicles

- **demos/scroll-settle** — the settle lab: a plain (non-virtualized)
  natively scrolling list wired straight to the verbatim controller.
  Chunks load during scrolling but commit only at settle (prepend + one
  anchor-preserving write). Live panel: strategy, gesture state, settle
  lag, post-settle-motion counter (premature-settle detector), and an
  exportable event/decision trace. The settle signal is validated per
  browser HERE, before any runtime exists on top of it.
- **demos/streaming** — the chat acceptance target (kept in-tree, excluded
  from typecheck until the v2 runtime hosts it), compared against `main`.

## Execution order

1. Branch setup, clean slate, this contract. Port `scroll-settle.ts`
   verbatim; build the settle lab. **Review + all-browser lab checkpoint.**
2. Port the detached premeasurement primitive (`src/premeasure.ts`) and
   direct-host characterization tests for the settle controller's engine
   strategies. **Review checkpoint.**
3. The v2 runtime on the contract above: off-scroller chunk pipeline
   (build → premeasure → hold), settle-gated atomic commit into the kernel
   and DOM, commands/glide via the controller's programmatic gesture.
   **Review checkpoint.**
4. Host the streaming chat demo; gauntlet against `main` in
   Chromium/Firefox/Safari.

## Lessons carried as law

- jsdom has no layout engine: engine lifecycles and premeasurement are
  validated in real browsers (the lab), never asserted from jsdom.
- WebKit floors scrollTop writes; Safari kills momentum on writes; Firefox
  keeps a pre-apply scroll-limit snapshot for the rest of a gesture
  (ghost end) — the reasons the settle controller is ported, not rewritten.
- Estimates are a scrollbar courtesy, not geometry: v1's ghost-top bounce
  came from letting estimate error into live scroll space.
