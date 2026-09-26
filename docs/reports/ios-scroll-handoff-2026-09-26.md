# iOS scroll handoff investigation

The scroll-settle demo now uses native smooth scrolling for its top and bottom
buttons. The user confirmed that tapping these buttons during swipe momentum
works smoothly on an iPhone after the change.

## Button correction

The lab still used the frame-driven `startGlide` implementation after the
streaming demo had moved to `startNativeGlide`. The replacement uses the same
destination checks, stale-scrollend rejection, quiet fallback, and cancellation
as the streaming demo. It leaves queued paging changes behind the animation's
settle, preserving the lab's purpose.

The new browser regression replaces an existing browser animation with each
button command. Before the change, the first Firefox case recorded 28 direct
`scrollTop` writes. After the change, Firefox, Chromium, and WebKit each use one
native smooth request per command, no direct frame writes, and reach both
destinations. This is command correctness evidence, not a replay of iOS momentum
or a measurement of physical display smoothness.

## Chat paging remains open

The user separately reported that the top loader sometimes disappears while
older messages remain unreachable after swiping through the default chat. The
affected devices are an iPhone and an iPad. No physical-device reproduction has
been captured for this failure yet.

Mobile-sized WebKit checks at 390 × 844 and 1024 × 1366 CSS pixels, DPR 2, load
every default-chat page. The phone-sized loaded starts advance through
73 → 49 → 25 → 1; the tablet-sized starts advance through 61 → 25 → 1. Each
prepend preserves the old reading position and allows scrolling into an older
message. Synthetic touch and scroll-end events cannot establish that the iOS
asynchronous scroll range is correct during real momentum.

The device tracer now includes paging status transitions, native scroll-end
events, current scroll range, anchoring mode, and window-update outcomes.
With `--state`, non-pausing debugger probes distinguish canceled preparation
from a committed page whose native scroll range becomes stuck. Use it with an
existing local `ios_webkit_debug_proxy` connection and the streaming demo open:

```sh
node scripts/firefox-profile/ipad-scroll-trace.mjs \
  ws://127.0.0.1:9222/devtools/page/PAGE_ID --state
```

This is a correctness diagnostic with debugger overhead. The runner retains
source hashes, a replay patch, bounded state transitions, and aggregate motion
in `summary.json`. Per-frame records stay in memory and are removed when the
probe is disposed; the runner no longer writes raw device traces to disk.
The probe expires after 30 seconds without polling and removes its hooks.

## Tail restoration follow-up

The user also reported a pause before bottom navigation when the tail has been
evicted, including an immediate stop of existing swipe momentum. The current
implementation interrupts the gesture before staging the tail, then starts
native animation after the prepared window commits. The
[staged-restoration report](staged-tail-restoration-2026-09-25.md) records this
latency tradeoff. The [responsive tail-navigation follow-up](responsive-tail-navigation-2026-09-26.md)
starts movement during preparation. The user confirmed prompt, smooth behavior
both from rest and during momentum. The separate top-loading failure remains
open.

## Verification

Run the focused browser checks with:

```sh
pnpm run test:regression --match=settle-demo-command
pnpm run test:regression --match=chat-touch-paging
```

The type/style check, all 1,052 unit tests, both browser regressions, and all
124 portable profiler checks pass. Local-server tests require loopback access;
restricted runs failed with `listen EPERM` and were repeated with that access.
