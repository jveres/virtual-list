# Conversation tree navigation

Use a naturally clamped keyed jump when you select a conversation-tree node.
This applies to the final message too. Don't create trailing space to force a
short final message to the top, and don't jump to the end of a long final
message. This document records the decision made on September 10, 2026, and
the runtime contracts that prevent the same regression from returning.

## Final-node behavior

The tree selects a message, not an edge of the conversation. Its destination
uses the message key and the sticky-header inset:

```ts
await list.scrollTo(String(messageId), {
  behavior: "auto",
  offset: stickyEnabled ? DAY_HEADER_HEIGHT : 0,
});
```

Omit `align` and `pin`. The runtime resolves the message's top minus the inset
and clamps that destination to its available scroll range. The host must not
calculate a second destination from DOM heights or add a last-item exception.
In the streaming demo, the enabled sticky-header inset is 40 pixels.

| Selected message | Expected result |
| --- | --- |
| Earlier message with enough content below it | Its top lands below the sticky header. |
| Short final message | The jump stops at the existing bottom limit; its top can remain below the header. |
| Long final message with enough scroll range | Its top lands below the header; selection does not skip to the response's ending. |

Tree jumps are immediate: `ScrollOptions.behavior` uses `"auto"`, not
`"instant"`. The scroll-arrow buttons remain separate controls and retain
their own smooth edge-navigation behavior.

## Why the earlier approaches failed

The final behavior resulted from resolving two different meanings of
"select the last message." Keep these distinctions when changing navigation:

1. Treating the last node like the bottom arrow used `scrollTo("end")`. It
   produced the expected bottom position for a short response, but skipped
   the beginning of a long response. That is edge navigation, not selection.
2. Forcing every selected node to the top with `align: "start"` solved the
   long-response case, but requested a runtime pin. A short final message then
   gained artificial trailing space so its top could reach the header.
3. A keyed jump with only `offset` gives both intended outcomes. The runtime
   already implements this; no runtime change or host-side height workaround
   is necessary.

Do not remove or disable the runtime's pinning feature globally. Sending and
streaming use it deliberately. Tree selection must not create a new pin, but
the runtime still owns any existing reserve and its safe release. Don't clear
that reserve manually as a side effect of selecting a node.

## Runtime references

Check the runtime before patching the demo. These source symbols define the
behavior; search by symbol if line numbers change:

- [`ScrollOptions`, `targetTop`, and `performScrollTo`](../src/virtual-list.ts)
  define the command. `targetTop` subtracts the keyed offset and clamps it.
  `performScrollTo` calls `geometry.pin` for a keyed `align: "start"` request
  when pinning is enabled. An omitted alignment does not request that pin.
  Its non-smooth path lands immediately and calls `trimUnusedReserve`.
- [`Geometry.pin` and the I5 reserve invariant](../src/geometry.ts) explain why
  forced top alignment can increase the scroll surface for a short last row.
  This is intentional runtime behavior, not a geometry defect.
- [The core contract](core-contract.md) describes pinning, offsets, retained
  reserve, and streaming follow behavior. `followBehavior: "instant"` is a
  different option from `ScrollOptions.behavior`.
- [`navigateTreeMessage`](../demos/streaming/streaming.ts) is the host adapter.
  Both its loaded-message path and its staged-history path finish with the
  same naturally clamped keyed jump.

## Unloaded history and branch changes

Selecting an unloaded message or another branch requires a staged snapshot
before the keyed jump. Use `updateWindow` with `{ interrupt: true }`, a keyed
anchor, and cancellation guards. Publish the selected branch and loaded
window in `onCommit`, then issue the same keyed jump shown above. See the
[bounded-paging runtime boundary](bounded-paging.md#runtime-boundary).

When the new window reaches the beginning of history, remove the leading
loader in that same update with `edgeSlots: { start: null }`. Omitting
`edgeSlots` retains the existing slot by design. Leaving it registered caused
a 52-pixel blank strip above the first day header; a separate scroll write
doesn't remove that geometry. Keep the host's loader state consistent with
the committed slot change.

The tree panel's own scrolling is separate from the chat viewport. Selecting
an already-active node must not move the tree's scroll position. In WebKit,
replacing the footer's text node briefly collapsed its line box and clamped
the tree scroller 18 pixels upward at the bottom, moving the visible nodes
down. Keep the footer text node and update its `data` instead. This issue was
reproduced with an isolated tree component without a virtual-list runtime.

## Regression checks

The following checks cover the decision at both the runtime and host layers:

- [`tests/unit/virtual-list.test.ts`](../tests/unit/virtual-list.test.ts):
  `should naturally clamp a keyed jump without requesting a pin` checks both
  100-pixel and 900-pixel final rows, the clamped destination, and unchanged
  total size. `should atomically remove the loader slot when a staged jump
  loads the beginning` checks the loader and first-message geometry.
- [`scripts/chat-tree-regression.mjs`](../scripts/chat-tree-regression.mjs):
  the final short/long response cases check the actual message offset,
  clamped scroll position, and unchanged `scrollHeight`. The same suite
  checks unloaded history, branch selection, and tree-panel bottom-click
  stability at desktop and narrow widths in Firefox, WebKit, and Chromium.

Run these checks after changing tree navigation, alignment, pinning, or
staged-history integration. Start a local Vite server for the browser script,
or set `BROWSER_MATRIX_URL` to an existing server:

```sh
pnpm run check
pnpm test
node scripts/chat-tree-regression.mjs
```

Close any test browsers and servers you start. These are correctness checks,
not evidence of smooth physical scrolling. Performance investigations still
follow the [Firefox-first profiling workflow](firefox-profiling.md).
