# virtual-list-next

`virtual-list-next` is a new orchestration engine for the virtual list. It
keeps the parts of `src/` that encode verified browser behavior and replaces
the part that grew too heavy to change: the 3,474-line `src/virtual-list.ts`
and its helpers. The unchanged demos run on it through a module switch, so
the two runtimes can be compared side by side.

This document has three parts: a review of the current architecture, the
recommended architecture and why, and the verification and measurements for
the implementation on this branch (`virtual-list-next`).

## 1. What virtual-list is for

`virtual-list` renders long, changing lists in a **native** scroll container.
It targets chat-like interfaces. Rows have unknown and changing heights,
replies stream into the last row, and history pages load at both edges. The
product requirement is that nothing the user is reading ever moves, in
Firefox, Chrome, and Safari, including iOS momentum and rubber-band
scrolling.

That requirement is hard because the browsers disagree on one thing: what
happens when a page writes `scrollTop` while the user is scrolling. Safari
stops momentum. Firefox's async scrolling keeps a stale scroll limit for the
rest of the gesture. Chrome sends `scrollend` early at edges. The current
solution rests on three cornerstones, and all three stay in `next`:

1. **No structural change during a scroll.** Any change that needs a scroll
   write waits for the scroll to settle. A per-engine settle sensor decides
   when the scroll has settled.
2. **A small DOM.** Rows exist only in the viewport plus overscan, and
   paging bounds the retained data.
3. **Synthetic smooth scrolling with pinning.** A JavaScript "glide" drives
   commands and end-following. A trailing reserve lets the latest prompt sit
   at the top of the viewport.

## 2. Review of the current architecture

The runtime has two layers:

| Layer | Modules | Code lines¹ | Assessment |
| --- | --- | ---: | --- |
| Physics | `scroll-settle`, `wheel-policy`, `geometry`, `fenwick`, `positioned-geometry`, `glide`, `follow`, `reach`, `viewport-repaint` | 1,843 | Sound. Encodes verified engine behavior. Pure or nearly pure, and unit-tested against recorded traces. Cheap at runtime. |
| Orchestration | `virtual-list`, `snapshot`, `render-state`, `premeasure` | 2,840 | The bottleneck for change and for further performance work. |

¹ Non-blank, non-comment lines at `main` (`37a21e6`).

The profiles in `docs/reports/` agree on one point: the runtime's own
scroll path costs 0.2–0.5% of content-thread samples
([idle page preparation](../docs/reports/idle-page-preparation-2026-09-22.md)).
Micro-optimizing that path no longer pays. The remaining costs come from the
orchestration layer's structure:

1. **Every row has two DOM homes.** New rows are rendered and measured in a
   fixed, width-synced measurement root under `document.body`, then moved
   into the scroller. The move rebuilds their style and layout at mount
   time, on the commit frame. Hosts must also supply a
   `measurementContainer` so the root reproduces viewport-scoped styles.
   The code also keeps a special single-resident retention path for
   offscreen streaming rows.
2. **Three update modes multiply every path.** `live`, `same-height`, and
   `freeze` give four ways to handle a same-key change (in place, promotion,
   fresh render held for the settle, and deferred declared render). Lists
   in `freeze` (feed, gallery, chat history) hold even an append at the end
   until the settle, although it needs no scroll write.
3. **Pending work is a merged snapshot.** Held snapshots are built, merged,
   adopted, and superseded (`snapshot.ts`), with a rollback journal
   (`render-state.ts`) and a `partial` flag threading through `prepare`.
4. **Re-entrancy is a transaction stack.** Nested scopes, deferred teardown
   aggregation, and discard paths are spread over many functions.
5. **Commits have many entry points.** Commits go through `commit` (with
   five positional modes), `liveCommit`, `applyPromotions`,
   `applyDeferredDeclared`, resize, remeasure, `trimUnusedReserve`, and
   takeover, each with its own ordering.

## 3. Recommendation: the next foundation

`next` keeps the physics layer unchanged (F4) and rebuilds orchestration on
three ideas (F1–F3). Where the engine supports it, it also hands scroll
anchoring to the engine (F5).

### F1. One commit rule over a desired state

Everything the host submits becomes the **desired state**: the latest key
order, new rows already rendered and measured, and an anchor intent. A
single rule decides when it lands:

- **Now**, when the list is idle, or when every change sits at or below the
  viewport's anchor row. Such a change needs no scroll write, so nothing on
  screen moves (I1 holds by construction).
- **At the settle**, when the change moves the anchor (a prepend, a trim or
  height change above the anchor, or a reorder).

The rule has no modes. It generalizes the old `live` policy to every list
kind, including declared-height lists. Positioned (masonry) layouts can't
prove by index that a change stays below the anchor, so their structural
changes always wait for the settle. Mid-phase, a positioned card, or a
declared row whose height changes, re-renders inside the settle commit, so
it never shows new content in its old box.
`updateItem` patches the desired state in place in O(1). There is no
snapshot merge, promotion, or `partial` flag. Window jobs (`updateWindow`,
which the paging companion uses) keep their `main` semantics: they prepare
during a gesture and commit only when the list is idle. Native anchoring
(F5) relaxes both rules away from the scroll edges. A job whose source
items change in place (a streamed token) keeps staging, and its commit is
still cancelled, so the companion retries against current data. The retry
adopts the rows the cancelled job staged, so a page lands while a reply
streams instead of restarting on every token.

### F2. Rows are measured where they mount

A new or replacing row is rendered into its own clip slot **inside the
canvas**. While it waits there, the slot is hidden, zero-height, clipped,
`inert`, and `aria-hidden`, and parked above the scroll origin, where no
rect query or scroll position can reach it. The row is laid out once, with the page's real
styles, and it neither paints nor changes the scroll range. When it commits
inside the window, the runtime reveals the same slot in place: no second
layout and no re-parenting. When it commits outside the window, the slot
detaches, as offscreen rows always did. A lone row updated offscreen, such as
a streaming reply the user scrolled away from, stays laid out between tokens.

This removes `premeasure.ts`, the `measurementContainer` option, width
syncing, and the resident special case. Row wrappers now stay with their row
for its whole life instead of being recreated on every remount.

Slots join the canvas next to their nearest connected list neighbor, so DOM
order always equals list order. `src/` appends slots in mount order, which
reverses reading and Tab order for rows entering from above.

### F3. One pass

Every entry point runs inside one function, `pass`: an API call, a scroll
event, an observer delivery, a settle, a glide frame, or a window job.
Nested calls join the open pass. API calls from host callbacks queue behind
it and drain afterwards, each as its own pass. Host callback failures are
collected and thrown once the runtime has reached a consistent state. This
replaces the transaction stack with about 50 lines.

### F4. Keep the physics

The settle sensor, the geometry kernel (anchoring, the pin reserve, I0–I5),
the glide, follow intent, and reach hysteresis are imported from `src/`
unchanged. They encode engine behavior verified on real hardware, including
the Firefox, Chrome, and Safari edge battery. Replacing them needs that
battery again, not a rewrite on a desk (see [Roadmap](#5-roadmap)).

### F5. Native scroll anchoring where the engine has it

Chromium, Firefox, and Safari 27 implement CSS scroll anchoring: when content
above the reading position changes, the engine itself moves the scroll
position, inside its own scroll machinery, so no page `scrollTop` write
reaches a running gesture. Where it's available, `next` uses it, and
cornerstone 1 relaxes. Mid-gesture, away from the edges, a prepend or a
height change above the reader lands at once, and the engine keeps the
reader still. Where it isn't available, the settle rule of F1 applies
unchanged.

The `anchoring` option chooses the mode:

| Value | Behavior |
| --- | --- |
| `"auto"` (default) | Native where `CSS.supports("overflow-anchor", "auto")` holds and the scroller doesn't compute to `overflow-anchor: none`. Otherwise runtime. |
| `"native"` | Native. |
| `"runtime"` | Settle-gated runtime writes (F1), as on `main`. |

Positioned (masonry) layouts always use the runtime. The canvas records the
mode in `data-anchoring`. The feed, gallery, dynamic-height lab, and
scroll-settle demos set `overflow-anchor: none` on their scroller, so they
keep runtime anchoring in `auto` mode. The streaming demo uses native
anchoring.

In native mode, the surface is a flow layout that reproduces the committed
geometry exactly:

- **Rows sit in normal flow between two spacers.** The top spacer is as tall
  as the offset of the first mounted row, and the bottom spacer holds the
  rest of the total size. Each slot has its exact committed height.
- **Only rows can be the anchor.** Spacers, staged slots, edge slots, and
  items the host marks as not `anchorable` carry `overflow-anchor: none`.
  So does each row element, so the engine anchors on the slot, which
  survives a re-render.
- **Staged rows wait in flow.** A staged slot is zero-height, relative,
  hidden, and inert. Its row is parked with `translate: 0 -100000px`, still
  laid out at the slot's width. A reveal sets the slot's height and clears
  the translate. It never changes `position`.
- **A commit keeps the current window mounted in the new geometry** and
  reconciles the window afterwards, so the engine's anchor node survives the
  change. An earlier revision mounted the new window first, and Firefox
  lost the adjustment.
- **The runtime doesn't write mid-gesture.** It records the position it
  expects, so the settle sensor doesn't read the engine's own adjustment as
  user input. Mid-gesture commits also leave the canvas `min-height` floor
  alone.

The settle rule still applies in three cases:

- **Within 2 px of an edge.** A rubber-band bounce, Firefox's stale scroll
  limit, and an early `scrollend` all live there.
- **During a glide.** A glide heads for a target in the committed snapshot,
  so held work waits for its landing, as on `main`. Without this rule, a
  "scroll to top" glide kept heading for the new start after each older
  page landed, and one press loaded the whole history.
- **For window jobs with an explicit or end anchor.** The engine only keeps
  the viewport's own content still.

A probe of all three engines
([`bench/anchoring-structure-probe.mjs`](bench/anchoring-structure-probe.mjs))
found two changes that suppress the adjustment they cause, which ruled out
simpler designs:

- Revealing an absolutely positioned staging slot in flow, a `position`
  change.
- A `min-height` change on the canvas, an ancestor of the anchor.

These changes anchor correctly in all three engines: spacer height changes,
slots inserted above the viewport, a height change of a zero-height slot,
removing a hidden absolute slot, and replacing the slot of a partly visible
row.

### API changes

`next` removes three options, adds one, and keeps the rest of the API:

| Change | Option | Reason |
| --- | --- | --- |
| Removed | `scrollingUpdates` | One commit rule (F1). The option is accepted and ignored. |
| Removed | `measurementContainer` | Rows are measured in the viewport itself (F2). |
| Removed | `prepareDuringScroll` | Idle-time page preparation is always on. |
| Added | `anchoring` | Native or runtime anchoring (F5). |

Every other option, method, callback, and companion (`createPagedWindow`,
sticky headers, reading anchors) works unchanged. The demos run on `next`
without modification.

## 4. Verification

Run the static checks and both unit configurations on this branch:

```sh
pnpm run check      # Biome and TypeScript, including next/
pnpm test           # src/ suites; src/ is unchanged
pnpm run test:next  # the src/ contract suite and next's own tests, on next
```

To try the demos on `next`, run one of these servers. Each has its own port
and dependency cache, so both run beside your `pnpm run dev` server on
`main`'s runtime:

| Command | Anchoring | Demos |
| --- | --- | --- |
| `pnpm run dev:next` | Native where supported (`auto`) | `http://localhost:5174/demos/streaming/` |
| `pnpm run dev:next:runtime` | Runtime (F1), as on `main` | `http://localhost:5175/demos/streaming/` |

The servers set the default mode through `VITE_VL_ANCHORING`. An explicit
`anchoring` option still wins.

To run the browser checks on `next`, point them at a `next` server:

```sh
pnpm exec vite --config vite.next.config.ts --host 127.0.0.1 --port 4273 --strictPort
BROWSER_MATRIX_URL=http://127.0.0.1:4273 pnpm run test:browser -- --suite=chat
BROWSER_MATRIX_URL=http://127.0.0.1:4273 pnpm run test:regression
BROWSER_MATRIX_URL=http://127.0.0.1:4273 node next/regressions/hidden-row-regression.mjs
BROWSER_MATRIX_URL=http://127.0.0.1:4273 node next/regressions/native-anchoring-regression.mjs
BROWSER_MATRIX_URL=http://127.0.0.1:4273 node next/regressions/native-glide-regression.mjs
BROWSER_MATRIX_URL=http://127.0.0.1:4273 node next/regressions/stream-paging-regression.mjs
BROWSER_MATRIX_URL=http://127.0.0.1:4273 pnpm run test:browser -- --suite=lab --mode=live
```

To check the runtime fallback of the streaming demo as well, start the
server with `VITE_VL_ANCHORING=runtime`.

### Contract parity

`vitest.next.config.ts` runs `src/`'s own contract suite,
`tests/unit/virtual-list.test.ts` (384 tests), against `next`. Its harness
default is switched from `same-height` to `live`, the rule `next` keeps.
**358 pass.** The 26 exclusions are listed with reasons in
[`tests/parity.ts`](tests/parity.ts):

- 15 pin the old modes' held semantics. They also fail on `src/` once the
  harness runs in `live`.
- 5 request a removed mode or option.
- 5 assert the detached measurement root or wrapper release that F2
  replaces.
- 1 pins that an in-place item update stops a staged page at once. `next`
  keeps staging and lets the retry adopt the rows.

`next/tests/foundation.test.ts` covers what `next` adds: hidden in-canvas
staging, reveal without re-parenting, the offscreen resident, the post-commit
sweep, DOM order, the one commit rule, the pass, and a page landing while a
reply streams.
`next/tests/native.test.ts` covers the native surface: spacers that reproduce
committed geometry, a mid-gesture prepend without a scroll write, the settle
rule at an edge and during a glide, and the host's opt-out.

jsdom reports `overflow-anchor` as supported but lays nothing out, so the
contract suite and the foundation tests run with `anchoring: "runtime"`.

### Browser verification

These runs used the Playwright engines (Chromium, Firefox, WebKit) against a
private `next` server in `auto` mode, which anchors natively in all three.
They are correctness evidence, not native-input or physical-smoothness
evidence.

- **Chat invariants:** zero violations and zero errors in all three
  engines, with native anchoring and with runtime anchoring.
- **Dynamic-height lab (live mode, full scenario):** zero violations and
  zero clipped paints in all three engines. The lab's page opts out of
  native anchoring, and the lab can't observe native mode: it reads slot
  geometry from `translateY` offsets, which native slots don't have.
- **Feature regression suite (95 scripts):** 87 pass. The other 8 are 7
  scripts that fail the same way on `main` and
  `runtime/hidden-measurement`, which asserts the detached measurement root
  that F2 removes.
- **`next` regressions:** the hidden-row, native-anchoring, native-glide,
  and stream-paging regressions in [`regressions/`](regressions/) pass in
  all three engines.
  The native-anchoring regression lands an older page mid-gesture with zero
  script scroll writes and a reader drift of at most 1 px.

The runs found and fixed eleven defects in `next`. Examples: hidden rows
that were findable, focusable, or under the viewport for rect queries, a
"scroll to top" glide that loaded the whole history under native anchoring,
native anchoring overriding a host's `overflow-anchor: none`, and older
pages that couldn't load while a reply streamed. The
[verification report](../docs/reports/virtual-list-next-2026-09-23.md)
lists them.

### Measurements

The orchestration layer shrinks from 3,910 to 3,010 lines (−23%), or from
2,840 to 2,593 code lines (−9%). The physics modules are shared. Native
anchoring (F5) accounts for 292 of those lines (209 code lines). It adds to
the runtime path rather than replacing it, because the runtime remains the
fallback. Keeping staged rows for a paging retry adds 68 (51 code lines).
The first commit, without either, was 2,650 lines and 2,333 code lines
(−32% and −18%).

The headless CPU benchmarks in [`bench/`](bench/) put `next` within ±10%
of `main`:

- **Faster:** streaming tokens (−4% in every engine), appends that land in
  view (−11% in Chromium), and scrolling into a just-committed page (−12% in
  Chromium).
- **Slower:** large offscreen batches, such as boot or an idle prepend of 60
  rows (+5–9%). The cost comes from `inert` staging slots and detaching the
  rows that land offscreen.

The runtime's own CPU was never the bottleneck: 0.2–0.5% of samples on
`main`. The gains of this foundation are in behavior, not in CPU:

- **Changes below the anchor land during a gesture in every stacked list.**
  Lists that used `freeze` on `main` (the feed, the gallery's justified
  rows, and the chat history) no longer hold a same-key update or an
  append submitted through `setItems` or `updateItem` until the settle.
  Pages from `updateWindow` still wait for idle, as on `main`.
- **Rows that commit in view skip their second layout.**
- **DOM order always follows list order.**

Physical smoothness still needs the native Firefox profile and a device
check. See the
[report's next steps](../docs/reports/virtual-list-next-2026-09-23.md#next-steps).

A probe ([`bench/anchoring-probe.mjs`](bench/anchoring-probe.mjs)) confirms
that Chromium 153, Firefox 155, and WebKit 26.6 all perform native scroll
anchoring at rest, the premise of F5. The CPU benchmarks predate F5.

## 5. Roadmap

These items were considered and not built. Each needs evidence this branch
can't produce on a desk.

1. **Native anchoring only.** F5 hands mid-gesture compensation to the
   engine but keeps the runtime path for edges, glides, explicit anchors,
   and engines without support. If real-device runs show native anchoring
   holds under momentum and at edges (Firefox's stale limit, iOS
   rubber-band), the runtime path and the geometry kernel's anchor
   resolution could go for browsers that anchor natively. That is the
   largest remaining code reduction. It needs the Firefox native profile
   and a device check of `dev:next` against `dev:next:runtime` first.
2. **Row residency.** Keep recently unmounted rows laid out but hidden in a
   band beyond the overscan, so re-entry during back-and-forth scrolling
   avoids a full relayout. A band for staged rows only was measured and
   reverted: it didn't speed up scrolling into a new page, and it exposed
   hidden rows to host DOM queries. A band for unmounted rows is untested;
   measure Safari layer counts and memory first.
3. **Compositing hints.** Per-slot `will-change: transform` creates a layer
   per mounted row. It was added for Safari 27 shifts. Re-test against a
   single canvas layer on the user's display.
4. **Settle sensor consolidation.** Express the per-engine release rules
   over one input model. Only with the user's real-hardware edge battery.
5. **API trims.** Model edge slots as ordinary items with per-item declared
   heights, and re-evaluate `updateWindow` at commit instead of cancelling
   stale staged work. Each changes demo code or pinned semantics.

## 6. Layout

| Path | Contents |
| --- | --- |
| `next/src/virtual-list.ts` | The engine. |
| `next/src/types.ts` | Public types. |
| `next/src/index.ts` | Entry point. |
| `next/tests/` | Parity exclusions, foundation tests, and native-surface tests. |
| `next/regressions/` | Browser regressions specific to `next`. |
| `next/bench/` | CPU comparisons of two servers and the anchoring probes. |
| `vite.next.config.ts` | Serves the unchanged demos on `next`. |
| `vitest.next.config.ts` | Runs the contract suite on `next`. |
