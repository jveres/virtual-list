# External-display scroll jitter: September 22, 2026

This report records a Firefox investigation of intermittent whole-page scroll
jitter. The user sees it on the external LU28R55 display in the chat and
gallery demos, in Firefox and Safari 27, but not on the built-in display.
Real trackpad captures show that on the external display, trackpad events
reach the compositor unevenly relative to its frames. Frames that receive no
event don't move, and the next frame moves twice. That happens about 3.6
times as often as on the built-in display. The unevenness occurs before
Firefox's parent process handles the event, so the page and runtime aren't
part of the cause. The underlying reason for the noisier delivery is still
unverified.

## Symptom

The user described the jitter before any capture. The whole content shakes,
rows don't move relative to each other, and the sticky header doesn't wobble.
It starts at random during a gesture and lasts until scrolling stops. It
occurs only on the external display, in both demos. Making the external
display the macOS main display didn't change it.

## Environment

Both captures used installed Firefox 156.0.1 with a fresh temporary profile,
closed DevTools, live 1 ms profiling, and the user's own trackpad. The source
was main `3484f65`; the idle-preparation prototype in the working tree was
disabled.

| Property | External capture `xRJClr` | Built-in capture `Z5EGQC` |
| --- | --- | --- |
| Display | LU28R55, 1920 × 1080 logical, 2×, 60 Hz | Built-in Retina, 1440 × 900 logical, 2×, 60 Hz |
| Page | 1900 × 965 CSS px | 1420 × 704 CSS px |
| macOS main display | Built-in | Built-in |
| Input | 90 s manual trackpad | 50 s manual trackpad |
| Retained profile window | Last ~55 s (buffer wrapped) | Complete |
| User jitter marks | 13, of which 6 fall in the retained window | None; the user saw no jitter |

The workload was the streaming demo with a private imported transcript. The
tracked setup,
[`imported-chat-marks.js`](../../scripts/firefox-profile/fixtures/imported-chat-marks.js),
records a mark each time the tester presses `j`.

```sh
pnpm run profile:firefox -- --display=LU28R55 \
  '--url=http://127.0.0.1:5173/demos/streaming/?profile-transcript=/browser-artifacts/TRANSCRIPT.md' \
  --layout=none \
  --setup=scripts/firefox-profile/fixtures/imported-chat-marks.js \
  --warmup-ms=15000 --manual-seconds=50 --live
node scripts/firefox-profile/input-cadence.mjs browser-artifacts/firefox/RUN
```

Keep manual captures to about 50 s. The 90 s capture overflowed the
profiler buffer and lost its first 31 s, including the runner's start mark.

## Method

Earlier investigations measured page callbacks and geometry, which stayed
regular while the user saw shifts. This investigation uses Firefox's
GPU-process and parent-process markers instead:

- `VsyncTimestamp` on the parent compositor gives the display's frame clock.
- `PAPZInputBridge::Msg_ReceivePanGestureInputEvent` on the parent main
  thread gives when each trackpad event is handed to APZ, the compositor's
  scrolling code.
- `WR OS Compositor frame` on the GPU renderer gives presented frames.

APZ applies all events that arrived before each composite. With one event per
frame, motion is even. If an event slips past the frame edge, that frame gets
no event and the next gets two. The analyzer counts events per vsync
interval, and counts alternations between zero and two or more as flips.
[`input-cadence.mjs`](../../scripts/firefox-profile/input-cadence.mjs) reads
captures whose buffer wrapped. Its portable checks cover even input, late
deliveries, and missing markers.

## Results

The two displays differ at the input stage and nowhere later in the
pipeline.

| Measure | External | Built-in |
| --- | ---: | ---: |
| Vsync period | 16.6669 ms | 16.6668 ms |
| Median input interval | 16.66 ms | 16.67 ms |
| Input interval p5 / p95 | 12.11 / 20.38 ms | 11.63 / 18.95 ms |
| Late inputs (more than 1.12 × period) | 8.7% | 5.7% |
| Frames with no event | 10.1% | 5.1% |
| Frames with two or more events | 8.5% | 4.4% |
| Flips per scrolling second | 4.59 | 1.29 |
| Parent-to-GPU input IPC p95 | 0.16 ms | 0.10 ms |
| Composite duration p95 | 2.4 ms | 2.4 ms |
| Presented interval while scrolling, p95 | 18.05 ms | 17.49 ms |
| Presented intervals over 25 ms | 40 | 16 |

Input and vsync run at the same rate. In every external gesture, events
arrived at 0.84–0.91 of the frame, about 2.4 ms before the next vsync. On the
built-in display, gestures arrived at either 0.84–0.88 or 0.02–0.21 of the
frame. Both displays leave a similar margin, so the margin alone doesn't
explain the difference. The external display's deliveries are noisier.

Late events don't coincide with work on Firefox's parent main thread. Only 1
of 262 late external events overlapped a parent-thread marker longer than
1 ms. The input IPC took under 0.3 ms at p99 on both displays. Composites
were short on both. The added noise therefore arises before the parent
process handles the event, in macOS event delivery or the application's
wake-up.

Four of the six retained jitter marks follow above-average flip density. The
flip rates in the 1.5 s before them were 7.41–8.32 per second, against 4.59
overall. One mark had an average rate (4.68), and one had no flips.

## Rejected hypotheses

These explanations were tested and don't fit the evidence:

| Hypothesis | Evidence against it |
| --- | --- |
| Runtime or demo main-thread work | APZ scrolls without the content thread; the only runtime wheel listener is passive; page frame timing stays regular. |
| Two display clocks drifting apart | Vsync and input both run at 60.00 Hz; the input phase stays stable across gestures. |
| A random phase per gesture | The external phase stays at 0.84–0.91 in all 15 gestures. |
| macOS pacing input to the main display | Making the LU28R55 the main display didn't change the jitter. |
| Parent main-thread contention | 1 of 262 late events overlapped parent-thread work. |
| Slow compositing or GPU load | Composite p95 is 2.4 ms on both displays. |
| Per-row layer snapping or header lag | The user sees whole-content shaking, not relative row or header movement. |

## Scripted input limitation

Native scripted gestures can't reproduce this defect. The capture helper's
ticks arrive about every 20.2 ms against a 16.67 ms frame. In scripted
captures, every fifth frame receives no input, which produces a regular
four-to-one stutter. Earlier scripted Firefox captures that reported regular
motion measured page callbacks, not this input pattern. Use real trackpad
captures for this issue.

## Limitations

This investigation establishes a measured correlation, not a root cause:

- One capture per display. The external capture retained 6 of 13 marks.
- The flip count is a proxy for uneven motion. It doesn't measure presented
  pixels.
- Pan timestamps are when Firefox's parent handled each event, not when
  macOS generated it.
- Safari 27 wasn't measured in this session. Shared macOS input would
  explain both browsers, but that remains unverified.
- The reason for noisier delivery on the external display is unknown.
  Candidates include the display connection, its timing, and macOS event
  coalescing for that display.

## Next steps

No runtime or demo change follows from this investigation. To narrow the
remaining cause, try these steps:

1. Repeat the external capture on another connection or with another 60 Hz
   monitor.
2. Record the equivalent Safari 27 timeline with native input, and compare
   wheel-event timing with presentation.
3. Compare Chrome on the external display, and check whether its build
   resamples scroll input to frames. Smooth Chrome scrolling with
   resampling would support this explanation.
4. If the pattern holds, report it to Mozilla and WebKit with these
   measurements.
