# Streaming scroll regression investigation

The investigation found and corrected three Firefox release-handling edge cases,
including a deterministic path that strands held paging work. The original
intermittent stall was not reproduced in the manual capture; the user reports
no stall so far with the candidate. A later live Safari inspection confirmed a
consumed top trigger after trackpad paging. A Safari candidate now holds
above-anchor changes through wheel momentum as well as touch momentum. The user
confirms that paging now works. Later gesture and insertion captures identified
two position-shift defects: a stale canvas minimum height and image rows that
shrink on mounting. Both have failing baseline regressions, and the user confirms
both local fixes. The intermittent top-button failure remains open.

The user reports that Safari's top button can fail even after scrolling has
stopped. The investigation therefore includes idle commands and button hit
targets as well as momentum takeover.

## Observations

The workload is the default simulated chat, with 102 messages. Installed
Firefox 156.0.1 and Safari 27.0 (22625.1.29.11.27) run on the external LU28R55,
1920 × 1080 logical pixels, 2× scaling, and 60 Hz. Browser windows are at
1440, 31 with outer size 1920 × 1049. Content viewports are 1920 × 965 in
Firefox and 1920 × 945 in Safari. Test sessions are isolated, with DevTools
closed. Safari-specific navigation and compositing controls are the exception
to Firefox-first testing.

The regular Firefox page was inspected without a reload. Opening its console
changed the viewport width, which can settle held paging work. By the time
the DOM snapshot was obtained, the status was `loaded 25-96/102 · load top`,
with no active bottom loader. This is not a capture of the original failure.
The console was closed and the user's browser remained open.

Native scripted traversal loaded older pages, evicted the tail, and restored
newer pages in both browsers. Repeated top clicks, Safari clicks immediately
after native input and after 100/350 ms, and rapid repeated Safari clicks all
reached their committed destinations. Runtime instrumentation recorded no
row-height changes. These results do not establish smooth physical rendering.

Additional Firefox input controls used native gesture phases with a decaying
momentum sequence, a held pause followed by increasing deltas, and an increasing
momentum tail. All three received a release and committed the held bottom page.
They are generated native sequences, not recordings of physical trackpad input.

The Firefox settle controller intentionally waits for a release at a loadable
edge. Losing or invalidating that release can leave fetched work waiting. That
is a source-level lead, not an established cause of this user's failure. A
generic timeout would weaken the existing protection against commits during a
held gesture, so none was added without a failing trace.

## Corrected Firefox edge cases

Deterministic controller and runtime tests exposed three failures after the
manual capture:

- A decaying wheel marker between release confirmation and its queued animation
  frame cancelled both the frame and the release. With no later `scrollend`,
  held pages never committed. The candidate cancels only the frame, then uses
  the existing delta classifier: decaying input extends the confirmation
  window, while increased energy, direction changes, and line/page input still
  invalidate the release.
- Recording the first wheel before starting its phase lost the input flag when
  phase initialization reset it. An edge release could then use the shorter
  generic cooldown. Phase initialization now precedes recording that input.
- After earlier user input, a wheel taking over a landed command could inherit
  that command's pending settle. A queued page then committed without the new
  wheel gesture's release. Firefox now retains only a classified edge release
  across renewed input; a command's landing cooldown is cancelled.

The tests fail before these changes and pass afterward. Coverage includes both
edges, a late decaying tail, and renewed input during the queued commit. Existing
held-gesture protection remains: an unconfirmed or invalidated release cannot
commit from silence alone. This is a fix for demonstrated state-machine defects,
not proof that every reported stall has the same cause.

## Live Safari top-loader failure

The user reproduced the failure with a trackpad gesture in the regular Safari
page. Inspection used AppleScript without reloading, opening DevTools, or moving
the scroll position. The window was on the LU28R55 at DPR 2, with a 1920 × 998
content viewport and an 849-pixel chat viewport. This differs from the isolated
capture's browser chrome geometry, so it is correctness evidence rather than a
matched performance comparison.

The page showed `loaded 49-102/102 · load top`, `scrollTop: 0`, a native-flow
canvas, an idle top loader, and messages 49–52 mounted. The top button was
enabled and visible. A temporary interception of the existing reach controller
confirmed `armed.start === false`, no pending signals at either edge, and a live
controller. This interception restored the original method immediately and
suppressed one reach observation rather than triggering another load.

A controlled `request("start")` followed by `update` at the unchanged position
loaded messages 25–72 and moved the viewport to 10,647 pixels, preserving access
to the prepended history. The start trigger was armed again. This confirms the
immediate blocker; the event sequence that originally consumed it was not
recorded. Compact evidence is under ignored
`browser-artifacts/safari-paging-live-2026-09-29/`.

Source review found a related unsafe path: WebKit touch momentum held prepends,
but wheel momentum could commit them before settling whenever the position was
more than two pixels from an edge. That path depends on the browser applying a
native anchor adjustment. A missing adjustment leaves the viewport in the old
reach zone, with a consumed trigger and displaced content.

The candidate applies the existing WebKit touch rule to wheel phases too. It
keeps native-flow layout and native scrolling; above-anchor changes wait for the
settle commit, where the runtime writes the preserved reading position. Work
confined below the reading anchor can still commit without moving it. No retry
timer or compositing change is added.

The new unit and browser cases fail before the change because a wheel-held
prepend commits early. Coverage includes both update APIs, a 30-pixel near-top
position, repeated traversal to the first page, and fault injection that disables
the browser's anchor adjustment while keeping native-flow layout. These checks
exercise the candidate mechanism; they do not reconstruct the unrecorded gesture
or establish that severe physical stuttering is fixed.

## Bottom correction and image-row shifts

The user later reported smooth motion with occasional shifts at settlement or
after loading, and supplied two repeatable paths in the open image conversation.
These were inspected in the regular Safari tab without DevTools. Its content
viewport was 1920 × 997 at DPR 2 on the same external display. The observations
are geometry evidence, not a frame-presentation benchmark.

A bottom-button capture landed at 20,530 pixels without a correction. A physical
trackpad capture then reached Safari's actual limit of 20,590 pixels. At
settlement, the application requested a second smooth scroll back to 20,530.
The canvas retained a minimum height 60 pixels larger than the runtime's pin
floor. Elastic overscroll also occurred, but the persistent 60-pixel mismatch
and subsequent application request are separate from that bounce.

Native commits defer ancestor sizing because changing it during a gesture can
suppress browser anchoring. If a commit finished all its other work, settlement
did not refresh that deferred minimum height. The candidate tracks a pending
floor change and commits it at settlement even with no pending rows. A synthetic
removal regression checks the physical scroll limit against modeled geometry
and rejects a later backward follow animation. It fails before the fix and
passes in Firefox, Chromium, and WebKit.

The top-button capture, after reloading the same conversation, preserved the
old reading row at 92 pixels through the prepend. A later measurement commit
moved it to 86 pixels. The image suspension helper had forced CSS block images
to `inline-block` while their sources were absent, adding a six-pixel line gap.
Restoring their sources also restored block layout, shrinking the rows. Repeated
shrinks during traversal account for the changing pin floor in this capture.

The candidate uses a CSS fallback with zero specificity for suspended inline
images, so the renderer's block-image rules remain effective. Sources are still
released while rows are retired or prepared. The image lifecycle regression now
includes actual image-only paragraphs as well as inline images; the new block
case fails by six pixels before the fix and preserves both image and row height
afterward in all three browser engines.

After reloading the same Safari conversation, the user confirmed both fixes:
top loading keeps content still, and a trackpad gesture to the bottom no longer
triggers a correction after settlement.

Compact numeric evidence and source patches are under ignored
`browser-artifacts/safari-bottom-correction-2026-09-29/` and
`browser-artifacts/safari-top-image-shift-2026-09-29/`. Temporary page hooks and raw
records were removed. No private transcript text or image data is retained.

## Rejected Safari controls

The later [compositing comparison](compositing-memory-2026-09-29.md) corrects
Safari process attribution and distinguishes message hints from canvas hints.
Use that comparison for the current decision; the historical runs below may
include other applications' newly launched WebKit processes.

Two isolated controls tested removal of the new message compositing hint while
retaining the narrowed canvas and image-memory fixes. Each used the same
six-cycle text allocation workload from the [memory workflow](../memory-profiling.md).

| Control | Largest process peak | Final-cycle range | Result |
| --- | ---: | ---: | --- |
| Remove message promotion | 886 MiB | 100 MiB | Exceeds peak and settling budgets |
| Remove message promotion and flatten the canvas | 879 MiB | 66 MiB | Exceeds peak and settling budgets |

Neither control was retained. The existing 768 MiB Safari process-peak and
40 MiB final-range budgets were not raised. The controls do not establish
whether either variation improves the reported visual shifts.

A subsequent live comparison temporarily removed message promotion for the
user's gestures, then restored it. The user described both states as smooth,
so this comparison does not establish a compositing benefit. No override was
retained. The subsequent position-shift captures above provide concrete
geometry failures without changing the compositing policy.

To repeat the message-promotion comparison, open
`/demos/streaming/index.html?debug-compositing=no-message-layers`. This debug flag
sets message `will-change` to `auto` in every browser; image hints and the canvas
are unchanged. The override is outside the WebKit feature query. Checks in
Firefox, Chromium, and WebKit verify that it overrides a message promotion hint.
It survives reloads through the URL and writes no stored setting. Remove the
parameter to restore normal behavior. The normal memory gate omits this flag;
the rejected controls above explain why it is not the default.

Normal Chrome and Firefox rows already have `will-change: auto` while idle;
the persistent message promotion is WebKit-specific. The user observed 89 MB
with the flag and 149 MB without it in Chrome Task Manager, with similar
performance. A style check in installed Chrome found the same idle message
hint in both states, so these readings do not establish a memory reduction
caused by the flag.

After comparing the flag across browsers, the user reports no noticeable
scrolling-performance difference in any browser. This provides no observed
presentation benefit for persistent message promotion. It does not measure
allocation, and the earlier Safari controls used more memory without the hint.
The default remains unchanged pending a valid memory comparison.

## Regression validation

The candidate passes 1,117 unit tests, 143 portable profiling checks, and all
54 browser regression scripts across chat scrolling, runtime behavior, and
image lifecycle, display copies, preview, and reconciliation. The type and lint
check passes with an existing boundary-spinner selector warning.

A six-cycle Firefox image-memory recheck on the reference display also passes
the unchanged budgets. Whole-browser cycle totals are 1,141, 1,241, 1,208, 1,202,
1,190, and 1,172 MiB. The largest process peak is 473 MiB, median growth is
negative 17 MiB, and the final-three-cycle range is 30 MiB. Every fixture row
and image is visited. Compact evidence is under ignored
`browser-artifacts/memory/firefox-images-JfJyQk/`.

Two Safari memory rechecks stopped before the workload and provide no new
memory result. One could not read a selected process footprint; the other
could not activate its isolated browser for document focus. Both remain marked
invalid, with compact records under `memory/safari-images-7JD119/` and
`memory/safari-images-fZih6d/` in the same ignored artifact directory. The earlier
passing Safari references remain separate from these incomplete rechecks.

## Capture the unresolved failure

Use the new diagnostic with the default chat and the same display:

```sh
node scripts/profile-scroll-state.mjs --browser=firefox --scenario=manual --seconds=45
```

Start the gestures only after the runner prints `RECORDING`. Press
**Control+Option+M** when the problem is visible. The runner closes its owned
browser when the capture ends. Use `--browser=safari` for Safari. The `paging`
and `takeover` scenarios supply scripted native input for repeatable correctness
checks; they do not replace a physical momentum capture.

The diagnostic server overlays state readers and event hooks onto source served
only to its own browser. It records pending window jobs, native animation
ownership, release cancellation, gesture settlement, paging transitions, and
button pointer input, clicks, command starts, and command results. Native request
and result hooks, plus wheel input during a command, separate a missed click
from an input cancellation or a browser animation that stalls. Runtime scroll
writes are recorded separately from browser motion. The existing runtime audit
records height changes separately.
There is no animation-frame sampler or per-frame row-layout read. The diagnostic
adds work and is not suitable for comparing production frame timings.

Only bounded state transitions, counters, checkpoints, source hashes, the source
patch, and the exact reproduction command survive under ignored
`browser-artifacts/scroll-state/`. Raw events, profiles, helper binaries, and
temporary browser/Vite data are removed. A stationary, interrupted, overflowing,
resized, or unfocused capture is rejected.

The runner completed its installed-Safari validation with four observed top
clicks, 766 wheel events, 886 scroll events, 12 scroll ends, seven settlements,
and zero row-height changes or page errors. The Firefox takeover validation
recorded seven top commands, all completing successfully, with no height changes
or page errors.

A later installed-Safari takeover capture recorded seven clicks, seven native
requests, and seven successful completions, with zero height changes or page
errors. It does not reproduce the intermittent ignored-button report.

## Physical trackpad capture

A 45-second Firefox capture completed on the same external display. Input began
about 22 seconds into the recording. It recorded 627 wheel events, 517 scroll
events, 25 scroll ends, and no page errors, focus loss, or row-height changes.
Four top commands completed successfully; a fifth was still animating when the
recording ended, so its outcome is unknown.

Two bottom loads completed after approximately 1.8 and 3.4 seconds. In the
second, a fetched page was held at the bottom, a release candidate arrived,
and subsequent wheel input invalidated that candidate. A later `scrollend`
allowed the page to commit. Both loaders cleared before the capture ended.
This establishes a cause of the recorded delay, not of an indefinite stall.
The user confirmed that the failure did not reproduce in this attempt. There
was no user failure marker in this capture. Compact evidence is in the
ignored `browser-artifacts/scroll-state/firefox-7BtRGt/` directory, with its source
patch and reproduction metadata.
