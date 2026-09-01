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
   rubber-band tails, a scrollend+cooldown default) yielding the best
   obtainable settle signal for when structural changes to the scroller
   are safe — strong evidence, not proof, on wheel engines that expose no
   fingers-down state (the accepted trade-off below). Ported from `main`
   (`src/scroll-settle.ts`) and refined under lab traces: the unchanged
   portions match `main`; the two Firefox deviations are flagged in-source
   and documented here. Its engine knowledge is empirically verified and
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

Settles during active input or motion are defects, always. The v2
Firefox deviation (in the preserved controller, flagged in-source) is a
two-window design: a pending edge release is CONTESTED when a
post-scrollend wheel adds energy (grows past its predecessor beyond the
2px jitter band), reverses direction (new intent), or arrives from a
line/page-delta device (discrete notches are deliberate input; momentum
tails exist only on pixel-delta devices) — such a scrollend was a
mid-momentum/mid-hold pause, not the release (`main` honored it on a
single 1600ms timer and committed under actively-held fingers). A
decaying pixel-mode tail merely postpones the short window. Uncontested
releases settle after a 450ms confirmation window (main's 1600ms made
every normal edge load wait ~1.5s); contested ones require the full
1600ms of wheel silence, so nothing hangs and nothing settles while
input continues.

THE ACCEPTED TRADE-OFF (latency versus certainty, chosen deliberately):
wheel engines expose no fingers-down state, so an uncontested scrollend
is strong evidence of release, not proof — a hold that pauses into a
quiet scrollend and stays still is observably identical to a release
and can commit under resting fingers after ~450ms (contested: 1600ms).
Retaining the long window universally would restore main's ~1.5s edge
latency on every normal flick; the fast path was chosen. Standing lab
watch items: the APZ re-grab race after fast commits (a ghost-edge
bounce on fast re-grab means the 450ms buffer rises), and still-hold
commit frequency in practice.

## Preserved from v1 (signed off there, carried forward)

- `src/fenwick.ts` + `src/geometry.ts`: the pure keyed geometry kernel
  (capture → mutate → resolve transactions, anchor policies, pin-to-top
  reserve I5) with its oracle/property tests. Its role narrows: heights fed
  to it are premeasured, not estimated-then-corrected.
- `src/glide.ts`: the programmatic glide (exact landing, ≥1px/frame on
  floored engines, endpoint rebase).
- The API, as built in the v2 runtime (`src/virtual-list.ts`):
  `createVirtualList(viewport, { items, key, render, overscanPx?,
  onState?, onReachStart/End?, onDestroy?, settleStrategy? })`,
  `setItems(items, { anchor? })`, `scrollTo(target, { align?, behavior? })
  → Promise<boolean>`, `state` (adds `held`: work is waiting for settle),
  `dispose()`. Changes from the v1 shape: `estimateSize` is gone — every
  key is premeasured before it commits, so heights are never estimated
  (hosts window their data; the chat demo hands the runtime a modest
  loaded window); `onUnmount` became `onDestroy(element, item)` — with
  retained nodes, leaving the DOM is not the end of an element's life;
  destruction (key removed, replacement committed, pending snapshot
  superseded, dispose) is, exactly once. `render(item, existing)` may
  mutate `existing` in place — inside its fixed slot when mounted — or
  return a replacement, which is premeasured off-scroller and swapped in
  at commit.
- v2 addition (lab-prototyped): the reach callbacks receive a context with
  an `AbortSignal` — `onReachStart?: ({ signal }) => void` — that the
  runtime aborts only on conditions it knows objectively: the user reached
  the OPPOSITE edge (their intent moved on; every started operation for
  this edge — the fetch, the premeasure, the queued uncommitted chunk —
  dies with it), or `dispose()`. Hosts wire real fetches to it
  (`fetch(url, { signal })`); a host that wants a scrollback fetch to
  outlive the scroll-away simply ignores the signal. A re-approach refires
  the reach (hysteresis) and refetches.
- Invariants I1–I6 stand as the definition of correct; their *mechanisms*
  change (I6's "same painted frame" is satisfied by premeasured commits,
  not RO-synchronous corrections).

## Verification vehicles

- **demos/scroll-settle** — the settle lab: a plain (non-virtualized)
  natively scrolling list wired straight to the controller itself.
  Chunks load during scrolling but commit only at settle (prepend + one
  anchor-preserving write). Live panel: strategy, gesture state, settle
  lag, post-settle-motion counter (premature-settle detector), and an
  exportable event/decision trace. The settle signal is validated per
  browser HERE, before any runtime exists on top of it.
- **demos/streaming** — the chat acceptance target (kept in-tree, excluded
  from typecheck until the v2 runtime hosts it), compared against `main`.

## Execution order

1. Branch setup, clean slate, this contract. Port `scroll-settle.ts`
   from `main`; build the settle lab. **Review + all-browser lab
   checkpoint.** (Done; two lab-driven Firefox deviations ratified.)
2. Port the detached premeasurement primitive (`src/premeasure.ts`) and
   direct-host characterization tests for the settle controller's engine
   strategies. **Review checkpoint.** (Done; retained-node ownership rule
   ratified.)
3. The v2 runtime on the contract above: off-scroller preparation
   (render → premeasure → retain), dimensionally stable slots, settle-
   gated atomic commits into the kernel and DOM, commands/glide via the
   controller's programmatic gesture. **Review checkpoint.**
4. A focused dynamic-height lab: adversarial content only (delayed
   unknown-size images, expansion/shrinkage above/inside/below the
   viewport, off-scroller changes, remounts, rapid superseding changes,
   viewport-width changes) with telemetry that proves the invariants —
   zero slot/canvas/offset/scrollTop change during native scrolling, no
   row overlap (volatile content stays inside its committed slot), latest
   heights committing once at settle, a stationary visual anchor,
   immediate idle commits, held measurements invalidated by width/resource
   changes, aborted/superseded retained nodes destroyed exactly once. All
   dynamic-height behavior lives in the runtime; the lab only generates
   content and reports violations. **Pass in Chromium, Firefox, desktop
   Safari, iOS Safari.**
5. Only then: host the streaming chat demo; gauntlet against `main`.

## Lessons carried as law

- jsdom has no layout engine: engine lifecycles and premeasurement are
  validated in real browsers (the lab), never asserted from jsdom.
- WebKit floors scrollTop writes; Safari kills momentum on writes; Firefox
  keeps a pre-apply scroll-limit snapshot for the rest of a gesture
  (ghost end) — the reasons the settle controller is ported, not rewritten.
- Estimates are a scrollbar courtesy, not geometry: v1's ghost-top bounce
  came from letting estimate error into live scroll space.
