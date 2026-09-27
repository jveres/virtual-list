# Safari gallery fade follow-up, September 27, 2026

Safari gallery scrolling still has user-observed jitter correlated with image
fades. This remains a known limitation in the `v0.4.1` patch. The user asked to
retain the current behavior, document the issue, and release the patch.

## Current behavior

Gallery images now fade on initial page load as well as when entering during
scrolling. Both cached images and first-time downloads use the existing 240 ms
opacity animation after decoding. Reduced-motion mode disables the animation.
Removing the initial-load exception also removes its scroll listener.

The WebKit-only CSS rule gives each mounted photo `transform: translateZ(0)`,
in addition to the existing opacity preparation. This is a compositing hint,
not proof that Safari maintains a particular layer structure. Its lifetime is
bounded by the mounted gallery window.

The user reported less jitter after the regression browsers were stopped, but
still observed it when images faded. After the compositing change, the user
reported "Improved, but still jitters." The cause remains unconfirmed. An
alternative cover-layer fade was discussed but was not implemented.

## Measurements and limits

The Safari-specific investigation used installed Safari 27.0, build
22625.1.29.11.27, on the LU28R55 external display: 1920 × 1080 logical pixels,
2× scaling, and 60 Hz. The capture window's content area was 1920 × 997. The
gallery used Rows, medium size, and six concurrent image loads. DevTools was
closed, and each run owned a separate window that it closed afterward.

Two scripted native-input captures were recorded. They do not reproduce real
trackpad momentum and are not a valid performance comparison: the baseline
traversed 3680 pixels downward and 1080 upward, while the candidate traversed
1080 pixels in each direction. Paging and image work therefore differed.
Remote photo delivery was also uncontrolled, and CPU process attribution was
ambiguous. Regular animation-frame callbacks do not prove smooth physical
presentation. No measured jitter improvement is claimed from these runs.

Compact reports and reproduction metadata are retained under ignored
`browser-artifacts/safari-native-scroll/`: `run-al5VWt` and `run-pxaSLX`.
Each records the source revision, patch hash, command, display, and browser.
Raw captures, per-run caches, and sample files were removed. The shared native
helper and compiler cache remain reusable.

To repeat the scripted workload from the repository root, run:

```sh
SAFARI_DISPLAY=external DEMO=gallery GALLERY_LAYOUT=rows ROUNDS=1 SAMPLE=1 \
  node scripts/firefox-profile/safari-scroll.mjs
```

For a follow-up investigation, close other test browsers and use a matched
manual trackpad capture on the same display. Start the gesture only after the
runner announces recording. Compare equivalent distances, paging progress,
image readiness, and fade activity; reject mismatched runs. The current
scripted comparison cannot identify whether texture work, layer changes, or
another source causes the remaining jitter.

## Other patch fixes

The user confirmed three independent chat fixes during this patch:

- Native streaming follow can update its destination every 100 ms during
  motion instead of waiting for each previous animation to finish.
- Fast-scroll skeletons clear at the top or bottom boundary without waiting
  for touch or momentum to settle.
- Prepend anchor corrections reset the velocity sample, so their offset
  changes do not incorrectly activate fast-scroll skeletons.

The Chrome prepend probe preserved the visible message's screen position over
three consecutive top-button loads. The reusable prepend regression checks
both anchor position and false skeleton activation in all three browser
engines. These checks do not establish Safari gallery smoothness.

## Release verification

`pnpm run check`, all 1,072 unit tests, the production build, and both isolated
consumer builds passed. All 112 browser regression scripts passed across the
initial run, resumed groups, and targeted reruns after the fixes below.

The first WebKit message-collapse run reported an intermittent ResizeObserver
loop error; the complete three-engine, three-viewport rerun passed. The history
test still sampled JavaScript `scrollTop` setters and assumed custom easing
durations. It now samples native scroll events, tests an explicit header
handoff midpoint, and verifies intermediate positions and bounded monotonic
travel. Its final Firefox, Chromium, and WebKit run passed.

In the newspaper test, automated WebKit stayed at scrollTop 98995 after the
first smooth top command in the 1100-pixel Radar layout. The command timed out
without moving. The same probe with the released `v0.4.0` native-glide source
also stayed stationary; a subsequent direct native scroll reached zero.
The takeover path toggled overflow to interrupt a recent scroll, rebuilding
WebKit's scrolling layer and stranding the next animation. The patch now uses
the shared native cancellation helper: an instant one-pixel nudge and restore
in the same task, with both positions recorded as programmatic adjustments.
It leaves the scrolling layer intact. The regression assertion is unchanged;
the Firefox and WebKit runs now pass all layouts and desktop/mobile navigation.

The unit tests verify that recent-motion takeover preserves overflow styling,
restores the starting position before paint, and completes both directions.
The native-animation browser regression also exercises a recent unmanaged
scroll followed immediately by a smooth command. Native animation, anchoring,
glide, retargeting, and scroll-settle command checks pass in all three engines.
The touch-paging and paging-edge regressions also pass.

With the local demo server running, run the focused newspaper check using:

```sh
BROWSER_ENGINE=webkit BROWSER_MATRIX_URL=http://127.0.0.1:5173 \
  node scripts/regressions/newspaper/newspaper-regression.mjs
```

The gallery group passed all seven scripts after initial-load fading changed.
The initial/cached-reveal regression also passed again in all three engines,
both layouts, and phone/desktop widths after the retained WebKit hint. These
are behavior checks; they do not resolve the user-observed Safari jitter.
