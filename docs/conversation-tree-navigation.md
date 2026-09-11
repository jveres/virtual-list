# Conversation tree navigation

Use one definition of the conversation bottom everywhere: the position shown
after page load. Trailing space keeps the last user message below the sticky
header when needed. When the answer fills the viewport, no trailing space is
needed. The runtime owns this geometry; don't calculate it in the demo.

## Tree layout

The initial path is centered in the tree canvas. Each fork divides its
parent's band into equal-width bands: two versions sit left and right, three
sit left, center, and right, and larger forks follow the same rule. A single
child stays on its parent's branch instead of returning to the root spine.
Selecting a version never reorders its siblings. User labels sit to the left
of their glyphs; assistant labels and response sections sit to the right.

Bands have a 208-pixel minimum width. The normal panel uses the available left
gutter, up to 664 pixels wide, targeting at most 15% overlap with the desktop
chat column. Its 214-pixel minimum width keeps all header controls visible.
Wide forks scroll horizontally at reading zoom. Canvas extents remain stable
while branches fold in manual zoom; Fit recalculates the full extent.
Resizing the panel recalculates the width. Long labels wrap to two lines,
and section titles use an ellipsis within their band. A folded branch's count
sits above its continuation line. Message nodes have no hover tooltips.

After successful navigation, a partially clipped node or section smoothly
scrolls into view inside the tree panel, moving only as far as needed. Fully
visible items stay put. Reduced-motion preferences make this reveal immediate.
This does not change the chat viewport's immediate navigation behavior.
Pointer selections retain focus without a keyboard outline; keyboard navigation
keeps its visible focus indicator.
The clicked message keeps the blue current-node highlight even when another
message is first in the chat viewport. Once the chat's first visible message
changes, the highlight follows that reading position again.

## Zoom and locate

The header contains zoom out, a percentage reset, zoom in, Fit, Locate, full
width, and Close controls. Toggle full width to span the window with 16-pixel
side margins; toggle it again to restore the normal panel width. This choice
persists when you close and reopen the panel and preserves your zoom or Fit mode.
Full-width mode caps node cards at 320 pixels and heading lists at 300 pixels,
so branches can spread across the canvas without stretching their text.
The first opening uses 100% zoom. Closing and reopening retains
your zoom and mode. Fit is opt-in and fits the entire displayed tree into the
available width and height; it remains active across resizing and branch
changes. Long conversations can make the overview's text very small.

Zoom buttons leave Fit mode and preserve the viewing center. Click the
percentage to return to 100%. Manual zoom supports up to 300%, and resizing
preserves your chosen scale. Toolbar interaction keeps a hover-opened panel
open. Locate smoothly centers the current chat node as far as the scroll
boundaries permit, without changing the zoom or the chat's scroll position.
Reduced-motion preferences make Locate immediate.

Drag anywhere in the tree, including labels and headings, to pan. Tree text
is not selectable, and dragging does not navigate the chat. Two-finger touch pinch,
control-wheel trackpad pinch, and Safari gesture events zoom around the
gesture's center. Ordinary wheel input still scrolls the tree. Dragging and
pinching leave Fit mode; use Fit to restore the full overview.

## Final-node behavior

The runtime establishes the last-user pin from the committed conversation,
not from a navigation command. Configure it once when mounting the list:

```ts
pinning: {
  match: (row) => !isDayHeader(row) && row.role === "user",
  get offset() {
    return stickyEnabled ? DAY_HEADER_HEIGHT : 0;
  },
}
```

Every snapshot establishes its last matching row's reserve atomically. The
space remains available after selecting an earlier node and when scrolling
manually. A stopped response follows the same rule as a completed response.
Don't pin the assistant message, depend on a previous visit's reserve, or
re-pin in navigation handlers. The existing bare-end landing setting uses
`pinning: false`.

The runtime reads the offset during snapshot preparation, together with the
matching key. A held snapshot retains both values until commit. When you
change the sticky-header setting, submit the current items again so the
runtime captures the new inset; don't adjust trailing space in the host.

Boot already lands at the runtime's end. The final tree node and bottom arrow
use ordinary `scrollTo("end")` commands, with no demo-owned bottom helper.

Earlier messages use a keyed jump with the sticky-header inset:

```ts
await list.scrollTo(String(messageId), {
  behavior: "auto",
  offset: stickyEnabled ? DAY_HEADER_HEIGHT : 0,
});
```

For these earlier-message jumps, omit `align` and `pin`. The runtime resolves
the message's top minus the inset and clamps it to the available scroll range.
The host must not calculate a second destination from DOM heights.
In the streaming demo, the enabled sticky-header inset is 40 pixels.

| Selected message | Expected result |
| --- | --- |
| Earlier message with enough content below it | Its top lands below the sticky header. |
| Short final response | The last user message stays below the header, with trailing space after its response as needed. |
| Long final response | The conversation lands at its end without unnecessary trailing space. |

Tree jumps are immediate: `ScrollOptions.behavior` uses `"auto"`, not
`"instant"`. The scroll-arrow buttons remain separate controls and retain
their smooth animation, but the bottom destination belongs to the runtime.

## Why the earlier approaches failed

The previous rule treated the final tree node as a separate keyed destination.
It relied on whatever reserve remained after earlier navigation, so returning
to the bottom didn't explicitly restore the page-load geometry. That rule is
superseded: reserve is a runtime invariant, independent of navigation.

Re-pinning only when clicking the final node also failed. Switching branches
could remove the pinned key; returning through an earlier node restored the
rows but not the pin. Manual scrolling then stopped with the last prompt far
below the header. Declarative pinning restores the destination snapshot's
pin even when no bottom command is issued.

Forcing the assistant row to the top with `align: "start"` is also incorrect:
the reserve belongs to the last user message. Don't clear reserve manually or
add special cases for stopped, short, or long responses.

## Runtime references

Check the runtime before patching the demo. These source symbols define the
behavior; search by symbol if line numbers change:

- [`ScrollOptions`, `targetTop`, and `performScrollTo`](../src/virtual-list.ts)
  define the command. `targetTop` subtracts the keyed offset and clamps it.
  Boolean `pinning: true` allows command-created pins. Declarative pinning
  selects its key during preparation and applies it with the snapshot;
  commands cannot replace it. Its reserve survives `trimUnusedReserve`.
- [`Geometry.pin` and the I5 reserve invariant](../src/geometry.ts) explain why
  forced top alignment can increase the scroll surface for a short last row.
  This is intentional runtime behavior, not a geometry defect.
- [The core contract](core-contract.md) describes pinning, offsets, retained
  reserve, and streaming follow behavior. `followBehavior: "instant"` is a
  different option from `ScrollOptions.behavior`.
- [`navigateTreeMessage`](../demos/streaming/streaming.ts) is the host adapter.
  Both its loaded-message path and its staged-history path finish with the
  same navigation helper, including the canonical bottom for a final node.

## Unloaded history and branch changes

Selecting an unloaded message or another branch requires a staged snapshot
before the keyed jump. Use `updateWindow` with `{ interrupt: true }`,
`anchor: "viewport"`, and cancellation guards. Publish the selected branch and
loaded window in `onCommit`, then navigate using the helper above. See the
[bounded-paging runtime boundary](bounded-paging.md#runtime-boundary).

Don't use `{ key: selectedMessageId, offset: inset }` as the snapshot anchor.
Unlike a naturally clamped scroll command, an explicit replacement anchor
asks `Geometry.resolve` to preserve that exact reading position, including
adding reserve beneath a short final response. The later keyed scroll then
clamps against the enlarged range and cannot undo the forced alignment.
This caused the default simulated chat's second final-response version to
land at the top after scrolling up, while same-branch selection worked.
The viewport policy avoids requesting that extra reserve; existing prompt
pins and the runtime's safe reserve-release behavior remain intact. The
runtime establishes the destination branch's last-user pin in that same
snapshot commit, before any subsequent navigation.

Derive day grouping from the **destination snapshot**, including whether that
path contains timestamps. The old active branch's dated/undated flag is not
valid for a pending branch. Using it labeled undated history as **Today**
instead of **Earlier** when selecting a newly dated reply, and produced the
inverse error when switching back.

Row rendering and measurement happen before `onCommit`. Any render-time host
state that changes at commit must either travel with the snapshot or be
updated explicitly once the snapshot commits. In particular, the latest
response's `data-latest` toolbar marker needs that update: the new row was
prepared while the previous response was still latest. This marker only
changes opacity and pointer handling; it doesn't change measured geometry.
Keep structural row changes inside the runtime's snapshot transaction.

When the new window reaches the beginning of history, remove the leading
loader in that same update with `edgeSlots: { start: null }`. Omitting
`edgeSlots` retains the existing slot by design. Leaving it registered caused
a 52-pixel blank strip above the first day header; a separate scroll write
doesn't remove that geometry. Keep the host's loader state consistent with
the committed slot change.

The tree panel's own scrolling is separate from the chat viewport. Selecting
a fully visible, already-active node must not move its scroll position. In WebKit,
replacing the footer's text node briefly collapsed its line box and clamped
the tree scroller 18 pixels upward at the bottom, moving the visible nodes
down. Transient status now overlays the panel without changing its height;
update its persistent text node's `data`. This issue was reproduced with an
isolated tree component without a virtual-list runtime.

Replacing a focused tree node can also emit `focusout` in Chromium. Suppress
the panel's outside-focus dismissal during that synchronous replacement, then
restore focus to the replacement node. A keyboard-opened, unpinned panel must
remain open after selection, just like a click-pinned panel.

## Response sections

Assistant nodes list their H1/H2 sections beneath the title, with H2 entries
indented. Each section has a clickable dot on the solid path line. Omit the
first section if it repeats the node title, but retain its original heading
ordinal so later links still select the right section, including duplicate
heading names.

Use the same Markdown parser and tool-separated text blocks as the response
renderer. Keep labels as plain text. Cache the outline by immutable message
object; build it when the tree renders, not on token or scroll-frame updates.

For a heading jump, first use normal tree navigation to select the branch and
mount the response. Measure the heading's offset within that row once, then
call `scrollTo(key, { behavior: "auto", offset: inset - withinRow })`. Negative
offsets are part of `ScrollOptions`; don't add `align: "start"`, a pin, or a
second host-owned scroll calculation. The runtime still clamps sections near
the end to the available scroll range.

## History persistence

The simulated and OpenAI providers store their histories separately. Simulated
history preserves the entire branch tree, selected versions, stopped-response
markers, and the next canned-response index. Sending, stopping, importing,
switching versions, and deleting versions persist the updated history locally.
Reloading restores that history and uses the same runtime bottom geometry.
The settings dialog can restore the built-in simulated conversation.

## Regression checks

The following checks cover the decision at both the runtime and host layers:

- [`tests/unit/virtual-list.test.ts`](../tests/unit/virtual-list.test.ts):
  `should naturally clamp a keyed jump without requesting a pin` checks both
  100-pixel and 900-pixel final rows, the clamped destination, and unchanged
  total size. `should atomically remove the loader slot when a staged jump
  loads the beginning` checks the loader and first-message geometry.
  Declarative-pin cases cover boot, branch restoration before manual
  scrolling, command independence, targeted and held updates, growth and
  shrinkage, live inset changes, held inset capture, and predicate failure.
- [`scripts/chat-tree-regression.mjs`](../scripts/chat-tree-regression.mjs):
  the final short/long response cases check the page-load bottom position and
  matching `scrollHeight`. The same suite
  reproduces scrolling up in the default simulated chat and selecting the
  final response's second version: it must stop at the bottom limit without
  adding a reply reserve on top of the existing prompt reserve. It also
  checks unloaded history, branch selection, and tree-panel bottom-click
  stability at desktop and narrow widths in Firefox, WebKit, and Chromium.
  Review regressions also cover keyboard focus, dated/undated branch changes,
  latest-response toolbars, attachment-only image nodes, and empty responses
  labeled **Response in progress…** until streaming supplies a final summary.
- [`scripts/chat-tree-headings-regression.mjs`](../scripts/chat-tree-headings-regression.mjs):
  checks H1/H2 hierarchy, duplicate-title removal, original heading ordinals,
  safe labels, clickable path dots, spacing, keyboard focus, unloaded history,
  and branch changes in Firefox, WebKit, and Chromium.
- [`scripts/chat-tree-placement-regression.mjs`](../scripts/chat-tree-placement-regression.mjs):
  checks one through five equal-width version bands, parent alignment,
  role-aware labels, edge endpoints, resizing, and narrow-screen placement.
- [`scripts/chat-tree-zoom-regression.mjs`](../scripts/chat-tree-zoom-regression.mjs):
  checks full-tree fit, manual zoom, Locate without chat movement, header
  controls, full-width toggling and restoration, hover-open percentage reset,
  dragging from text without selection,
  and synthetic pinch input. Physical trackpad feel requires manual checking.
- [`scripts/chat-tree-reveal-regression.mjs`](../scripts/chat-tree-reveal-regression.mjs):
  checks clipped nodes on all four edges, section links, reduced motion, and
  fully visible selections that must not move the panel.
- [`scripts/chat-bottom-regression.mjs`](../scripts/chat-bottom-regression.mjs):
  checks stopped-response persistence, branch return followed by manual
  scrolling, bottom-arrow equivalence, live sticky insets, and short and long
  responses across reloads in Firefox, WebKit, and Chromium.

Run these checks after changing tree navigation, alignment, pinning, or
staged-history integration. Start a local Vite server for the browser script,
or set `BROWSER_MATRIX_URL` to an existing server:

```sh
pnpm run check
pnpm test
pnpm run test:chat-tree
```

Close any test browsers and servers you start. These are correctness checks,
not evidence of smooth physical scrolling. Performance investigations still
follow the [Firefox-first profiling workflow](firefox-profiling.md).
