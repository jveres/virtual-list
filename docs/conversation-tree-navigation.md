# Conversation tree navigation

Use one definition of the conversation bottom everywhere: the position shown
after page load. Trailing space keeps the last user message below the sticky
header when needed. When the answer fills the viewport, no trailing space is
needed. The runtime owns this geometry; don't calculate it in the demo.

## Tree layout

Tree centering includes the occupied card and outline width rather than only
the spine. Cards and outlines shrink to their content, with a panel-derived
maximum width shared at every depth. Sibling positions follow those measured
widths, leaving only a 12-pixel gutter instead of empty fixed-width slots.
A single child stays on its parent's branch instead of returning to the root
spine.
Selecting a version never reorders its siblings. Both user and assistant
labels sit to the right of their glyphs and use natural left alignment.
The active path has a continuous, faint blue ribbon behind its spine and
glyphs. Message backgrounds stay transparent, including on hover.
Response sections continue beneath the assistant title on that same side.
The 12-pixel pictograms are centered inside 28-pixel rings; the user pictogram
uses Lucide's MessageSquare with its drawing bounds vertically centered.
The [Lucide license notice](../public/lucide-license.txt) ships with the demo.

The normal panel uses the available left gutter, up to 664 pixels wide,
targeting at most 15% overlap with the desktop
chat column. Its 214-pixel minimum width keeps all header controls visible.
Wide forks scroll horizontally at reading zoom. Canvas extents remain stable
while branches fold in manual zoom; Fit recalculates the full extent.
Resizing the panel recalculates the width. Long labels wrap to two lines,
and section titles use an ellipsis within their band. A folded branch's count
sits above its continuation line. Message nodes have no hover tooltips.
Foldable versions reserve the count badge's width even while active, so showing
the badge doesn't resize a short title or shift its siblings.
Short titles stay compact even beside longer outlines. The layout reserves
the wider of each title and its outline, so neighboring branches do not
overlap. Width caps are applied together, then widths are measured in one
batch during layout, never in the scroll-frame path. Nested forks stay under
their own parent; the canvas can grow to contain those offset branches.

After successful navigation, a partially clipped node or section smoothly
scrolls into view inside the tree panel, moving only as far as needed. Fully
visible items stay put. Reduced-motion preferences make this reveal immediate.
This does not change the chat viewport's immediate navigation behavior.
Pointer selections retain focus without a keyboard outline; keyboard navigation
keeps its visible focus indicator.
The clicked message or section keeps the blue current-item highlight even when
another message is first in the chat viewport. A selected section highlights
itself, not its parent message. Once the chat's first visible message
changes, the highlight follows that reading position again.

## Zoom and locate

The header contains zoom out, a percentage reset, zoom in, Fit, Locate, full
width, and Close controls. Toggle full width to span the window with 16-pixel
side margins; toggle it again to restore the normal panel width. This choice
persists when you close and reopen the panel and preserves your zoom or Fit mode.
Both modes cap node cards at 320 pixels and heading lists at 300 pixels,
reduced for narrower panels. Root and leaf cards share those maximums,
but their actual widths follow their content rather than filling the cap.
Extra panel width adds canvas space without stretching text or connectors.
Sibling spacing accommodates these cards so their text does not overlap.
The first opening uses 100% zoom. Closing and reopening retains
your zoom and mode, but recenters the current node's band and immediately
reveals the node as far as the scroll boundaries permit. If the reading
position is unavailable, opening falls back to the first node. Importing or
replacing a conversation clears the previous canvas extents and pan position
and resets zoom to 100%, whether the panel is open or closed.
Fit is opt-in and fits the entire displayed tree into the
available width and height; it remains active across resizing and branch
changes. Long conversations can make the overview's text very small.

Zoom buttons leave Fit mode and preserve the viewing center. Click the
percentage to return to 100%. Manual zoom supports up to 300%, and resizing
preserves your chosen scale. Toolbar interaction keeps a hover-opened panel
open. Locate smoothly centers the current chat node as far as the scroll
boundaries permit, without changing the zoom or the chat's scroll position.
Reduced-motion preferences make Locate immediate.

Drag with a mouse anywhere in the tree, including labels and headings, to pan.
On touch devices, one-finger swipes use native scrolling and release momentum.
Tree text is not selectable, and dragging does not navigate the chat.
Two-finger touch pinch, control-wheel trackpad pinch, and Safari gesture
events zoom around the
gesture's center. Ordinary wheel input still scrolls the tree. Dragging and
pinching leave Fit mode; use Fit to restore the full overview.

## Bottom geometry and navigation targets

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

Boot already lands at the runtime's end. The bottom arrow uses ordinary
`scrollTo("end")`, with no demo-owned bottom helper. Bottom geometry does not
change the target of a tree click: a message node targets its own start,
including the final message. Never substitute the bottom for an offscreen title.

All message nodes use a keyed jump with the sticky-header inset:

```ts
await list.scrollTo(String(messageId), {
  behavior: "auto",
  offset: stickyEnabled ? DAY_HEADER_HEIGHT : 0,
});
```

For these message jumps, omit `align` and `pin`. The runtime resolves
the message's top minus the inset and clamps it to the available scroll range.
The host must not calculate a second destination from DOM heights.
In the streaming demo, the enabled sticky-header inset is 40 pixels.

| Selected message | Expected result |
| --- | --- |
| Earlier message with enough content below it | Its top lands below the sticky header. |
| Short final response | The last user message stays below the header, with trailing space after its response as needed. |
| Long final response | Its start lands below the sticky header, without adding trailing space. |
| Bottom arrow | The conversation lands at the same bottom position as page load. |

Tree jumps are immediate: `ScrollOptions.behavior` uses `"auto"`, not
`"instant"`. The scroll-arrow buttons remain separate controls and retain
their smooth animation, but the bottom destination belongs to the runtime.

## Why the earlier approaches failed

Earlier implementations tied trailing reserve to navigation. Reserve is now a
runtime invariant, independent of navigation. Redirecting the final tree node
to the bottom confused that geometry rule with the selected target: a long
response's title remained offscreen. All message nodes now use keyed jumps;
only an explicit bottom command requests the conversation end.

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
  same keyed navigation helper, including for the final node.

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

Assistant nodes list their H1/H2 sections beneath the title. The shallowest
visible heading level aligns with the message text; only nested headings are
indented. An H2-only outline therefore has no extra initial indentation.
Each section has a clickable dot on the solid path line. Omit the
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

Branch selection saves only node choices and progress flags in a small,
separate IndexedDB record. It reuses the already-validated in-memory message
payloads instead of exporting and reparsing the full transcript. A revision
ties these choices to their content snapshot; a stale selection from an older
snapshot cannot override a replacement chat. Full content saves atomically
replace the snapshot and clear its previous selection record. Existing
Markdown-only history records remain readable.

Imports, sends, stops, edits, and deletions still save the full transcript.
Loading validates persisted content and checks saved choices against the tree.
Export uses the current in-memory tree, including choices in folded branches.

### Measured version-switch cost

The September 11, 2026 check used an image-rich 16 MB imported chat and eight
alternating native clicks on two visible version nodes per run. The installed
Firefox 155.0.1 used a fresh profile, closed DevTools, and the external LU28R55
at 60 Hz: a 1900 × 965 CSS-pixel viewport with 2× display scaling. The panel
stayed open at 100% zoom. Two baseline runs and two changed runs agreed:

| Selection | Baseline mean | Changed mean |
| --- | ---: | ---: |
| Short branch | 187–188 ms | 31–32 ms |
| Longer branch | 280–283 ms | 133–134 ms |

Times measure the click handler through navigation completion, not physical
display presentation. The longest animation-frame interval fell from about
200 ms to 34 ms. Profiles attributed about 152 ms of sampled work per switch
to the demo's full-history serialization, reparsing, validation, and storage
clone. The runtime itself accounted for about 5 ms; its enclosing callback
stacks must not be mistaken for runtime-owned work. The remaining longer-branch
delay includes Markdown row rendering and frame-batched preparation.

Raw profiles, timings, and screenshots remain local under ignored
`browser-artifacts/firefox/`. Baselines are `run-aFAn3Z` and `run-GsDckT`;
changed runs are `run-xFEYCC` and `run-J0CPOY`. Earlier hidden-panel captures and
an interrupted focus attempt are not valid evidence for this comparison.

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
- [`scripts/regressions/chat-tree/chat-tree-regression.mjs`](../scripts/regressions/chat-tree/chat-tree-regression.mjs):
  the final short/long response cases check clamped message-start navigation
  and unchanged `scrollHeight`. The same suite
  reproduces scrolling up in the default simulated chat and selecting the
  final response's second version: it must stop at the bottom limit without
  adding a reply reserve on top of the existing prompt reserve. It also
  checks unloaded history, branch selection, and tree-panel bottom-click
  stability at desktop and narrow widths in Firefox, WebKit, and Chromium.
- [`scripts/regressions/chat-tree/chat-tree-persistence-regression.mjs`](../scripts/regressions/chat-tree/chat-tree-persistence-regression.mjs):
  checks small selection writes, reloads, complete exports, replacement
  snapshots, and stale-record isolation in Firefox, WebKit, and Chromium.
  The main tree regressions also cover keyboard focus, dated/undated branch changes,
  latest-response toolbars, attachment-only image nodes, and empty responses
  labeled **Response in progress…** until streaming supplies a final summary.
- [`scripts/regressions/chat-tree/chat-tree-headings-regression.mjs`](../scripts/regressions/chat-tree/chat-tree-headings-regression.mjs):
  checks H1/H2 hierarchy, duplicate-title removal, original heading ordinals,
  safe labels, clickable path dots, spacing, keyboard focus, unloaded history,
  and branch changes in Firefox, WebKit, and Chromium.
- [`scripts/regressions/chat-tree/chat-tree-placement-regression.mjs`](../scripts/regressions/chat-tree/chat-tree-placement-regression.mjs):
  checks one through five equal-width version bands, parent alignment,
  right-side labels, drawing and ring centers, normalized heading indentation,
  edge endpoints, resizing, and narrow-screen placement.
- [`scripts/regressions/chat-tree/chat-tree-zoom-regression.mjs`](../scripts/regressions/chat-tree/chat-tree-zoom-regression.mjs):
  checks full-tree fit, manual zoom, Locate without chat movement, header
  controls, full-width toggling and restoration, hover-open percentage reset,
  import view resets with open and closed panels, band centering,
  dragging from text without selection,
  and synthetic pinch input. Physical trackpad feel requires manual checking.
- [`scripts/regressions/chat-tree/chat-tree-reveal-regression.mjs`](../scripts/regressions/chat-tree/chat-tree-reveal-regression.mjs):
  checks first-open visibility, recentering after a far-right pan and reopen,
  clipped nodes on all four edges, section links, reduced motion, and fully
  visible selections that must not move the panel.
- [`scripts/regressions/chat-tree/chat-bottom-regression.mjs`](../scripts/regressions/chat-tree/chat-bottom-regression.mjs):
  checks stopped-response persistence, branch return followed by manual
  scrolling, bottom-arrow equivalence, live sticky insets, and short and long
  responses across reloads in Firefox, WebKit, and Chromium.

Run these checks after changing tree navigation, alignment, pinning, or
staged-history integration. The suite starts and closes its own local Vite
server, or you can set `BROWSER_MATRIX_URL` to an existing server:

```sh
pnpm run check
pnpm test
pnpm run test:chat-tree
```

Close any test browsers and servers you start. These are correctness checks,
not evidence of smooth physical scrolling. Performance investigations still
follow the [Firefox-first profiling workflow](firefox-profiling.md).
