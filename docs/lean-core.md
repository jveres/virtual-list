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
   portions match `main`; the Firefox deviations (the two-window edge
   release, and Firefox alone retaining a pending release across fresh
   input) are flagged in-source and documented here. Its engine knowledge
   is empirically verified and is not re-derived.
2. **Chunk premeasurement** — items are built and measured OFF-scroller
   (a detached, width-synced measurement root) before they ever enter the
   scroll surface, so no DOM mutation of the scroller happens during
   scrolling and heights are real, not estimated, at commit time. Ported
   from `main`'s detached item measurer.

## The core contract (normative)

1. During an active scroll phase (a native gesture or a programmatic
   glide), the scroll surface's **geometry is immutable**: key order,
   measured extents, offsets, canvas size, and the scroll range do not
   change. Window reconciliation — mounting and
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
   image decode, font swaps — are geometry changes, and what happens to
   one that arrives during a scroll phase is the `scrollingUpdates`
   policy. The default, `"live"`, renders it in place on the committed
   element at once and commits its height at once whenever no
   anchor-preserving scroll write is needed for it — the row is at or
   below the viewport's anchor row, so only it and what lies below it
   change; the complete updated content is always visible. Under
   `"same-height"` the committed elements are **frozen along with
   geometry**: the update is rendered fresh (`render(item)` without
   `existing`) and premeasured off-scroller; if its whole-pixel height
   equals the committed height it is **promoted** — swapped into the
   committed slot immediately, same height, same offset, no geometry
   change — and otherwise retained until the settle commit swaps content,
   height, offsets, canvas, and anchor together, so nothing mounted ever
   shows content that disagrees with its slot (a fixed-height clipped box
   would clip growth and gap shrinkage, which is visibly wrong); later
   updates in a held phase advance that off-scroller replacement in
   place. `"freeze"` holds every such update until settle.
   In `"live"`, rows strictly above the anchor are off-screen and commit at
   settle or the moment the viewport reaches them; the trade-off is a
   scroll range that changes under a live scroll, and a shrink near the end
   can make the browser clamp `scrollTop` to the new maximum, which the
   runtime reconciles in the same frame. Structural changes are
   settle-gated in every mode. The streaming chat uses `"live"`.
   While the surface is idle, the update renders in place and commits
   immediately (same pipeline). Changes made outside `setItems` — direct
   DOM mutation of a mounted row, a late resource growing an element — are
   outside this guarantee: the fixed slot keeps geometry immutable as a
   safety net (the ResizeObserver marks the row dirty; its height commits
   at settle, or in the same delivery when idle), but such content clips
   or gaps until then. Hosts route size changes through `setItems` and
   reserve dimensions for late resources.

Corollaries: no ResizeObserver-driven mid-gesture geometry correction, no
gesture-time canvas translation, no "safe update" exceptions. What v1
handled with compensation machinery simply cannot occur: heights are known
before mount, and geometry changes only at settle — the one deliberate
exception being `"live"`'s no-write commits below the anchor, a product
choice with its trade-off stated above.

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

Safari invalidates a pending release as soon as fresh wheel, touch, or
pointer input resumes. Safari can report reversal input before the first
scroll event in the new direction; retaining the old `scrollend` would let
held work commit in that gap. Firefox alone preserves a pending edge release
because its contested-release classifier explicitly distinguishes continued
wheel input from a decaying momentum tail. Direct touch and scrollbar
re-grabs invalidate the pending release on every engine.

## Invariants

The definition of correct, referenced by number throughout the code:

- **I1** — the resolved scroll target keeps the visible anchor's viewport
  coordinate stationary (a shrink clamps to the row's own extent).
- **I2** — end-follow resolves against the final geometry of the
  transaction: measurements landing inside it are fully reflected.
- **I3** — reach signals fire once per approach, with entry/exit
  hysteresis, and re-arm only after the viewport leaves the exit zone.
- **I4** — one logical update is one transaction; API calls from host
  callbacks queue behind it and run against the state those callbacks
  observed; a failed transaction discards only what it queued.
- **I5** — a pinned key can always be scrolled to the viewport top: the
  reserve makes up the shortfall, is consumed by growth, regrown by
  shrinkage, and never collapses out from under the viewport. A viewport
  height change while the viewport stands on the pin (a window resize, a
  device rotation) re-resolves to the pin: the row stays at the top and the
  reserve is sized to the new height. The engine clamps the position and
  dispatches that scroll before the resize is observed; the controller
  reads a scroll landing on the new maximum right after a client-height
  change as layout, never as input.
- **I6** — an idle size change commits in the same painted frame as its
  observation (after layout, before paint); a phase-time change commits at
  the settle, or, under `"live"`, at once when no scroll write is needed.
  Within a commit, every mounted slot moves to its committed offset before
  any layout-forcing access: WebKit computes a scroller's range at layout
  and does not recompute it for a transform-only move, so a scroll write
  between the canvas write and the slot moves froze a stale range (a blank
  gap below the last row after an iPad rotation).

## Preserved from v1 (signed off there, carried forward)

- `src/fenwick.ts` + `src/geometry.ts`: the pure keyed geometry kernel
  (capture → mutate → resolve transactions, anchor policies, pin-to-top
  reserve I5) with its oracle/property tests. Its role narrows: heights fed
  to it are premeasured, not estimated-then-corrected.
- `src/glide.ts`: the programmatic glide (exact landing, ≥1px/frame on
  floored engines, endpoint rebase).
- The API, as built in the v2 runtime (`src/virtual-list.ts`):
  `createVirtualList(viewport, { items, key, render, overscanPx?,
  onState?, onReachStart/End?, onDestroy?, settleStrategy?,
  scrollingUpdates?, followBehavior? })`,
  `setItems(items, { anchor? })`, `scrollTo(target, { align?, behavior?,
  duration?, offset? })`, `remeasure(key, { anchor? })`,
  `setEdgeSlot(edge, slot | null)`, `positionOf(key)`, `elementOf(key)`,
  `state`, `dispose()`; options add `edgeSlots`. An
  edge slot is a fixed-height host row the runtime keeps at an edge of the
  surface (a scrollback loader in the flow): geometry, but never the anchor
  — the kernel's anchor exclusion makes the anchor its content neighbor,
  so when content replaces it the row the user was reading keeps its place
  and the slot's strip shows the new rows. The two read queries serve a
  sticky-header companion (`demos/shared/sticky-headers.ts`), which floats
  the current day header over the viewport top and only ever reads
  committed positions. `offset` lands a keyed target below such a header;
  an `align: "start"` pin includes that inset in its reserve, so the landing
  remains at the logical end and streaming auto-follow stays engaged.
  Set `followBehavior: "smooth"` to animate automatic end-follow with a
  live-target glide as content grows. The default, `"instant"`, preserves
  the atomic-write behavior. User input interrupts either behavior. While the
  smooth follower owns the end target, `state.following` remains `true`,
  including the quiet gaps between consecutive glide legs.
  `remeasure` is the intent-bearing path for a discrete host interaction
  such as opening a tool panel. It reads the mounted row on the next animation
  frame (after the default action, before paint) and defaults to the viewport
  anchor, disengaging and cancelling smooth automatic follow. During a native
  scroll its measurement and explicit policy wait together for settle. A
  missing or unmounted key is a no-op, and the later ResizeObserver delivery
  sees the committed height and does not duplicate the commit.
  `scrollTo` returns `Promise<boolean>`; `state` adds `held` (work is
  waiting for settle). Changes from the v1 shape: `estimateSize` is gone — every
  key is premeasured before it commits, so heights are never estimated
  (hosts window their data; the chat demo hands the runtime a modest
  loaded window); `onUnmount` became `onDestroy(element, item)` — with
  retained nodes, leaving the DOM is not the end of an element's life;
  destruction (key removed, replacement committed, pending snapshot
  superseded, dispose) is, exactly once. `render(item, existing)` may
  mutate `existing` in place or return a replacement, which is
  premeasured off-scroller and swapped in at commit; `existing` is offered
  when mutating it is safe (idle, an off-scroller pending replacement, or
  in `"live"` mode) — under `"same-height"` and `"freeze"` a committed
  row's phase-time update is rendered fresh and promoted or swapped at
  settle.
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
  change (no mid-gesture ResizeObserver corrections: an idle observation
  commits in its own delivery, which is I6, and a phase-time one waits for
  the settle — or, under `"live"`, commits at once when no scroll write is
  needed).

## Verification vehicles

- **demos/scroll-settle** — the settle lab: a plain (non-virtualized)
  natively scrolling list wired straight to the controller itself.
  Chunks load during scrolling but commit only at settle (prepend + one
  anchor-preserving write). Live panel: strategy, gesture state, settle
  lag, post-settle-motion counter (premature-settle detector), and an
  exportable event/decision trace. The settle signal is validated per
  browser HERE, before any runtime exists on top of it.
- **demos/dynamic-height** — the dynamic-height lab: the v2 runtime under
  adversarial content (streaming rows, toggles, late-loading images,
  width-sensitive code, edge loads with abort, superseding bursts,
  deletions, width jitter), every change entering through setItems (in
  place when idle or under `"live"`, a fresh off-scroller render during a
  phase under `"same-height"`/`"freeze"`, or a replacing render); late
  images reserve a zero box and re-enter through
  setItems at load. Its telemetry observes the runtime
  strictly from outside — a scrollTop write hook, a MutationObserver on
  the canvas, the lab's own native-scroll evidence — and reports each
  contract violation by code: G geometry changed under a live scroll phase
  outside a valid `"live"` no-write commit, W `scrollTop` written under
  native scroll, O slot overlap or a non-clipping slot, A anchor moved
  across a commit, S stale slot height while quiet, L a mounted row
  disagreeing with its slot at the post-runtime ResizeObserver delivery (a
  clipped or gapped paint, held or not), T height re-committed without a
  change, D destroy-once or leak failures, and X a runtime throw that is
  not the lab's own chaos render failure (or an uncaught exception).
- **demos/streaming** — the chat acceptance target, hosted on the v2
  runtime under `scrollingUpdates: "live"`: pin-to-top on send (I5 reserve
  plus a smooth `scrollTo`), end-follow through streams, scrollback loads
  wired to the reach signal, version branches, live tool panels.

## Browser matrix

The repository includes an opt-in Playwright runner for the dynamic-height
lab. It starts a private Vite server, exercises every scrolling policy in
Chromium, Firefox, and WebKit with real wheel input, and fails on a lab
violation, clipped paint, teardown leak, page error, console error or
unexpected console warning, or wrong settle strategy.

Install the Playwright engines once, then run the complete matrix:

```sh
pnpm exec playwright install chromium firefox webkit
pnpm run test:browser
```

Use a focused run while developing a browser-specific fix:

```sh
pnpm run test:browser -- --quick --engine=webkit --mode=live
```

Chaos mode drives the lab's randomized adversary under random wheel input
for a duration and stops at the first violation; `--seed` makes the input
reproducible and `--headed` shows the browser:

```sh
pnpm run test:browser -- --chaos=300 --engine=webkit --seed=4242
```

Failure traces are written to `browser-artifacts/` (override with
`BROWSER_MATRIX_ARTIFACTS`), which Git ignores. Set `BROWSER_MATRIX_URL`
to test an already-running server. Set
`BROWSER_MATRIX_CHROMIUM_CHANNEL=chrome` to use installed Chrome instead of
Playwright Chromium. This matrix is reproducible engine evidence; it does
not replace the physical desktop Safari and iOS Safari acceptance pass.

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
   controller's programmatic gesture. **Review checkpoint.** (Done;
   eleven review rounds of lifecycle invariants, each with discriminating
   regressions, signed off at `2c540c9`/`15db729`.)
4. A focused dynamic-height lab: adversarial content only (delayed
   unknown-size images, expansion/shrinkage above/inside/below the
   viewport, off-scroller changes, remounts, rapid superseding changes,
   viewport-width changes) with telemetry that proves the invariants — no
   structural geometry or `scrollTop` writes during native scrolling,
   `"live"` commits limited to rows at or below the anchor with no explicit
   write, no row overlap, latest held heights committing once at settle, a
   stationary visual anchor outside the documented live-row changes,
   immediate idle commits, held measurements invalidated by width or
   resource changes, and aborted or superseded retained nodes destroyed
   exactly once. All dynamic-height behavior lives in the runtime; the lab
   only generates content and reports violations. **Pass in Chromium,
   Firefox, desktop Safari, and iOS Safari.** (Done; signed off at
   `d7ec716`: the standard matrix and 5-minute chaos runs clean in
   WebKit, Chromium and Firefox; chaos with manual scrolling clean in
   desktop Safari; iPadOS and iPhone runs reported through the device
   channel and their findings fixed.)
5. Only then: host the streaming chat demo; gauntlet against `main`.
   (Hosted: `demos/streaming` runs on the v2 runtime in `"live"` mode —
   pin-to-top, end-follow, scrollback with abort, branches, tool panels —
   and is back in the typecheck and build. The gauntlet against `main` in
   the four browsers is the remaining acceptance step.)

## Lessons carried as law

- jsdom has no layout engine: engine lifecycles and premeasurement are
  validated in real browsers (the lab), never asserted from jsdom.
- WebKit floors scrollTop writes; Safari kills momentum on writes; Firefox
  keeps a pre-apply scroll-limit snapshot for the rest of a gesture
  (ghost end) — the reasons the settle controller is ported, not rewritten.
- Estimates are a scrollbar courtesy, not geometry: v1's ghost-top bounce
  came from letting estimate error into live scroll space.
