# Safari streaming scheduling investigation

The previously unexplained late pause follows streaming-trail disposal. It
delays queued tasks as well as animation frames, moves earlier with a shorter
fade, and disappears when the trail is disabled. It survives disconnecting the
automation driver and disabling optional probes. The exact native cost remains
unattributed; this investigation does not establish a visible jitter fix.

Two reusable methods were added: `--scheduler` for task/frame/lifecycle
correlation, and `--safari-detached` for a capture without a live Inspector
client. Two upstream CSS candidates failed to remove the pause and were
rejected. The released renderer remains `v0.8.2`.

## Conditions and scope

This Safari-specific investigation is an explicit exception to the
[Firefox-first workflow](../firefox-profiling.md). Safari 27.0, build
`22625.1.29.11.27`, ran on LU28R55 at 1920 × 1080 logical pixels, 2× scaling,
and 60 Hz. The window was at `(1450, 31)`, outer size 1900 × 1049, with a
1900 × 945 page. All valid runs retained that geometry and focus.

The deterministic fixture used 160 history turns, 48 reply sections, a
12-second stream, and a 20-second capture. It delivered 44,230 characters in
461 text chunks and 466 events, including tools, code, tables, math, and images.
Its hash was
`b871a8159e958823e1b309e72bc3ef2f0a48590998de7e3af2b786951cf594d9`.
These were follow captures, not manual trackpad or imported-transcript trials.
The measurements do not establish physical display presentation.

The consumer baseline was `6a1ea23` with renderer `v0.8.2`, upstream commit
`6bcb22706d687120116f31b718e68a0efa9a6579`. Each of the three distinct control
rounds used no more than three Safari attempts. Compact local summaries and
source replay metadata remain under ignored `browser-artifacts/chat-profile/`.

## Separate frame gaps from delayed tasks

The new probe records callback entry time alongside the supplied animation
timestamp. It also measures a rescheduled 16 ms timer, one posted task per
animation frame at most, and synchronous animation callback durations. Direct
trail-layer/group removals are timestamped at mutation-observer delivery.
Slow callbacks can include bounded function source for anonymous attribution.

This adds evidence where Safari lacks Long Tasks and Long Animation Frames
entries. It does not turn timer delays into JavaScript CPU measurements or
posted-task delays into paint durations. The animation sampler still reads
cached values only. The [workflow guide](../streaming-chat-profiling.md)
describes overhead, interpretation, and the exact commands.

The first round used timing mode with scheduling probe version 1:

| Trail | Final layer removal | Largest frame interval | Maximum timer lateness | Maximum posted-task delay | Moving p95 / max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Long, 1200 ms | 14,051 ms | 75 ms | 54 ms | 67 ms | 21 / 40 ms |
| Short, 600 ms | 13,406 ms | 79 ms | 66 ms | 72 ms | 20 / 34 ms |
| Off | None | 29 ms | 14 ms | 15 ms | 19 / 29 ms |

The late long/short gaps were stationary and occurred immediately after the
final trail layer was removed. Their callback-entry gaps were 73 and 77 ms,
so this was not merely an odd animation timeline timestamp. The change in
pause timing tracks the changed fade duration. Disabling the trail is a causal
control, not an equivalent visual workload or a shipped fix.

The new metrics also distinguish other gaps. The long-trail run had a 40 ms
moving interval near stream startup, while overlapping timers were only 1 ms
late and the posted-task delay was at most 6 ms. The detached diagnostic run
later recorded a similar 37 ms moving gap with three timer deliveries, at most
1 ms late, and a 3 ms posted-task delay. Those observations do not support
attributing the entire moving gap to continuous JavaScript blocking.

Run IDs are `safari-timing-H9RGcL`, `safari-timing-Ii7L0G`, and
`safari-timing-lnQ8U3`, respectively.

## Rejected upstream controls

The second round used diagnostic mode, the long trail, and scheduling probe
version 2, which adds bounded source text for slow callbacks. Both candidates
were built from an isolated upstream `markdown-viewer v0.8.2` checkout and
temporarily packaged for the consumer. No installed dependency was edited.

| Upstream CSS control | Largest frame interval | Posted-task delay at disposal | Outcome |
| --- | ---: | ---: | --- |
| Released `v0.8.2` | 87 ms | 76 ms | Baseline |
| `.markdown-viewer { position: relative; }` | 78 ms | 70 ms | Pause remains |
| `.markdown-viewer { isolation: isolate; }` | 77 ms | 68 ms | Pause remains |

Keeping the containing block positioned did not resolve the pause. Isolating
blending to the viewer did not resolve it either. These results do not justify
either persistent CSS change. The normal baseline's disposal interval included
about 1 ms of instrumented image-preview work and no overlapping recorded rAF
callback work. Native rendering or other uninstrumented work still needs
attribution; the probe cannot identify layout, paint, GC, or IPC from this alone.

The candidate patches are retained as small replay inputs in
`browser-artifacts/rejected-streaming-candidates/safari-positioned-host.patch`
and `safari-isolated-host.patch`. Apply each separately to upstream `v0.8.2`,
install its locked dependencies, build/package it, and install the resulting
package in an isolated consumer checkout before replaying its capture. The
patches contain only the corresponding CSS rule and comment.

Run IDs are `safari-diagnostic-99vQzV`, `safari-diagnostic-SF8Iib`, and
`safari-diagnostic-Hnc2zW`. No new renderer tag was issued for rejected changes.
The consumer manifest was corrected to explicitly name
`github:jveres/markdown-viewer#v0.8.2`; its lockfile already resolved that tag's
commit, so the installed implementation did not change.

## Disconnect the automation client

The installed Safari MCP tool list exposes page evaluation but no native
timeline recording/export command, consistent with WebKit's
[published tool list](https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/).
Xcode's `xctrace` is unavailable on this machine. The new detached capture is a
control for the live Inspector connection, not a replacement for native traces.

A graceful driver exit closed the automation window before measurement.
`safari-diagnostic-JHLQUG` therefore failed and supplies no timing evidence.
Terminating only the owned driver with `SIGKILL` left its Safari page alive.
The page completed the stream and exported its own recording, after which the
runner closed the owned Safari process.

| Detached capture | Largest interval | Location | Moving p95 / max |
| --- | ---: | --- | ---: |
| Diagnostic with scheduler | 86 ms | Immediately after final trail removal | 20 / 37 ms |
| Timing, optional probes off | 84 ms | Same late window near 14 seconds | 19 / 26 ms |

The diagnostic pause delayed its timer by 80 ms and its posted task by 77 ms.
The timing control still recorded an 82 ms callback-entry gap. The pause thus
does not require live driver traffic or the added scheduler/operation probes.
Connecting Inspector before capture could still have lasting effects; this is
not proof of a session that was never inspected.

Run IDs are `safari-diagnostic-oNIo40` and `safari-timing-7vr4lw`. The first
prototype armed a delayed page timer before disconnecting. The retained method,
validated by the final timing capture, uses a local server gate: the page cannot
start until the driver has exited. It also rejects an unfocused or hidden page.
Transport identity prevents mixing connected and detached captures in the
comparison tool.

## Verification and remaining work

Repository checks, unit tests, and all 113 portable profiler checks passed.
The browser regression passed in Firefox, Chromium, and WebKit with scheduling
telemetry enabled. It checks completed input, movement, callback/task records,
trail removal, and the manual keyboard/export path. Portable checks cover
callback returns, exceptions, cancellation, bounded buffers, cleanup, focus,
server gating/cancellation, incompatible CLI options, and timing interpretation.
These correctness checks are separate from installed-Safari performance evidence.

Raw captures are removed automatically. Rejected packages, the temporary
upstream checkout, generated caches, and owned browser/driver/server processes
are cleaned up; compact reports and reproduction inputs are retained. The
original user browsers and development servers are preserved.

The next discriminator is a native trace around final trail disposal, using
[Web Inspector Timelines](https://webkit.org/web-inspector/timelines-tab/) in a
separate diagnostic trial. The useful interval is now known, and a live-driver
control exists. The remaining moving gaps also need native rendering or physical
presentation evidence; they cannot all be treated as the same JavaScript stall.
