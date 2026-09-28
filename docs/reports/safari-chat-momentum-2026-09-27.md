# Safari chat momentum correction

The user reports no content shifts during trackpad momentum after adding a
compositing hint to Safari's mounted normal-flow rows. Normal row recycling
remains enabled. The control that kept visited rows mounted still shifted.

The baseline is `v0.4.1`, commit `759e479`. This investigation is a
Safari-specific exception to the Firefox-first workflow. The report covers
image-heavy chat scrolling, not the separate gallery fade limitation.

## Conditions and observations

Three 30-second manual captures used installed Safari 27.0, build
22625.1.29.11.27, with DevTools closed. The LU28R55 display used 1920 × 1080
logical pixels, 2× scaling, and 60 Hz. Safari's content area was 1920 × 997;
the chat viewport was 848 pixels tall. Each owned test window imported the
same local 46-turn transcript, containing 27,721,797 bytes. Private content
was served in memory through an unguessable localhost route.

The user flicked and released the trackpad, letting momentum continue. All
three captures retained focus and display geometry, recorded actual movement
and scroll-end events, and had no page errors. Each loaded the older page,
increasing scroll height from 10,761 to 20,551 pixels.

| Control | Local run | Mounts / unmounts | User observation |
| --- | --- | ---: | --- |
| Released runtime | `run-JJUoqy` | 83 / 83 | Shifts during momentum |
| Keep visited rows mounted | `run-SgBZkP` | 45 / 1 | Still shifts |
| Normal recycling, native row layers | `run-ofKZYw` | 119 / 120 | No shifts |

The retained-row control still removes the loading slot. It excludes ordinary
row retirement as the sole cause, but does not eliminate mounting or paging.
All three captures record zero JavaScript `scrollTop` assignments, no
ResizeObserver height changes, and no differences in committed row heights.
The setter instrumentation does not cover browser anchoring or `scrollTo()`.

The animation-frame p95 is 17 ms in every run. Gesture distances and timing
differ, so these are diagnostic controls, not comparable timing benchmarks.
No jitter key marks were recorded; user assessments apply to each whole run.
Regular callbacks do not prove smooth physical presentation. The exact WebKit
compositor mechanism remains unconfirmed.

Two earlier attempts are excluded: a stale audit hook prevented one from
loading, and the other lost foreground to another application.

## Runtime change

This decision was superseded by the
[September 28 image-layer comparison](safari-image-layers-2026-09-28.md).
Whole-row promotion did not remain smooth in subsequent user testing.
The following describes the historical change, not the current default.

Positioned slots already use `will-change: transform`; the native anchoring
path omitted it. Safari's mounted native slots now receive the same hint,
using the existing WebKit capability guard. The canvas keeps its existing
compositing settings. Other engines retain their native slot styles.

The hint adds no scroll writes, timers, layout reads, or retained rows. Hidden
measurement slots reset their styles, spacers receive no hint, and normal
unmounting bounds the connected slots that can request layers. GPU memory
usage was not measured.

## Reproduction and checks

The capture summaries, workload hash, exact commands, source hashes, and
source patches remain under ignored `browser-artifacts/safari-native-scroll/`.
Raw capture files were deleted. Each runner closed its owned Safari window
and server while preserving the user's browser windows.

To repeat with the current runtime, replace the transcript path and run from
the repository root:

```sh
CHAT_FILE=/path/to/local-transcript.md SAFARI_DISPLAY=external \
  DEMO=streaming RUNTIME_AUDIT=1 MANUAL_SECONDS=30 \
  node scripts/firefox-profile/safari-scroll.mjs
```

Wait for the recording announcement before scrolling. Use
`COMPOSITING=flat-rows` to remove only the new hint, or
`COMPOSITING=row-layers` to force it on. `RECYCLING=retain` is an unbounded
diagnostic control, not a production setting. The runner records native
anchoring mode and a mounted row's computed compositing styles before capture.
The repaired audit and retirement controls have portable checks against the
current runtime source.

The native image-recycling browser regression uses synthetic decoded images
and checks bounded mounting, DOM reuse, computed hints, and row coordinates
through repeated traversal in Firefox, Chromium, and WebKit. It verifies
geometry, not physical trackpad presentation. Run it with:

```sh
pnpm run test:regression -- --group=runtime --match=native-image-recycling
```

The style/type check, all 1,074 unit tests, and all 128 portable profiling
checks pass. Browser checks pass for native anchoring, animation, gliding,
image recycling, retargeting, prepend anchors, image previews, image
reconciliation, and image/cursor spacing. Every measured prepend position
change is zero in both chat demos across all three engines.
The newspaper regression also passes all four layouts at desktop and mobile
sizes in Firefox and WebKit, including native top/bottom commands.
