# virtual-list

`virtual-list` is a dynamic-height virtualizer for chat-style interfaces: a
native scrolling viewport, rows of unknown and changing height, streaming
content, and scrollback loading. The runtime rests on two cornerstones:

- **Settle detection** (`src/scroll-settle.ts`): per-engine heuristics that
  identify when a user gesture has likely finished, so structural changes to
  the scroller can land while nothing is moving.
- **Premeasurement** (`src/premeasure.ts`): rows are rendered and measured
  off the scroller before they ever enter it, so committed geometry is
  rounded to a stable pixel grid, never estimated and corrected later.
  Stacked rows use whole CSS pixels at integer display scales, including 2x.
  Hosts can supply declared heights instead of measuring rows.

The contract, its invariants (I0–I6), and the design decisions live in
[`docs/core-contract.md`](docs/core-contract.md). This file covers running, using,
and testing the code.

The [streaming integration release plan](docs/streaming-integration-plan.md)
tracks the implemented consumer examples and companions, verification
evidence, and remaining release gates.

Start with the [streaming consumer guide](docs/streaming-consumer.md) and
`/examples/streaming-basic/` for the small runtime-only example, or
`/examples/streaming-paged/` for live updates and optional pin trimming through
the paging companion. `/examples/streaming-markdown/` adds a renderer and
autosizing composer through the separate UI integration layer.

## Run the demos

```sh
pnpm install
pnpm run dev
```

- `/demos/scroll-settle/index.html` — the settle lab: verify the settle
  signal and settle-time structural commits in every browser.
- `/demos/dynamic-height/index.html` — the dynamic-height lab: adversarial
  size-changing content on the runtime; the panel reports contract
  violations observed from outside the runtime, and its chaos checkbox runs
  a randomized adversary (the browser matrix drives it with `--chaos` and
  `--seed`).
- `/demos/streaming/index.html` — the streaming chat, the acceptance target:
  send flow with pin-to-top, smooth end-follow through streams, scrollback
  loading in an in-flow edge slot, message versions, day separators with a
  sticky header, tool panels, a lossless Markdown export and import (the
  download and upload icons, or drop a transcript on the chat; import
  replaces the separately stored OpenAI or simulated history), a settings
  dialog whose General section holds the autoscroll
  mode (follow to the end, or stop when the reply's start reaches the top),
  theme, scrollback loader style, and sticky day headers, and an optional
  real OpenAI
  provider (key stored in this browser only; tool panels are live there and
  canned under the simulated provider). `?stream=instant` (or `?instant`)
  removes the simulated token delays, `?stream=fast-long` (or `?fast-long`)
  streams a long reply quickly. Every product choice (the scrollback
  loader, sticky day headers, autoscroll, where a conversation opens, the
  streaming cursor) lives in the settings dialog's General section and
  persists in the browser; URL parameters are for test and debug flags
  only.
  The built-in simulated history is dated through yesterday; new sends use
  the current time, so the first new turn starts a **Today** section.
  Both providers preserve history across reloads, including branch selection
  and stopped responses. The floating conversation tree uses equal-width
  version bands, response-section links, and smooth reveal for clipped tree
  items. See [conversation tree navigation](docs/conversation-tree-navigation.md)
  for layout rules, the runtime-owned bottom position, and browser regressions.

- `/demos/gallery/index.html` — the gallery: the same photos as
  justified rows or individually positioned whole-photo masonry items, with
  declared geometry, so the runtime never measures them. A
  width, size, or layout change names its anchor (`anchor: { key,
  offset }`): the item now holding the point under the viewport top, at
  the offset that keeps it there. Images load through a loader fed by the
  mount hooks — nearest first, under a concurrency limit chosen in the
  header, abandoned when their element leaves the scroller — and the
  header shows its metrics. A soft 480-photo window trims distant pages and
  restores them on backward scrolling. See [bounded paging](docs/bounded-paging.md)
  for the reusable companion and layout-continuity contract.

- `/demos/chat-history/index.html` — 10,000 numbered messages with day
  headers and bounded, two-way paging. The simulated indexed source creates
  only the requested 64-message page; the pager retains a soft limit of 192
  messages and the runtime mounts only the visible window plus overscan.
  Enter a message number such as **853** to fetch one page around that
  target, without loading the intervening history. **Smooth** jumps animate
  inside that fetched page; **Instant** jumps land directly. **Top** and
  **Bottom** address the whole archive, not just the loaded window.

Serve with `pnpm run dev -- --host` to open the demos on a phone or tablet.
The dynamic-height lab can POST its trace to the dev server
(`/__lab/report`), which appends it to `browser-artifacts/device-*.log`, one
file per user agent.

## Runtime

Everything under `src/`:

- `virtual-list.ts` — the runtime. Owns the viewport's canvas and row slots,
  prepares snapshots off the scroller, commits them atomically when the
  scroller is idle (or, under `"live"`, at once when no scroll write is
  needed), reconciles the mounted window on every scroll, and runs commands.
- `geometry.ts` + `fenwick.ts` — the pure keyed geometry kernel: capture →
  mutate → resolve transactions, anchor policies, the pin-to-top reserve.
- `premeasure.ts` — the detached measurer, width-synced to the viewport.
- `snapshot.ts` — DOM-independent key validation, anchor inheritance,
  superseded-row selection, and merging targeted patches into held snapshots.
  The runtime coordinates DOM effects, measurement, and commit scheduling.
- `render-state.ts` — provisional render state and the preparation rollback
  journal. The runtime owns fresh elements, measurement, and final adoption;
  the journal accepts successful in-place updates or restores touched rows.
- `follow.ts` — chat follow intent, reply-start limits, and catch-up policy
  after visibility changes. It reads geometry through a small host interface;
  the runtime owns glides and scroll writes.
- `reach.ts` — edge-load hysteresis and cancellation. Disposal during a reach
  or abort callback prevents further loads from starting.
- `paging.ts` — bounded source pages, opaque edge cursors, deduplication,
  cancellation, and protected-window trimming through `updateWindow`.
- `scroll-settle.ts` — the settle controller: gesture classification,
  programmatic-write matching, per-engine settle strategies (`chromium-wheel`,
  `firefox-wheel`, `safari-wheel`, and the plain `default`), chosen by engine
  from the user agent; an unknown engine gets the Firefox contract.
- `wheel-policy.ts` — Firefox release classification and Chromium wheel
  suppression state. Only the selected engine's policy is instantiated;
  shared input listeners and settle scheduling remain in the controller.
- `glide.ts` — the programmatic smooth scroll: a fixed landing leg (the last
  viewport of travel, always the same time and ease-out) after a distance-
  derived approach, so a one-viewport hop and a jump across the list arrive
  identically; exact landing, at least a pixel per frame, live target,
  endpoint rebase.

## Public API

```ts
import { createVirtualList } from "./src/virtual-list";

const list = createVirtualList(viewport, {
  items,
  key: (item) => item.id,
  render: (item, existing) => element,
  overscanPx: 600,
  pinning: true, // false: clamp commands to content without trailing pin space
  scrollingUpdates: "live", // | "same-height" | "freeze"
  followBehavior: "smooth", // | "instant"
  followMode: "end", // | "keep-start": stop when the last row's top reaches the viewport top
  followInset: 0, // px kept clear above that row under "keep-start"
  edgeSlots: { start: { key: "loader", height: 52, render } },
  onState: (state) => {},
  onViewport: ({ scrollTop, height }) => {},
  onReachStart: ({ signal }) => loadOlder(signal),
  onReachEnd: ({ signal }) => loadNewer(signal),
  onDestroy: (element) => {},
  anchorable: (item) => item.kind !== "day", // separators never anchor
  settleStrategy: undefined, // detected from the user agent
});

list.setItems(items, { anchor: "auto" }); // | "viewport" | "end" | "none"
list.updateItem(key, nextItem); // same key, same anchor options as setItems
await list.scrollTo(key, { align: "start", behavior: "smooth", duration, offset });
await list.scrollTo("end", { behavior: "smooth" });
await list.scrollTo("end", { pin: { key, offset: 44 } });
list.remeasure(key, { anchor: "viewport" });
list.setEdgeSlot("start", slot | null);
list.setFollowMode("keep-start", 44);
list.positionOf(key); // { top, height } | null, committed positions only
list.elementOf(key); // the mounted element | null
list.state; // { count, start, end, atStart, atEnd, following, totalSize, held }
list.dispose();
```

- `setItems` hands over a whole snapshot; new and replaced rows are rendered
  and premeasured off the scroller, and the commit is one atomic write.
  During a scroll the snapshot waits for the settle, except, under
  `"live"`, what needs no scroll write: same-key updates, and structural
  changes confined below the anchor (an appended message, a version switch).
- `updateItem(key, item, { anchor? })` replaces one item's data. The key must
  stay the same; unknown keys are ignored. It prepares only that item,
  including when a snapshot is held. After successful preparation, it patches
  the held snapshot without copying its items or rebuilding its key order.
  Untouched pending rows and the anchor policy are preserved; an explicit
  anchor overrides the pending policy.
- `updateWindow(update, signal?)` evaluates an update at idle against the
  current protected window, then commits additions and trimming together.
  See [bounded paging](docs/bounded-paging.md) for its lifecycle and companion.
- With `height(item)`, heights must be finite and positive. The runtime
  keeps data and heights for every item, but renders only the overscan
  window. Leaving that window calls `onUnmount` and `onDestroy`; re-entry
  calls `render` without an existing element, then `onMount`. Keep state
  that must survive scrolling in item data. Unknown-height rows retain
  their measured elements as before.
- For viewport-scoped row styles, pass `measurementContainer`: an element
  outside the scroll surface with the same typography, CSS variables, and
  ancestor classes. The hidden measurement root inherits from that element.
  The default is `document.body`; width matching alone does not reproduce
  styles scoped to a viewport ancestor.
- `pinning` defaults to `true`. Set `pinning: false` for a history or feed
  view: keyed alignment clamps to the content's scroll range, end commands
  land at the content bottom, and end-command `pin` requests are ignored.
  Temporary space needed to preserve a reading anchor during content changes
  still drains safely after scrolling. The chat-history demo uses this option.
- Use `pinning: { match: (item) => item.role === "user", offset: 40 }` for
  declarative chat pinning. The runtime always reserves enough space to
  scroll the last matching item to its inset, including after branch
  replacement, manual scrolling, content shrinkage, or viewport resizing.
  No match means no pin. Commands navigate without replacing this pin;
  `align: "start"` and end-command `pin` cannot select another target.
  The predicate runs during snapshot preparation, not on scroll frames.
  The offset defaults to zero, including non-finite values. It is read with
  each snapshot; use a getter for a live inset and submit a snapshot when it
  changes. Held updates retain the key and offset captured during preparation.
- With boolean `pinning: true`, `scrollTo` with `align: "start"` pins a key to
  the viewport top and reserves the shortfall below (a chat's send flow);
  `offset` lands it below a floating header. Realigning a pin removes unused
  trailing space
  after landing, without shortening the scroll range during the glide.
  A smooth command is interrupted by genuine user
  input and resolves `false`; a command to `"end"` re-engages end-follow.
- `scrollTo("end", { pin: { key, offset? } })` establishes a persistent pin
  and lands at the end in one command, without first scrolling to the pinned
  row. A short tail leaves that row at its inset; a long tail lands at the
  content's end. An older pin's unused reserve drains after landing. The
  offset defaults to zero; non-finite offsets use zero. A missing pin key
  resolves `false`. Supplying `pin` with a non-end target rejects the command.
- `remeasure` is the intent-bearing path for a discrete user interaction
  that changes a row's height (opening a tool panel): it keeps the viewport
  anchored instead of re-gluing an end-positioned transcript.
- Edge slots are fixed-height host rows kept at the surface's edges — a
  scrollback loader in the flow — that are geometry but never the anchor.
- `anchorable` says which items may be the reading anchor. A separator
  (a day header) should say no: the anchor falls to the message under it,
  so a scrollback load that extends its day above it leaves that message
  where it was instead of following the header up.

`demos/shared/sticky-headers.ts` is a companion that floats the current
section header over the viewport using only `positionOf`/`elementOf`.
Use `onState` to refresh its committed geometry, and `onViewport` to update
its position from the supplied scroll snapshot. `onViewport` runs after
reconciliation when the scroll position or viewport height changes, including
boot and each programmatic glide step, even within an unchanged mounted range.
It lets scroll-linked UI move in the same frame without another layout read.

Rendering failures clean up newly created elements and preserve internal
ownership. In-place render rollback is best effort: the runtime cannot undo
arbitrary DOM mutations or external side effects. For stronger isolation,
return a fresh element instead of mutating `existing`. Failed initialization
removes the runtime's DOM, observers, and listeners before rethrowing.

When a disposed list is replaced on the same WebKit viewport, the runtime
schedules one scrolling-layer repaint. This repairs stale paint after a
replacement, including file-drop imports. First mounts and ordinary item
updates do not force this repaint. Disposal cancels pending recovery; new
input or an active glide suppresses it. The recovery preserves inline
overflow styles and does not issue scroll-position writes.

## Validation

Use the [Firefox-first profiling workflow](docs/firefox-profiling.md) before
making performance changes. It captures native macOS scrolling in the installed
Firefox on the affected monitor, with isolated runs and local artifacts.

```sh
pnpm run check   # Biome + TypeScript
pnpm test        # vitest, jsdom, deterministic
pnpm run test:regression           # All feature-grouped browser regressions
pnpm run test:regression -- --group=gallery
pnpm run test:regression -- --list # List groups and scripts without launching browsers
pnpm run test:regression-runner    # Portable suite-runner checks
pnpm run test:browser              # Chromium, Firefox, WebKit via Playwright
pnpm run test:browser -- --suite=chat --engine=webkit
pnpm run test:browser -- --chaos=300 --seed=7 --headed
pnpm run test:regression -- --group=history
pnpm run test:regression -- --match=sticky-header
```

The [regression suite](docs/regression-suite.md) groups browser checks by feature
under `scripts/regressions/`, starts its own local server, and reports failures
across the selected scripts. `test:chat-tree` is an alias for the tree group.
Benchmarks and native Firefox profiling remain separate from correctness tests.

The unit suite drives the real settle controller and the real runtime
against a controllable jsdom harness (a scripted `ResizeObserver`, fake
timers, an engine-like scroll clamp), plus oracle and property tests for the
geometry kernel and characterization tests for the glide. The browser matrix
runs the dynamic-height lab in the three real engines and fails on any
contract violation the lab reports, then the streaming chat's product-level
invariants (`scripts/chat-invariants.mjs`: across a scrollback load, on an
undated and on dated single-day conversations, the row under a fixed
viewport point keeps its screen position); device runs (iPad, iPhone) are
done by hand with the trace channel above.
