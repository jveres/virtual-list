# virtual-list

`virtual-list` is a dynamic-height virtualizer for chat-style interfaces: a
native scrolling viewport, rows of unknown and changing height, streaming
content, and scrollback loading. The runtime rests on two cornerstones:

- **Settle detection** (`src/scroll-settle.ts`): per-engine heuristics that
  identify when a user gesture has likely finished, so changes that need a
  scroll write can land while nothing is moving.
- **Measurement before reveal** (`src/virtual-list.ts`): a new or replacing
  row is rendered into its own hidden, zero-height slot inside the scroll
  canvas and measured there with the page's real styles. The runtime then
  reveals the same slot in place. Committed geometry is rounded to a stable
  pixel grid, never estimated and corrected later. Stacked rows use whole
  CSS pixels at integer display scales, including 2x. Hosts can supply
  declared heights instead of measuring rows.

Where the browser supports CSS scroll anchoring, the runtime lets the browser
keep the reader still when content above the viewport changes (the
`anchoring` option). The [architecture](docs/architecture.md) explains this
design and why it replaced the earlier runtime.

See it running on GitHub Pages:

- [All `virtual-list` demos](https://jveres.github.io/virtual-list/)
- [Streaming chat](https://jveres.github.io/virtual-list/demos/streaming/index.html):
  pin-to-top send flow, smooth end-follow streaming Markdown, bounded scrollback,
  message versions, and sticky day headers.
- [Gallery](https://jveres.github.io/virtual-list/demos/gallery/index.html),
  [Feed](https://jveres.github.io/virtual-list/demos/feed/index.html),
  [Newspaper](https://jveres.github.io/virtual-list/demos/newspaper/index.html),
  [Chat history (10k messages)](https://jveres.github.io/virtual-list/demos/chat-history/index.html),
  [Dynamic-height lab](https://jveres.github.io/virtual-list/demos/dynamic-height/index.html), and
  [Scroll-settle lab](https://jveres.github.io/virtual-list/demos/scroll-settle/index.html).

The contract, its invariants (I0–I6), and the design decisions live in
[`docs/core-contract.md`](docs/core-contract.md). This file covers running, using,
and testing the code.

The [streaming integration release record](docs/streaming-integration-plan.md)
documents the implemented consumer examples and companions, verification
evidence, and the integration's first source release, `v0.2.0`. This README
describes the current checkout, including APIs added in later tags.
Historical measurements and audits are listed in the
[verification report index](docs/reports/README.md).

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
  mode (follow to the end, stop at the reply's start, or let leading tool
  calls scroll out and stop at the answer text),
  theme, scrollback loader style, and sticky day headers, and an optional
  real OpenAI
  provider, through **OpenAI API token** or **OpenAI Subscription**
  (tool panels are live there and
  canned under the simulated provider). `?stream=instant` (or `?instant`)
  removes the simulated token delays, `?stream=fast-long` (or `?fast-long`)
  streams a long reply quickly. Every product choice (the scrollback
  loader, sticky day headers, autoscroll, where a conversation opens, the
  streaming cursor) lives in the settings dialog's General section and
  persists in the browser; URL parameters are for test and debug flags
  only.
  The built-in simulated history is dated through yesterday; new sends use
  the current time, so the first new turn starts a **Today** section.
  Each provider preserves its separate history across reloads. The simulated
  provider also preserves branch selection. The floating conversation tree uses
  content-sized version bands, response-section links, and smooth reveal for
  clipped tree items. Each turn sits below its own parent; sibling branches
  pack around their occupied widths and heights. See
  [conversation tree navigation](docs/conversation-tree-navigation.md) for layout rules, the runtime-owned bottom position, and browser regressions.

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

- `/demos/feed/index.html` — Bluesky Discover and Lemmy posts with measured
  rows, bounded paging, and fresh-head loading.

- `/demos/newspaper/index.html` — four editorial layouts with premeasured
  blocks and viewport-prioritized images.

- `/demos/chat-history/index.html` — 10,000 numbered messages with day
  headers and bounded, two-way paging. The simulated indexed source creates
  only the requested 64-message page; the pager retains a soft limit of 192
  messages and the runtime mounts only the visible window plus overscan.
  Enter a message number such as **853** to fetch one page around that
  target, without loading the intervening history. **Smooth** jumps animate
  inside that fetched page; **Instant** jumps land directly. **Top** and
  **Bottom** address the whole archive, not just the loaded window.

Serve with `pnpm run dev -- --host` to open the demos on a phone or tablet.

For ChatGPT subscription access without a Codex process, run
`pnpm run dev --host 0.0.0.0` and select **OpenAI Subscription** in the
streaming demo. Sign in from the settings panel without copying a console
token. Read the [subscription provider guide](docs/openai-subscription-demo.md)
for device login, trusted-network requirements, and limitations.

To inspect an unpublished renderer change, build the sibling
`../markdown-viewer` checkout first. Then run
`MARKDOWN_VIEWER_LOCAL=1 pnpm exec vite --port 4194`. This preview uses a separate
dependency cache and leaves the GitHub tag pin unchanged.
The dynamic-height lab can POST its trace to the dev server
(`/__lab/report`), which appends it to `browser-artifacts/device-*.log`, one
file per user agent.

## Runtime

The runtime lives under `src/`:

- `index.ts` — the public entry point: `createVirtualList` and the public
  types.
- `types.ts` — the public option, state, and command types.
- `virtual-list.ts` — the runtime. Owns the viewport's canvas and row slots,
  renders and measures new rows in hidden slots inside the canvas, and lands
  each change by one commit rule: at once when the list is idle or when
  nothing above the viewport's anchor row changes, and otherwise at the
  settle (or mid-gesture under native scroll anchoring, away from the scroll
  edges). It reconciles the mounted window on every scroll and runs
  commands.
- `geometry.ts` + `fenwick.ts` + `key-index.ts` — the pure keyed geometry
  kernel: capture → mutate → resolve transactions, shared immutable key orders,
  anchor policies, and the pin-to-top reserve.
- `declared-items.ts` — snapshot and patch storage for declared-height items,
  sharing the key index and landing snapshot heights on the geometry in one
  pass.
- `positioned-geometry.ts` — geometry for host-positioned (masonry) layouts
  with declared placement.
- `follow.ts` — chat follow intent, reply-start limits, and catch-up policy
  after visibility changes. It reads geometry through a small host interface;
  the runtime owns glides and scroll writes.
- `reach.ts` — edge-load hysteresis and cancellation. Disposal during a reach
  or abort callback prevents further loads from starting. A fresh explicit
  edge command can retry a consumed reach when no load remains pending.
- `paging.ts` — bounded source pages, opaque edge cursors, deduplication,
  cancellation, and protected-window trimming through `updateWindow`.
- `scroll-settle.ts` — the settle controller: gesture classification,
  programmatic-write matching, per-engine settle strategies (`chromium-wheel`,
  `firefox-wheel`, `safari-wheel`, and the plain `default`), chosen by engine
  from the user agent; an unknown engine gets the Firefox contract.
- `wheel-policy.ts` — Firefox release classification and Chromium wheel
  suppression state. Only the selected engine's policy is instantiated;
  shared input listeners and settle scheduling remain in the controller.
- `native-glide.ts` — browser-owned smooth navigation and following, with
  target-confirmed completion, a fallback for missing `scrollend`, and input
  cancellation.
- `viewport-repaint.ts` — one-shot WebKit scrolling-layer recovery after a
  disposed list is replaced on the same viewport.
- `companions/` — optional helpers built on the public API: sticky headers
  (`sticky-headers.ts`), reading anchors (`reading-anchor.ts`), their default
  styles (`styles.css`), and an entry point (`index.ts`) that also exports
  the paging companion.

## Public API

Import the core from `src/index.ts`. The
[companion and UI API reference](docs/integration-api.md) documents optional
paging, sticky headers, reading anchors, and UI helpers, including their
ownership and lifecycle contracts.

```ts
import { createVirtualList } from "./src/index";

const list = createVirtualList(viewport, {
  items,
  key: (item) => item.id,
  render: (item, existing) => element,
  overscanPx: 600,
  pinning: true, // false: clamp commands to content without trailing pin space
  anchoring: "auto", // | "native" | "runtime"
  followBehavior: "smooth", // | "instant"
  followMode: "end", // | "keep-start" (row) | "keep-content" (selected element)
  followInset: 0, // px kept clear above the row or selected content start
  followStart: (item, row) => row.querySelector(".answer"), // optional, measured rows only
  edgeSlots: { start: { key: "loader", height: 52, render } },
  onState: (state) => {},
  onViewport: ({ scrollTop, height }) => {},
  onReachStart: ({ signal, complete }) =>
    loadOlder(signal).catch(reportError).finally(complete),
  onReachEnd: ({ signal, complete }) =>
    loadNewer(signal).catch(reportError).finally(complete),
  onDestroy: (element) => {},
  anchorable: (item) => item.kind !== "day", // separators never anchor
  settleStrategy: undefined, // detected from the user agent
});

list.setItems(items, { anchor: "auto" }); // | "viewport" | "end" | "none"
list.updateItem(key, nextItem); // same key, same anchor options as setItems
await list.scrollTo(key, { align: "start", behavior: "smooth", offset });
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

For measured rows, `followMode: "keep-content"` stops automatic following
when the element returned by `followStart(item, row)` reaches `followInset`
pixels below the viewport top. Return `null` while only tools or a typing
indicator exist; the list follows the end until the answer appears. Without
a selector, this mode uses the row's start. The selector is read-only and
runs with row measurements. Scroll animation frames use its cached offset.
Explicit bottom navigation still follows the end for the current reply.

- `setItems` hands over a whole snapshot. New and replaced rows are rendered
  and measured in hidden slots inside the canvas, and the commit is one
  atomic write. There are no update modes. The snapshot lands at once when
  the list is idle, or when every change sits at or below the viewport's
  anchor row (an appended message, a version switch, a streamed token),
  because it then needs no scroll write. Otherwise it waits for the settle.
  Under native anchoring, away from the scroll edges and outside a glide, a
  change above the reader also lands mid-gesture, and the browser keeps the
  reader still. An `"end"` or explicit `{ key, offset }` anchor always waits
  for the settle during a scroll.
- `anchoring` chooses who keeps the reader still when content above it
  changes. `"auto"`, the default, uses the browser's CSS scroll anchoring
  where `CSS.supports("overflow-anchor", "auto")` holds and the scroller
  doesn't compute to `overflow-anchor: none`; otherwise it uses the runtime.
  `"native"` forces the browser, and `"runtime"` forces settle-gated runtime
  scroll writes. Positioned (masonry) layouts always use the runtime. The
  canvas records the chosen mode in its `data-anchoring` attribute.
  WebKit gestures, including momentum, defer changes above the reader
  until settle even in native mode, so the runtime can preserve the reading
  position if the browser does not apply its anchor adjustment.
- `updateItem(key, item, { anchor? })` replaces one item's data. The key must
  stay the same; unknown keys are ignored. It prepares only that item,
  including when a snapshot is held. After successful preparation, it patches
  the held snapshot without copying its items or rebuilding its key order.
  Untouched pending rows and the anchor policy are preserved; an explicit
  anchor overrides the pending policy.
- `updateWindow(update, signal?, options?)` evaluates an update against the
  current protected window, then commits additions and trimming together.
  During a gesture it prepares the new rows in idle time and commits when the
  list is idle. Under native anchoring, away from the scroll edges, it also
  commits mid-gesture, unless the update names an `"end"` or explicit anchor.
  A width change rebuilds pending preparation against the new layout without
  dropping the update; the updater can be called again before its one commit.
  `options.protectPin` defaults to `true`; `false` permits offscreen-pin
  eviction while protecting visible/overscan rows and explicit targets.
  `options.interrupt` defaults to `false`. Explicit navigation can use `true`
  for immediate takeover or `"commit"` to keep existing motion during bounded
  preparation and take over when the replacement is ready. Fresh user input
  cancels either interrupting preparation. Background paging uses `false`.
  See [bounded paging](docs/bounded-paging.md) for its lifecycle and companion.
- Optional `stage(item, element)` splits a new measured row's first layout
  within `updateWindow`. It runs after `render`, before connection, and returns
  a synchronous iterator or `undefined` for ordinary rows. Each iterator step
  runs in a separate hidden preparation slice, followed by a layout read. The
  row is measured and revealed only after completion. Cancellation, resize,
  and disposal call an unfinished iterator's `return()` before `onDestroy`;
  restore any withheld DOM there, even if no step has run. Steps must not start
  independent asynchronous work. Boot, synchronous updates, and declared-height
  rows use normal rendering without this hook. The streaming demo's
  [completed-reply helper](demos/streaming/staged-message.ts) preserves nodes
  while attaching a bounded number of markdown blocks per step.
- With `height(item)`, heights must be finite and positive. The runtime
  keeps data and heights for every item, but renders only the overscan
  window. Leaving that window calls `onUnmount` and `onDestroy`; re-entry
  calls `render` without an existing element, then `onMount`. Keep state
  that must survive scrolling in item data. Unknown-height rows retain
  their measured elements and slots while they're unmounted.
- `state.followingEnd` reports whether the current follow destination reaches the
  end. This includes bounded follow before its stopping point and bottom
  commands that override that point. Use it to keep a bottom-navigation
  button hidden while streaming growth is being followed.
- Use `onMount` and `onUnmount` to manage resources for mounted rows.
  Don't use `element.isConnected` as a mount signal. Hidden rows that wait
  in the canvas are connected but not mounted: their slots are zero-height,
  `inert`, and `aria-hidden`. The runtime also keeps one lone offscreen row,
  such as a streaming reply you scrolled away from, laid out in its hidden
  slot between updates. Mounting reveals that slot in place. Removal and
  disposal release it through the existing lifecycle hooks.
- Rows are measured inside the viewport's own canvas, so styles scoped to a
  viewport ancestor apply during measurement. You don't need a separate
  measurement container.
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
  A smooth command is interrupted by genuine user input and resolves `false`;
  a command to `"end"` re-engages end-follow.
- `behavior: "smooth"` and automatic smooth following use the browser's native
  animation. The browser chooses its timing. Completion requires arrival at
  the live target; an early `scrollend` alone cannot complete the command.
  A quiet fallback handles missing events and no-op commands. The deprecated
  `duration` option is ignored; there is no custom animation fallback.
  Explicit start/end commands permit another edge-load attempt without leaving
  the proximity zone, but do not overlap a pending load.
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

`createStickyHeaders` from `src/companions/index.ts` floats the current
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
geometry kernel and native scroll ownership/completion tests. The browser
matrix runs the dynamic-height lab in the three real engines and fails on any
contract violation the lab reports, then the streaming chat's product-level
invariants (`scripts/chat-invariants.mjs`: across a scrollback load, on an
undated and on dated single-day conversations, the row under a fixed
viewport point keeps its screen position); device runs (iPad, iPhone) are
done by hand with the trace channel above.
