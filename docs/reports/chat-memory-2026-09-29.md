# Streaming chat memory investigation

The investigation identified excess memory from duplicate image decodes and
retained offscreen image resources in Firefox, oversized composited surfaces in
Safari, and temporary pixels retained by Safari's display-copy worker. The
candidate reduces these costs. This is a memory result, not a claim that every
physical scrolling jitter is resolved.

Subsequent Safari content shifts and navigation failures, and a Firefox bottom
loader stall, remain under investigation in the
[scroll regression follow-up](scroll-regressions-2026-09-29.md). Passing the
memory gate does not close those reports.

## Environment and method

The baseline application revision is `888fbfd`. Measurements use installed
Firefox 156.0.1 and Safari 27.0 (build 22625.1.29.11.27), on macOS 27.0 / 26A428.
The external LU28R55 is 1920 × 1080 logical pixels, 2× scaling, and 60 Hz. Windows
occupy its usable area; content viewports are 1920 × 965 in Firefox and
1920 × 945 in Safari. Browser profiles/sessions are isolated and DevTools closed.

Firefox was investigated first, with native macOS input and then repeated
allocation stress. The stress loop sends 80 steps up and 80 down, 900 CSS pixels
per step, every 40 ms, with 700 ms edge pauses. Each trial repeats this loop six
or twelve times. No comparison variant has more than three completed trials.

The process counter reads physical footprint, resident bytes, and lifetime
physical-footprint peak through `proc_pid_rusage`. Process sums can include
shared accounting. Peak figures below are the largest individual process peak,
not the sum of unrelated process peaks. There is no forced GC or global
low-memory notification.

Ordinary checkpoint sampling missed Safari's worst allocations: memory could
already be reclaimable when the sample ran. The lifetime peak and the graphics
categories from `footprint --wide` exposed that behavior. Firefox's
`about:memory` reporters separated image surfaces, GPU texture hosts, and JS.
These detailed reports are collected after the measurement loop.

## Firefox findings

The default text chat did not reproduce unbounded Firefox growth. Six native
cycles stayed at 918–937 MiB for the whole browser; the largest process peak was
452 MiB. Six instant-step cycles stayed at 898–994 MiB, with a 461 MiB process
peak. The chat process itself was much smaller than the combined parent/GPU and
other browser processes. A whole-browser total near 1 GiB is not, by itself,
evidence of a growing chat heap.

The image fixture did reproduce excess allocation. It imports 48 turns with 24
distinct 4000 × 3000 JPEGs, generated locally without private transcript data.
The baseline reached 2,091 MiB total and a 911 MiB process peak.

The image reporters showed approximately 590 MiB of decoded surfaces and a
matching amount in GPU texture hosts. This included original images, full-size
2048 × 1536 display copies decoded by `probe.decode()`, and additional copies
scaled for actual display. The display-copy workaround intended for Safari was
also running in Firefox, where original images already downsample for display.
Limiting that workaround to WebKit reduced the image trial to a 1,510 MiB maximum
total and 618 MiB process peak, but did not fully solve retention.

Cached virtual rows kept image sources alive after retirement. Removing `src`
from retired rows with known dimensions, then restoring it when the row mounts,
released those decoded and GPU resources. Preparation uses the same reservation
so a row need not decode an image merely to establish its height. Unknown-size
and responsive images retain their original loading behavior. There are no new
viewport observers or image placeholder assets.

A twelve-cycle candidate trial reached a 1,151 MiB maximum total and 466 MiB
process peak. Its final three totals were 1,105, 1,095, and 1,097 MiB; the median
fell by 52 MiB from the first three cycles. The idle chat content process was
168 MiB. A separate category check reduced the retained decoded-image and
texture-host counters from roughly 590 MiB each to roughly 15 MiB each.

The first source-release prototype exposed image-box and inline-baseline
regressions. Browser checks now cover the image height, full surrounding row
height, a second retirement before decode finishes, style restoration, newer
sources, and responsive-image exclusions. Temporary sizing must remain until the
restored image supplies intrinsic dimensions. These refinements require the
final memory repeat described below.

## Safari findings

The text-only baseline reached a 1,211 MiB process peak over twelve cycles even
though checkpoint totals were only 380–443 MiB. Its idle WebContent report still
contained about 1,923 MiB of reclaimable unmapped graphics memory. This implicates
graphics backing allocation rather than a large live JS heap.

The chat column was already 860 CSS pixels wide, but its composited canvas
covered the full 1920-pixel scroll surface. Constraining that canvas to the
existing column width avoids backing the empty gutters. Promoting the actual
message content, within that bounded width, reduced the transient peak further.
The rule applies only to the streaming demo, and message promotion is WebKit-only.
The scroll viewport remains full width.

The exploratory controls were deliberately separate:

| Text-only control | Cycles | Largest process peak |
| --- | ---: | ---: |
| Existing application | 12 | 1,211 MiB |
| Remove canvas promotion and preserve-3d | 6 | 1,669 MiB |
| Paint containment for hidden measurement rows | 6 | 1,124 MiB |
| Promote full-width row slots | 6 | 907 MiB |
| Flat canvas plus promoted slots | 6 | 1,389 MiB |
| Remove message layout/style containment | 6 | 1,227 MiB |
| Paint containment on the viewport | 6 | 1,124 MiB |
| Constrain canvas to the existing column | 6 | 854 MiB |
| Constrain canvas and promote message content | 6 | 678 MiB |

A content-only promotion control was interrupted by hot reload after four
cycles. It is invalid evidence. Removing canvas promotion was not retained.

The production candidate's twelve-cycle text trial peaked at 708 MiB, with a
maximum checkpoint total of 626 MiB. The last three totals were 596, 604, and
614 MiB; idle total returned to 370 MiB. Reclaimable unmapped graphics fell to
about 352 MiB in the idle WebContent report. The image-heavy candidate trial
peaked at 720 MiB and ended with totals of 591, 594, and 606 MiB. These results
show bounded caches over the measured workload, rather than zero graphics cost.

## Regression gate and remaining validation

The reusable [memory workflow](../memory-profiling.md) adds an exit-code regression
gate for process peaks, total footprint, repeated growth, and final-cycle
variation. It rejects missing counters, stationary or incomplete work, page
errors, and changed display geometry. The image fixture verifies actual decoded
image coverage and stable document height; keys alone are insufficient because
prepared hidden rows can contain keys without ever displaying their images.

Native-input experiments exposed a workload problem: reversing an ongoing
gesture could defer older-history commit, leaving only half the images in the
active data window. Those captures are invalid. The canonical image workload now
loads the complete finite data window before measuring. Native input uses
smaller deltas and explicitly checks scroll-end delivery. An active-stream check
also now records streaming during the cycle, rather than only at its endpoint,
because the fast reply can finish before the first checkpoint.

The desktop locked during the initial investigation. Window-placement failures
were rejected, and the runner now checks console-lock state before launching and
at each checkpoint.
A temporary sleep assertion prevents idle display sleep while a capture runs.
It cannot unlock a locked desktop. After unlocking, the final Firefox and Safari
image comparisons pass the tightened gate. Firefox also passes six native-input
cycles (`memory/firefox-images-vPJJCa`): all 24 image rows decode, height stays at
26,204 px, wheel and scroll-end events arrive, and the final three totals are
1,174, 1,170, and 1,176 MiB. Its process peak is 478 MiB. Earlier measured trials
remain identified separately from this final gate. The final Safari streaming
trial (`memory/safari-streaming-bHz3n0`) also passes: it observes streaming during
the first cycle and completion by idle, with a 709 MiB process peak and a 17 MiB
decline in the first-to-last median. Native Safari passes after the worker
cleanup described below. The Chrome image control remains a budget failure.
A headed private-transcript memory comparison has not run; its
content and geometry coverage is described below.

The unit suite passes (1,106 tests), and the portable profiler suite passes
(137 checks). All 49 affected chat browser scripts pass, along with the
three-engine native image-recycling and width-resize regressions. The strengthened
image-lifecycle checks pass in Firefox, Chromium, and WebKit. No release or claim
of complete cross-browser memory verification is made at this stage.

After the worker cleanup, the code check, all 1,106 unit tests, all 137 portable
profiler checks, and the four image regression scripts pass again. The image
scripts cover display copies, source retirement/restoration, preview behavior,
and image reconciliation. A direct Firefox script launch hit macOS 27's profile
discovery failure; running through the repository's temporary application-data
wrapper resolves it. The existing CSS specificity warning is unchanged.

A supplementary headless check imports the supplied local image-heavy transcript
in all three engines. Both traversals visit all 46 turns and 27 image-bearing
rows, and document height remains 20,601 px. This verifies restored content and
geometry, not external-display memory or physical presentation. No private file
contents are retained.

## Reproduction and retention

Keep the canonical synthetic fixture and regression tools in
`scripts/firefox-profile/` and `scripts/regressions/`. New runs save source hashes,
a patch against the revision, exact commands, browser/display metadata, compact
measurements, and cleanup status under ignored `browser-artifacts/memory/`.
Raw profiles, full process reports, temporary browser profiles, and exploratory
helpers are disposable after analysis.

Measured trial identifiers are:

| Observation | Local trial |
| --- | --- |
| Firefox native text baseline | `memory-investigation/run-Xy35O4` |
| Firefox stepped text baseline | `memory-investigation/run-aYa83Y` |
| Firefox image baseline | `memory/firefox-images-calYJq` |
| Firefox display-copy restriction only | `memory/firefox-images-u38CUn` |
| Firefox twelve-cycle image candidate | `memory/firefox-images-STAptT` |
| Safari text baseline | `memory-investigation/safari-3euwYp` |
| Safari combined CSS control | `memory-investigation/safari-VOYOJ4` |
| Safari twelve-cycle text candidate | `memory/safari-text-gJkyzc` |
| Safari twelve-cycle image candidate | `memory/safari-images-EDa6zo` |

Early exploratory probes predate the final runner's source/validity metadata.
Their baseline application was clean `888fbfd`; the table and controls preserve
what was measured. The newer command reproduces the allocation workload with
stricter preparation and validity checks, not an exact replay of those probes.
Private input is never promoted into the fixture or a durable report.

## Remaining footprint after the growth fix

The follow-up asks whether a stable plateau is still unnecessarily expensive.
The runner now records a fresh blank page at the target geometry before loading
the chat, plus another blank page ten seconds after navigating away. These are
whole-browser physical-footprint sums, not exclusive per-tab RAM measurements.
The after-navigation sample follows the category diagnostics, which also affect
browser caches. Navigation can retain the old chat in the back/forward cache;
only the fresh blank page is independent of the chat's allocations.

The final image-lifecycle implementation passes the strengthened Firefox image
workload in `memory/firefox-images-DLYgx5`. All 48 turns are traversed, all 24
image rows decode, and document height remains 26,204 px. Twelve cycles reach a
1,250 MiB maximum total and a 502 MiB process peak. The last three totals are
1,179, 1,175, and 1,178 MiB, with a 46 MiB decline in the first-to-last median.

| Firefox checkpoint | Whole-browser footprint |
| --- | ---: |
| Fresh blank page | 692 MiB |
| Default text chat loaded, before scrolling | 869 MiB |
| Image chat after twelve cycles and ten seconds idle | 1,178 MiB |
| Blank page after navigating away and diagnostics | 862 MiB |

At idle the chat content process accounts for 219 MiB, the GPU process 435 MiB,
and the main browser process 309 MiB. The diagnostic reporters still show only
about 15 MiB of decoded image surfaces. They also report 77 MiB of two-byte JS
string allocations in the chat process; those counters alone do not establish
which strings are redundant. Substantial memory remains in browser processes
after navigating away, but that observation does not separate browser caches
from a cached chat document. The 692 MiB fresh-browser baseline establishes that
the full 1.2 GiB cannot be attributed to retained rows. It does not establish an
irreducible minimum.

A Firefox-only control removes the canvas transform while preserving all other
behavior (`memory/firefox-images-cPaaCg`). It passes coverage and geometry checks
but provides no meaningful saving: the final-three median is 1,190 MiB versus
1,178 MiB, and the process peak is 498 MiB versus 502 MiB. The temporary CSS rule
was removed. A few MiB of variation does not justify changing compositing.

Safari's final image trial (`memory/safari-images-I3bRTH`) also passes twelve
cycles, full decoded-image coverage, and the same stable 26,204 px document
height. Its fresh blank page uses 182 MiB and its loaded text chat 336 MiB.
Image-cycle totals range from 418 to 470 MiB; the process lifetime peak is
687 MiB. Idle total is 460 MiB, including 324 MiB in WebContent. A rounded
`performance.timeOrigin` changed by 1 ms in an earlier attempt; that attempt was
rejected. Reload detection now uses an injected document identity instead of
assuming a clock value is bit-for-bit stable.

The native Safari image workload then exposed additional avoidable allocation.
Before explicit worker cleanup (`memory/safari-images-Gj99cg`), six cycles
plateaued at a final-three median of 667 MiB but reached a 775 MiB process peak,
failing the 768 MiB peak budget. The display-copy worker closed its source bitmap
after drawing, but left temporary canvas pixels for garbage collection. It now
shrinks that canvas after encoding and closes any surviving source bitmap on
failure. Output dimensions, encoding quality, and the full-resolution original
are unchanged.

With that cleanup (`memory/safari-images-TgZjkq`), the same six-cycle native
workload passes: final-three median is 426 MiB, about 36% lower, and process peak
is 712 MiB. All 24 image rows decode and document height remains 26,204 px.
The confirmation (`memory/safari-images-b7ooW3`) has a 459 MiB final-three median
and 751 MiB process peak, with the same coverage and geometry. The two fixed
trials therefore reduce the steady total by 31–36%; peak savings are smaller and
more variable. This comparison uses three trials: one baseline and two fixed
runs. No budget was increased.

The remaining footprint is not a proven minimum. The Firefox canvas experiment
found no useful saving; remaining string and graphics allocations need ownership
evidence before further changes. Reductions must preserve image quality, row
geometry, and scrolling behavior.

## Chrome control and limits

Chrome's six-cycle large-image control (`memory/chrome-images-5xoOTs`) stays
bounded but fails the provisional 600 MiB process-peak budget: its GPU process
reaches 999 MiB, while cycle totals range from 1,325 to 1,356 MiB. The fresh blank
page already reaches a 593 MiB GPU-process lifetime peak. The current budget is
therefore not a calibrated Chrome release gate, and this control does not prove
a new application regression without a comparable original-code baseline.

Restoring display copies in Chrome (`memory/chrome-images-mq8UL7`) increases the
process peak to 1,200 MiB and cycle totals to 1,438–1,494 MiB. That experiment was
reverted; only WebKit uses display copies in the final candidate. The failed
results and unchanged budget remain recorded. Chrome's peak allocation needs
separate attribution and baseline calibration; it is not included in the
Firefox/Safari pass claim.
