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

`next` keeps the physics layer unchanged and rebuilds orchestration on three
ideas.

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
during a gesture and commit only when the list is idle.

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

### API changes

`next` removes three options and keeps the rest of the API:

| Removed | Reason |
| --- | --- |
| `scrollingUpdates` | One commit rule (F1). The option is accepted and ignored. |
| `measurementContainer` | Rows are measured in the viewport itself (F2). |
| `prepareDuringScroll` | Idle-time page preparation is always on. |

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

To try the demos on `next`, run `pnpm run dev:next` and open
`http://localhost:5174/demos/streaming/`. It uses port 5174 and its own
dependency cache, so it runs beside your `pnpm run dev` server on `main`'s
runtime.

To run the browser checks on `next`, point them at a `next` server:

```sh
pnpm exec vite --config vite.next.config.ts --host 127.0.0.1 --port 4273 --strictPort
BROWSER_MATRIX_URL=http://127.0.0.1:4273 pnpm run test:browser -- --suite=chat
BROWSER_MATRIX_URL=http://127.0.0.1:4273 pnpm run test:browser -- --suite=lab --mode=live
BROWSER_MATRIX_URL=http://127.0.0.1:4273 pnpm run test:regression
BROWSER_MATRIX_URL=http://127.0.0.1:4273 node next/regressions/hidden-row-regression.mjs
```

### Contract parity

`vitest.next.config.ts` runs `src/`'s own contract suite,
`tests/unit/virtual-list.test.ts` (384 tests), against `next`. Its harness
default is switched from `same-height` to `live`, the rule `next` keeps.
**359 pass.** The 25 exclusions are listed with reasons in
[`tests/parity.ts`](tests/parity.ts):

- 15 pin the old modes' held semantics. They also fail on `src/` once the
  harness runs in `live`.
- 5 request a removed mode or option.
- 5 assert the detached measurement root or wrapper release that F2
  replaces.

`next/tests/foundation.test.ts` covers what `next` adds: hidden in-canvas
staging, reveal without re-parenting, the offscreen resident, the post-commit
sweep, DOM order, the one commit rule, and the pass.

### Browser verification

These runs used the Playwright engines (Chromium, Firefox, WebKit) against a
private `next` server. They are correctness evidence, not native-input or
physical-smoothness evidence.

- **Chat invariants:** zero violations and zero errors in all three
  engines.
- **Dynamic-height lab (live mode, full scenario):** zero violations and
  zero clipped paints in all three engines.
- **Feature regression suite (95 scripts):** 87 pass. The other 8 are 7 scripts that fail the same way on `main` and
`runtime/hidden-measurement`, which asserts the detached measurement root
that F2 removes.
- **Hidden-row regression:** the `next` variant of
  `runtime/hidden-measurement`
  ([`regressions/hidden-row-regression.mjs`](regressions/hidden-row-regression.mjs))
  passes in all three engines.

The runs found and fixed eight defects in `next`, including hidden rows that
were findable, focusable, or under the viewport for rect queries, and DOM
order that diverged from list order.
The [verification report](../docs/reports/virtual-list-next-2026-09-23.md)
lists them.

### Measurements

The orchestration layer shrinks from 3,910 to 2,650 lines (−32%), or from
2,840 to 2,333 code lines (−18%). The physics modules are shared.

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
anchoring at rest, which is the premise of research track 1 below.

## 5. Roadmap

These items were considered and not built. Each needs evidence this branch
can't produce on a desk.

1. **Native scroll anchoring (research).** Safari 27 enables CSS scroll
   anchoring, so all three engines now anchor natively. A flow-layout list
   with `overflow-anchor` could hand anchoring and compensation to the
   engine, possibly removing the geometry kernel's anchor resolution and
   most scroll writes. That would be the largest possible code reduction.
   It conflicts with cornerstone 1 and depends on each engine's behavior
   under momentum and at edges (Firefox's stale limit, iOS rubber-band). It
   needs a native-input spike on real devices before any adoption.
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
| `next/tests/` | Parity exclusions and foundation tests. |
| `next/regressions/` | Browser regressions specific to `next`. |
| `next/bench/` | CPU comparisons of two servers and the anchoring probe. |
| `vite.next.config.ts` | Serves the unchanged demos on `next`. |
| `vitest.next.config.ts` | Runs the contract suite on `next`. |
