# Safari momentum tail, September 28, 2026

Safari showed 1–2 px content shifts in the last half second of a trackpad
momentum scroll in the streaming chat, on the default simulated chat. The
cause is WebKit's compositing of nested scrollers: code blocks and tables.
A CSS rule makes them wrap on WebKit instead of scrolling sideways. The user
reports a smooth tail on the built-in display; the external display keeps a
smaller residue. The runtime is unchanged. This is a Safari-specific
exception to the Firefox-first workflow.

## Evidence

A temporary trace in the demo recorded exact scroll positions, every scroll
write from page code, and every DOM change near the list, per frame. The user
pressed a key at each visible jitter. Ten marks in two runs gave the same
picture.

- The page did nothing during the jitter. The last DOM change was 0.3 to
  0.9 seconds before each mark, and the only scroll writes were at load.
- Safari reported whole-pixel positions in all 1,977 scroll events. Each
  tail advanced 1 px per frame, then 1 px every 33, 50, and 83 ms.
- The jitter didn't depend on the runtime: it stayed with runtime anchoring,
  with a 4,000 px overscan, with every row mounted, and with the row and
  list layer hints removed.

A static control page with no runtime and no listeners,
`scripts/firefox-profile/fixtures/static-scroll.html`, reproduced the
jitter. Its content on one flat compositing layer scrolled smoothly. Adding
a scrollable code block to every third row brought the jitter back; adding
a decoded image didn't. In the chat, clipping every nested scroller removed
the jitter on the built-in display.

The mechanism is WebKit's async overflow scrolling: each scrollable element
gets its own layer, and WebKit snaps each layer to the device pixel grid on
its own while the scroll position moves in whole CSS pixels. Firefox and
Chrome scroll in device-pixel steps, so their tails are finer.

## Change

`integrations/markdown.css` adds a WebKit-only block, gated by
`@supports (-webkit-nbsp-mode: space)`. Code blocks wrap long lines and clip.
Tables lay out as tables inside the column, and their cells wrap. The demo's
tool-call code panels, which already wrap, use `overflow-x: hidden`. Other
engines keep the renderer's sideways scrolling.

Two designs were considered and dropped as too much machinery: a runtime
scan that clips only the scrollers whose content fits, and a demo helper that
marks overflowing blocks on mount. Both needed layout reads and a debounce
for streaming rows.

## Limits

The external LU28R55 display keeps a smaller residue. That matches the
[September 22 finding](external-display-scroll-jitter-2026-09-22.md) that
trackpad events reach that display unevenly, which isn't page code. The
control page results near the limit of what the eye can judge: several
page-level variations appeared to jitter alone and were smooth together, so
only the code-block result was confirmed in the chat itself.

The mount and unmount of rows during a scroll, the original suspicion,
was excluded: the jitter stayed with every row mounted.

## Reproduce

Open `scripts/firefox-profile/fixtures/static-scroll.html` from a Vite
server in Safari, flick, release, and watch the last half second. Its
header comment lists the switches: `?layer=1` for one compositing layer,
`?code=1` for scrollable code blocks, and `?img=1` for images.
