# virtual-list

`virtual-list` is a dynamic-height virtualizer for chat-style interfaces: a
native scrolling viewport, rows of unknown and changing height, streaming
content, and scrollback loading, without visible jumps. This branch
(`lean-core-v2`) is a from-scratch rewrite of the runtime on two cornerstones:

- **Settle detection** (`src/scroll-settle.ts`): per-engine heuristics that
  say when a user gesture has genuinely finished, so structural changes to
  the scroller can land while nothing is moving.
- **Premeasurement** (`src/premeasure.ts`): rows are rendered and measured
  off the scroller before they ever enter it, so committed geometry is
  whole-pixel and exact, never estimated and corrected later.

The contract, its invariants (I1–I6), and the design decisions live in
[`docs/lean-core.md`](docs/lean-core.md). This file covers running, using,
and testing the code.

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
  sticky header, tool panels, a Markdown export, and an optional real OpenAI
  provider (key stored in this browser only; tool panels are live there and
  canned under the simulated provider). `?stream=instant` (or `?instant`)
  removes the simulated token delays, `?stream=fast-long` (or `?fast-long`)
  streams a long reply quickly, `?edge=pill` uses a floating loader pill
  instead of the in-flow slot, and `?sticky=off` starts with the sticky day
  header off.

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
- `scroll-settle.ts` — the settle controller: gesture classification,
  programmatic-write matching, per-engine settle strategies (`chromium-wheel`,
  `firefox-wheel`, `safari-wheel`, and the plain `default`), chosen by engine
  from the user agent; an unknown engine gets the Firefox contract.
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
  scrollingUpdates: "live", // | "same-height" | "freeze"
  followBehavior: "smooth", // | "instant"
  edgeSlots: { start: { key: "loader", height: 52, render } },
  onState: (state) => {},
  onReachStart: ({ signal }) => loadOlder(signal),
  onReachEnd: ({ signal }) => loadNewer(signal),
  onDestroy: (element) => {},
  settleStrategy: undefined, // detected from the user agent
});

list.setItems(items, { anchor: "auto" }); // | "viewport" | "end" | "none"
await list.scrollTo(key, { align: "start", behavior: "smooth", duration, offset });
await list.scrollTo("end", { behavior: "smooth" });
list.remeasure(key, { anchor: "viewport" });
list.setEdgeSlot("start", slot | null);
list.positionOf(key); // { top, height } | null, committed positions only
list.elementOf(key); // the mounted element | null
list.state; // { count, start, end, atStart, atEnd, following, totalSize, held }
list.dispose();
```

- `setItems` hands over a whole snapshot; new and replaced rows are rendered
  and premeasured off the scroller, and the commit is one atomic write.
  During a scroll the snapshot waits for the settle, except what needs no
  scroll write: same-key updates under `"live"`, and structural changes
  confined below the anchor (an appended message, a version switch).
- `scrollTo` with `align: "start"` on a key pins it to the viewport top and
  reserves the shortfall below (a chat's send flow); `offset` lands it
  below a floating header. A smooth command is interrupted by genuine user
  input and resolves `false`; a command to `"end"` re-engages end-follow.
- `remeasure` is the intent-bearing path for a discrete user interaction
  that changes a row's height (opening a tool panel): it keeps the viewport
  anchored instead of re-gluing an end-positioned transcript.
- Edge slots are fixed-height host rows kept at the surface's edges — a
  scrollback loader in the flow — that are geometry but never the anchor.

`demos/shared/sticky-headers.ts` is a companion that floats the current
section header over the viewport using only `positionOf`/`elementOf`.

## Validation

```sh
pnpm run check   # Biome + TypeScript
pnpm test        # vitest, jsdom, deterministic
pnpm run test:browser              # Chromium, Firefox, WebKit via Playwright
pnpm run test:browser -- --chaos=300 --seed=7 --headed
```

The unit suite drives the real settle controller and the real runtime
against a controllable jsdom harness (a scripted `ResizeObserver`, fake
timers, an engine-like scroll clamp), plus oracle and property tests for the
geometry kernel and characterization tests for the glide. The browser matrix
runs the dynamic-height lab in the three real engines and fails on any
contract violation the lab reports; device runs (iPad, iPhone) are done by
hand with the trace channel above.
