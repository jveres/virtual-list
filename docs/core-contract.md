# Core contract

This document defines the runtime's geometry and scrolling contract, its
browser-specific trade-offs, and the labs used to verify them. For the public
API and demo setup, see the [README](../README.md). For the design of the
orchestration layer (the one commit rule, in-canvas measurement, the pass,
and native scroll anchoring), see the [architecture](architecture.md).

## The two cornerstones

The runtime combines browser-aware settling with known item geometry:

1. **Cross-browser scrollend detection** — the scroll-settle controller:
   per-engine heuristics (Chromium wheel-idle windows and single-scrollend
   sequences, Firefox edge release confirmation against APZ ghost ends, Safari
   rubber-band tails, a scrollend+cooldown "default" that is explicit
   opt-in only — detection goes by engine, WebKit without a Safari token
   included, and an unknown engine gets the Firefox contract) yielding the best
   obtainable settle signal for when structural changes to the scroller
   are safe — strong evidence, not proof, on wheel engines that expose no
   fingers-down state (the accepted trade-off below). The controller lives in
   `src/scroll-settle.ts`; its Firefox candidate-release policy is documented
   below and tested against renewed input and decaying momentum tails.
2. **Measurement before reveal** — a new or replacing row is rendered into
   its own clip slot inside the canvas, where it waits hidden: zero-height,
   clipped, `inert`, and `aria-hidden`. It's laid out there once, with the
   page's real styles, and neither paints nor changes the scroll range. When
   it commits inside the window, the runtime reveals the same slot in place,
   with no second layout and no re-parenting. Heights are measured, not
   estimated, before the row shows. Hosts can instead supply declared
   heights. Mounting and unmounting known rows continues during scrolling
   without changing their committed geometry.

## The core contract (normative)

The following rules govern preparation, scrolling, and commits:

1. During an active scroll phase (a native gesture or a programmatic
   glide), the scroll surface's **geometry above the reader is immutable**:
   key order, measured extents, and offsets above the viewport's anchor row
   do not change, and the runtime makes no anchor-preserving scroll write
   (a glide's own frames are its only writes). Two exceptions exist, and
   neither writes the scroll position:
   - **At or below the anchor.** A change that sits entirely at or below
     the viewport's anchor row lands at once, unless it names an `"end"` or
     explicit anchor (rule 4). It needs no scroll write, so
     nothing on screen moves (I1 holds by construction). The canvas size
     and the scroll range can change with it.
   - **Native anchoring.** Under native CSS scroll anchoring (the
     `anchoring` option), away from the scroll edges (within 2 px of an
     edge counts as at it) and outside a glide, a change above the reader
     also lands mid-gesture. The browser adjusts the scroll position inside
     its own scroll machinery and keeps the reader still. The runtime
     records the position it expects, so the settle sensor doesn't read the
     browser's adjustment as input.

   Window reconciliation (mounting and unmounting already-known, measured
   rows at their fixed positions) continues freely throughout the scroll;
   without it a long momentum scroll would run into blank gaps. Positioning
   within fixed geometry isn't a structural change.
2. New rows may be fetched, rendered, and measured during a scroll, in
   hidden slots inside the canvas that neither paint nor change the scroll
   range. Window jobs (`updateWindow`) stage their rows in idle callbacks
   during a gesture; engines without `requestIdleCallback` prepare them at
   the commit instead.
3. After the cross-browser settle signal, the runtime may
   **atomically commit**, in one frame:
   - keys,
   - measured heights,
   - canvas geometry,
   - the mounted window, revealing staged rows in place,
   - one anchor-preserving scroll position (under native anchoring, the
     browser's own adjustment).
4. One commit rule governs every change, with no update modes. Everything
   the host submits becomes the desired state: the latest key order, new
   rows already rendered and measured, and an anchor intent. It lands:
   - **at once**, when the list is idle, or when every change sits at or
     below the viewport's anchor row (rule 1);
   - **at once under native anchoring**, away from the scroll edges and
     outside a glide (rule 1);
   - **at the settle** otherwise: a prepend, a trim or height change above
     the anchor, or a reorder.

   Same-key, size-changing updates (streaming text, disclosure toggles,
   image decode, font swaps) are geometry changes. The runtime renders
   them in place on the committed element at once, through
   `render(item, existing)`, so the complete updated content is always
   visible. The new height commits under the rule above: at once for a row
   at or below the anchor, or for any row under native anchoring away from
   the edges and outside a glide. Otherwise a row strictly above the anchor
   (off-screen) commits its height at the settle, or the moment the
   viewport reaches it. The trade-off is a
   scroll range that changes under a live scroll: a shrink near the end can
   make the browser clamp `scrollTop` to the new maximum, which the runtime
   reconciles in the same frame.

   A structural snapshot lands mid-gesture under runtime anchoring only when
   it changes nothing above the anchor: the keys up to it are an unchanged,
   unreplaced prefix, every dirty row sits at or below it, and the anchor
   row itself changes only in place (re-rendered, replaced at its index, or
   removed; never moved to another index). A message version switch and an
   appended message qualify. Such a commit writes no scroll position; an
   iOS rubber-band bounce holds the viewport outside the range, and a
   clamp would fight it. A snapshot with an `"end"` anchor or an explicit
   `{ key, offset }` anchor, including a window job's, always waits for the
   settle during a scroll: the browser only keeps the viewport's own content
   still. The native-anchoring exception also doesn't apply in two places,
   where only the at-or-below-the-anchor exception remains:
   - within 2 px of a scroll edge, where a rubber-band bounce, Firefox's
     stale scroll limit, and an early `scrollend` live;
   - during a glide, which heads for a target in the committed geometry, so
     held work waits for its landing.

   Positioned (masonry) layouts always use runtime anchoring and can't
   prove by index that a change stays below the anchor, so their structural
   changes always wait for the settle. Mid-phase, a positioned card, or a
   declared-height row whose height changes, re-renders inside the settle
   commit, so it never shows new content in its old box. Under native
   anchoring away from the edges and outside a glide, a stacked
   declared-height row re-renders at once instead. Window jobs
   (`updateWindow`) prepare during a gesture and commit when the list is
   idle, or mid-gesture under native anchoring away from the edges.
   While the surface is idle, an update renders in place and commits
   immediately (same pipeline). Changes made outside `setItems` — direct
   DOM mutation of a mounted row, a late resource growing an element — are
   outside this guarantee: the fixed slot keeps geometry immutable as a
   safety net (the ResizeObserver marks the row dirty, and its height
   commits under the rule above: in the same delivery when idle or when no
   scroll write is needed, otherwise at the settle), but such content clips
   or gaps until then. Hosts route size changes through `setItems` and
   reserve dimensions for late resources.

The runtime doesn't compensate for geometry changes with gesture-time
anchor writes or canvas translations. Heights are measured or declared before
a row is revealed. Geometry changes above the reader wait for the settle,
except where native scroll anchoring lets the browser keep the reader still.
Changes at or below the anchor land at once without a scroll write.

Settles during active input or motion are defects, always. The
Firefox edge policy is a
candidate-release design: a pending edge release is invalidated when a
post-scrollend wheel adds energy (grows more than a pixel past its
predecessor, with a 2px floor), reverses direction (new intent), or arrives from a
line/page-delta device (discrete notches are deliberate input; momentum
tails exist only on pixel-delta devices) — such a scrollend was a
mid-momentum/mid-hold pause, not the release (an earlier controller honored it on a
single 1600ms timer and committed under actively-held fingers). A
decaying pixel-mode tail merely postpones the 450ms confirmation window.
Renewed input cancels the candidate and its scheduled checks. The controller
then requires a subsequent `scrollend`; wheel silence alone cannot settle
the protected edge. If Firefox omits that event, updates remain held until
a later gesture settles. This replaces the former 1600ms silence fallback,
which could commit during a motionless re-grab.

THE ACCEPTED TRADE-OFF (latency versus certainty, chosen deliberately):
wheel engines expose no fingers-down state, so an uncontested scrollend
is strong evidence of release, not proof — a hold that pauses into a
quiet scrollend and stays still is observably identical to a release
and can commit under resting fingers after ~450ms if no renewed input is
detectable.
Retaining the long window universally would impose ~1.5s edge
latency on every normal flick; the fast path was chosen. Standing lab
watch items: the APZ re-grab race after fast commits (a ghost-edge
bounce on fast re-grab means the 450ms buffer rises), and still-hold
commit frequency in practice.

Safari invalidates a pending release as soon as fresh wheel, touch, or
pointer input resumes. Safari can report reversal input before the first
scroll event in the new direction; retaining the old `scrollend` would let
held work commit in that gap. Firefox alone preserves a pending edge release
because its release classifier explicitly distinguishes renewed
wheel input from a decaying momentum tail. Direct touch and scrollbar
re-grabs invalidate the pending release on every engine.

## Invariants

The definition of correct, referenced by number throughout the code:

- **I0** — committed heights round up to a stable pixel grid. Stacked rows
  use whole CSS pixels at integer display scales (1x, 2x, 3x), since engines
  can quantize scroll writes to CSS pixels even on Retina displays. These
  heights also lie on the device grid. Fractional scales and host-positioned
  layouts retain device-pixel rounding (two thirds of a CSS pixel at 1.5x).
  A half-CSS-pixel prepend at 2x must not depend on the browser accepting
  a half-CSS-pixel scroll correction.
- **I1** — the resolved scroll target keeps the visible anchor's viewport
  coordinate stationary. An anchor row that shrinks under the viewport's
  offset into it keeps the slice the user saw — its bottom — at the same
  distance from the viewport top, so the rows below hold still; only a
  row shorter than that slice lands at its own top.
- **I2** — end-follow resolves against the final geometry of the
  transaction: measurements landing inside it are fully reflected.
- **I3** — reach signals fire once per approach, with entry/exit
  hysteresis, and re-arm only after the viewport leaves the exit zone.
- **I4** — one logical update is one transaction; API calls from host
  callbacks queue behind it and run against the state those callbacks
  observed; a failed transaction discards only what it queued.
- **I5** — a pinned key can always be scrolled to the viewport top: the
  reserve makes up the shortfall, is consumed by growth, regrown by
  shrinkage, and never collapses out from under the viewport. A pinned row
  replaced in place (a version switch, an edit: a new key at its index,
  everything before it unchanged) passes the pin to its replacement; a
  removal of the pinned key drops the pin. A surviving key that reaches
  the start remains pinned, even when it needs no new reserve. Declarative
  pinning selects the destination snapshot's last matching item in the same
  commit, so a branch change needs no host re-pinning command. A viewport
  height change while the viewport stands on the pin (a window resize, a
  device rotation) re-resolves to the pin: the row stays at the top and the
  reserve is sized to the new height. A viewport WIDTH change ends a scroll
  phase in flight (a rotation mid-fling): the layout the gesture was
  scrolling no longer exists, so the takeover settles it — held work
  commits with its anchor, rows measured at the new width — and the scroll
  goes on in a new phase. The engine clamps the position and
  dispatches that scroll either before the resize is observed (a window
  resize) or in the frame after it (an in-page composer resize); the
  controller reads a scroll landing on the new maximum right after a
  client-height change as layout, never as input, and the runtime tells
  the clamp by its direction — it pulls a position from past the stale
  end back onto it.
- **I6** — an idle size change commits in the same painted frame as its
  observation (after layout, before paint); a phase-time change commits at
  once when no scroll write is needed (at or below the anchor, or under
  native anchoring away from the edges and outside a glide), and otherwise
  at the settle.
  Within a commit, every mounted slot moves to its committed offset before
  any layout-forcing access: WebKit computes a scroller's range at layout
  and does not recompute it for a transform-only move, so a scroll write
  between the canvas write and the slot moves froze a stale range (a blank
  gap below the last row after an iPad rotation).

## Runtime components and API

These components implement the contract. The API summary below explains their
interaction; the [README](../README.md) lists the public options.

- `src/fenwick.ts` + `src/geometry.ts`: the pure keyed geometry kernel
  (capture → mutate → resolve transactions, anchor policies, pin-to-top
  reserve I5) with its oracle/property tests. Heights fed to it are measured
  or declared, not estimated-then-corrected.
- `src/glide.ts`: the programmatic glide (exact landing, ≥1px/frame on
  floored engines, endpoint rebase). Two legs: the LANDING — the last
  viewport of travel, or the whole trip when shorter — always takes the
  same time on the same ease-out, so a one-viewport hop and a jump across
  the list arrive identically; the APPROACH covers the rest, braking at a
  constant rate — the landing's own initial braking — down to the
  landing's entry speed, so the hand-off is continuous in speed and in
  deceleration (an asymptotic decay held a constant speed for its last
  third and then braked hard: a stutter one viewport before the end); its
  duration follows from the distance and is capped. A `scrollTo` `duration` is the landing time and the
  approach cap (a trip from the far end takes at most twice it); the
  default lands in 280ms and bounds a trip by 1080ms; follow legs land in
  320ms.
- Runtime policy boundaries: `follow.ts` owns follow intent, destination
  limits, and visibility catch-up; `reach.ts` owns edge-load hysteresis and
  cancellation. Neither writes DOM or starts a glide. `wheel-policy.ts`
  owns Firefox's candidate-release state and Chromium's early-scrollend
  suppression. Only the selected engine's policy exists. Shared listeners,
  scroll sampling, and settle scheduling remain in `scroll-settle.ts`.
  These boundaries preserve the public API and existing timing windows.
- `src/viewport-repaint.ts`: one-shot WebKit scrolling-layer recovery after
  a disposed list is replaced on the same viewport. The runtime owns the
  weak viewport identity and pending frame. First mounts and item updates
  do not request recovery; disposal cancels it, and new input or an active
  scroll phase prevents it from interrupting scrolling. Inline overflow
  declarations, including their priority, are restored after the layout
  flush. Recovery does not write the scroll position.
- Orchestration (`src/virtual-list.ts`): the desired state, the one commit
  rule, in-canvas staging and reveal, and the native-anchoring flow surface.
  Every entry point (an API call, a scroll event, an observer delivery, a
  settle, a glide frame, or a window job) runs inside one function, `pass`.
  Nested calls join the open pass; API calls from host callbacks queue
  behind it, and host callback failures are thrown once the runtime has
  reached a consistent state. `src/positioned-geometry.ts` holds the
  geometry of host-positioned (masonry) layouts.
- The public API (`src/virtual-list.ts`, types in `src/types.ts`):
  `createVirtualList(viewport, { items, key, render, height?, position?,
  boot?, pinning?, overscanPx?, anchorable?, onState?, onViewport?,
  onReachStart/End?, onMount?, onUnmount?, onDestroy?, settleStrategy?,
  anchoring?, followBehavior?, followMode?, followInset? })`,
  `boot` chooses where the list opens: `"end"` (the default, following
  armed) or `"start"` (the initial position, never follow intent).
  `anchoring` chooses who keeps the reader still when content above it
  changes: `"auto"` (the default) uses native CSS scroll anchoring where
  `CSS.supports("overflow-anchor", "auto")` holds and the scroller doesn't
  compute to `overflow-anchor: none`, and the runtime otherwise; `"native"`
  forces native anchoring; `"runtime"` forces settle-gated runtime writes.
  Positioned layouts always use the runtime. The canvas records the mode in
  `data-anchoring`. A staged `updateWindow` proposal is rendered and
  measured in idle callbacks during an active scroll phase; engines without
  `requestIdleCallback` prepare it at the commit.
  `setItems(items, { anchor? })` — a policy, or a host-named anchor
  `{ key, offset }`: after the commit the key's top sits `offset` pixels
  below the viewport top (a re-flow names where the old point went; a
  missing key falls back to the captured anchor) —, `scrollTo(target, { align?, behavior?,
  duration?, offset?, pin? })`, `updateItem(key, item, { anchor? })`,
  `remeasure(key, { anchor? })`,
  `setEdgeSlot(edge, slot | null)`, `positionOf(key)`, `elementOf(key)`,
  `state`, `dispose()`; options add `edgeSlots`. An
  edge slot is a fixed-height host row the runtime keeps at an edge of the
  surface (a scrollback loader in the flow): geometry, but never the anchor
  — the kernel's anchor exclusion makes the anchor its content neighbor,
  so when content replaces it the row the user was reading keeps its place
  and the slot's strip shows the new rows. The two read queries serve a
  sticky-header companion (`src/companions/sticky-headers.ts`), which floats
  the current day header over the viewport top and only ever reads
  committed positions. `offset` lands a keyed target below such a header;
  an `align: "start"` pin includes that inset in its reserve, so the landing
  remains at the logical end and streaming auto-follow stays engaged.
  `scrollTo("end", { pin: { key, offset? } })` establishes that reserve
  without an intermediate scroll to the pin. Its destination is the greater
  of the pinned position and the content's natural end, excluding an older
  pin's temporarily retained reserve. That old reserve drains after landing,
  never underneath the glide. The command resolves `false` if the pin key
  is missing after takeover commits held work. `pin` is valid only with an
  end target; its offset defaults to zero, including non-finite input.
  The list option `pinning: false` disables command-created pins; the default
  is `true`. Keyed alignment then clamps to the content's scroll range, end
  commands target the content bottom, and end-command `pin` requests are
  ignored. Explicit reading anchors can still retain temporary space for
  continuity; commands exclude that space from their targets, and it drains
  after landing without collapsing the surface during a glide.
  `pinning: { match: (item) => boolean, offset?: number }` instead makes
  the pin part of each committed snapshot: the last matching item remains
  scrollable to its inset regardless of navigation, manual scrolling,
  content growth/shrinkage, or viewport resizing. No match clears the pin.
  The predicate runs during preparation, including targeted updates; failure
  leaves committed geometry intact. The offset is also read during preparation;
  a getter can supply a live inset. Submit a snapshot after changing that inset.
  Held work carries its selected key and offset until commit.
  Commands navigate within this geometry without replacing its
  pin (`align: "start"` and end-command `pin` don't select another pin).
  The offset defaults to zero; non-finite values use zero. The streaming demo
  supplies only the user-row predicate and sticky-header inset, not custom
  bottom-space calculations or navigation-triggered re-pinning.
  A hidden document follows by write (a glide started then would only
  play on return, the background growth as one slide), and so does one
  that just became visible, for a short window (300ms) in which growth
  whose measurement was paused still arrives; the return cancels a glide
  left over and catches a follower up at once.
  Set `followBehavior: "smooth"` to animate automatic end-follow with a
  live-target glide as content grows. The default, `"instant"`, preserves
  the atomic-write behavior. User input interrupts either behavior. While the
  smooth follower owns the end target, `state.following` remains `true`,
  including the quiet gaps between consecutive glide legs. A command to
  `"end"` is explicit follow intent: a completed one arms following at its
  settle even when growth outran its glide (fast streaming), and an instant
  one arms it on the spot; only genuine input interrupts it. Standing at
  the end after a commit that could have followed it (`"auto"`, `"end"`,
  boot included) is following too, so scrollback landing above a followed
  end keeps it engaged. A host's explicit `"viewport"`/`"none"` is never
  follow intent and disengages it (a bottom page load, a collapsed tool
  panel even when the shrink leaves the viewport at the end — though a
  gesture that then ends at the end re-engages it like any gesture), while
  a resize or a mid-phase no-write commit leaves the intent as it found it and
  catches up if the end moved. A viewport height change during a phase
  gets its commit at the settle with the stance the pre-resize position
  decided — in flight, the glide's destination decides, and a pin stance
  holds for the phase — so a pinned landing (I5) keeps its row at the top
  and its reserve sized to the viewport it lands in even when the engine's
  clamp moved the viewport meanwhile. Genuine input that leaves the pin drops
  a held pin stance — the settle never pulls the user back onto the pin —
  while the engine's own moves keep it: a clamp pulling a position past
  the stale range's end back onto it, a rubber-band bounce beyond it.
  `followMode: "keep-start"` bounds automatic follow: it goes only until the
  last row's top (less `followInset`) reaches the viewport top, and never
  backwards, so a reply is read from its start and a viewport already past
  that point stays put; explicit commands and explicit `"end"` anchors
  still reach the end, and boot lands at the end by default. `setFollowMode` changes
  the mode live; widening it while following catches up at once.
  `remeasure` is the intent-bearing path for a discrete host interaction
  such as opening a tool panel. It reads the mounted row on the next animation
  frame (after the default action, before paint) and defaults to the viewport
  anchor, disengaging and cancelling smooth automatic follow. During a native
  scroll its measurement and explicit policy wait together for settle. A
  missing or unmounted key is a no-op, and the later ResizeObserver delivery
  sees the committed height and does not duplicate the commit.
  `scrollTo` returns `Promise<boolean>`; `state` adds `held` (work is
  waiting for settle). Heights are measured or declared, never estimated.
  Hosts window their data; the chat demo hands the runtime a modest loaded
  window. Measured rows keep their rendered element and their clip slot for
  their whole life, including while unmounted; element-local state
  survives re-entry. DOM order always follows list order: a slot joins the
  canvas next to its nearest connected list neighbor. Measured-row
  lifecycle: `onDestroy(element, item)` ends an element's life (key
  removed, replacement committed, staged replacement superseded, or
  dispose), exactly once. `onMount`/`onUnmount` report an element joining
  or leaving the mounted window (unmount precedes destroy). Use these hooks,
  not `element.isConnected`, to control mounted resources: a staged row is
  connected in its hidden slot but not mounted. After a measurement of one
  detached row (a lone offscreen update, such as a streaming reply the user
  scrolled away from), the runtime keeps that row laid out in its hidden
  slot between updates. It isn't mounted or observed there. Other hidden
  rows that the window doesn't reveal are detached after the commit.
  Late resources still need stable dimensions or a host update. The runtime
  observes the row again when it mounts and commits detected size changes
  under the one commit rule.
  Under runtime anchoring, during an explicit measured-row glide's final
  landing leg, departing rows stay mounted until settle to avoid a Safari
  paint hitch from removing slots just before arrival. This retains only
  landing departures, not the whole trip; interruption or a rebased
  approach releases the hold. Automatic follow, native anchoring, and
  declared-height windows don't use this hold.
  `render(item, existing)` may mutate `existing` in place or return a
  replacement. The runtime offers the committed element as `existing` for
  every update, idle or mid-phase. A replacement is staged in its own
  hidden slot, measured there, and swapped in at commit. A declared-height
  row whose height changes mid-phase, and a positioned card, are rendered
  in place inside the settle commit instead (or at once under native
  anchoring away from the edges, for a stacked declared row). Declared
  heights: with `height(item)` given, an item's geometry is its declared
  height on the device grid, never measured, never observed, and unchanged
  by a viewport width
  change (the host re-flows); `remeasure` is inert. Declared heights must
  be finite and positive. Declared rows keep data and geometry independently
  of DOM: only the overscan window renders, and leaving it destroys the
  element after its unmount hook. Re-entry renders a fresh element. Store
  persistent row state in item data.
  `updateItem` prepares one unchanged key without rebuilding the key order;
  when work is already held, successful preparation patches only the
  touched key in the desired state, preserving untouched rows, order, and
  the inherited anchor. It does not copy the full item array or rebuild the
  key index. Unknown keys are ignored. The commit-rule checks and the
  eventual structural commit can still inspect multiple rows; the targeted
  preparation is not a constant-time guarantee for the entire update call.
  In a positioned layout, `updateItem` re-places every item.
  Preparation preserves internal ownership and cleans up fresh elements on
  failure. Rollback of in-place host rendering is best effort, because the
  runtime cannot reverse arbitrary DOM mutations or external side effects.
- The reach callbacks receive a context with
  an `AbortSignal` — `onReachStart?: ({ signal }) => void` — that the
  runtime aborts only on conditions it knows objectively: the user reached
  the OPPOSITE edge (their intent moved on; every started operation for
  this edge — the fetch, the staged rows, the queued uncommitted chunk —
  dies with it), or `dispose()`. Hosts wire real fetches to it
  (`fetch(url, { signal })`); a host that wants a scrollback fetch to
  outlive the scroll-away simply ignores the signal. A re-approach refires
  the reach (hysteresis) and refetches.
  Short lists can occupy both proximity zones at once. In that overlap,
  neither edge cancels the other. Opposite-edge cancellation waits until
  the viewport leaves the original proximity zone.
- Invariants I0–I6 define correct behavior. An idle ResizeObserver observation
  commits in its own delivery, which is I6. A phase-time one commits at once
  when no scroll write is needed (at or below the anchor, or under native
  anchoring away from the edges and outside a glide) and otherwise waits for
  the settle.

## Verification vehicles

Use these demos to isolate controller behavior and exercise runtime contracts:

- **demos/scroll-settle** — the settle lab: a plain (non-virtualized)
  natively scrolling list wired straight to the controller itself.
  Chunks load during scrolling but commit only at settle (prepend + one
  anchor-preserving write). Live panel: strategy, gesture state, settle
  lag, post-settle-motion counter (premature-settle detector), and an
  exportable event/decision trace. This isolates the settle signal from
  runtime behavior for per-browser validation.
- **demos/dynamic-height** — the dynamic-height lab: the runtime under
  adversarial content (streaming rows, toggles, late-loading images,
  width-sensitive code, edge loads with abort, superseding bursts,
  deletions, width jitter), every change entering through setItems (in
  place, or a replacing render); late images reserve a zero box and
  re-enter through setItems at load. The lab's page sets
  `overflow-anchor: none`, so it checks runtime anchoring: changes at or
  below the anchor land at once, and changes above it wait for the settle.
  Its telemetry observes the runtime
  strictly from outside — a scrollTop write hook, a MutationObserver on
  the canvas, the lab's own native-scroll evidence — and reports each
  contract violation by code: G geometry changed under a live scroll phase
  outside a valid no-write commit at or below the anchor, W `scrollTop`
  written under
  native scroll, O slot overlap or a non-clipping slot, A anchor moved
  across a commit, S stale slot height while quiet, L a mounted row
  disagreeing with its slot at the post-runtime ResizeObserver delivery (a
  clipped or gapped paint, held or not), T height re-committed without a
  change, D destroy-once or leak failures, and X a runtime throw that is
  not the lab's own chaos render failure (or an uncaught exception).
- **demos/streaming** — the chat acceptance target, hosted on the
  runtime with native anchoring where the browser supports it: pin-to-top
  on send (I5 reserve
  plus a smooth `scrollTo`), end-follow through streams, scrollback loads
  wired to the reach signal, version branches, live tool panels.

## Browser matrix

The repository includes an opt-in Playwright runner for the dynamic-height
lab. It starts a private Vite server, exercises the lab in Chromium,
Firefox, and WebKit with automated wheel input, and fails on a lab
violation, clipped paint, teardown leak, page error, console error or
unexpected console warning, or wrong settle strategy.

Install the Playwright engines once, then run the complete matrix:

```sh
pnpm exec playwright install chromium firefox webkit
pnpm run test:browser
```

Use a focused run while developing a browser-specific fix:

```sh
pnpm run test:browser -- --quick --engine=webkit
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

## Development and verification

After code changes, run `pnpm run check`, `pnpm test`, and the relevant browser
regressions. The profiling tools also have a portable check:
`pnpm run test:firefox-profile`.

For performance investigations, start with the
[Firefox-first profiling workflow](firefox-profiling.md). Use comparable
baseline and repeat captures on the reported display. Automated wheel tests
check correctness, but do not reproduce native trackpad release or prove smooth
physical presentation. Preserve captures locally under ignored
`browser-artifacts/`, and close the test processes you start.

## Lessons carried as law

Earlier implementations and browser testing established these constraints:

- jsdom has no layout engine: engine lifecycles, in-canvas measurement, and
  native scroll anchoring are validated in real browsers (the lab and the
  runtime regressions), never asserted from jsdom. jsdom reports
  `overflow-anchor` as supported, so the unit suites run with
  `anchoring: "runtime"` except the native-surface tests.
- WebKit floors scrollTop writes; Safari kills momentum on writes; Firefox
  keeps a pre-apply scroll-limit snapshot for the rest of a gesture
  (ghost end) — reasons to preserve the controller's engine-specific contracts.
- Estimates are a scrollbar courtesy, not geometry: an earlier ghost-top bounce
  came from letting estimate error into live scroll space.
