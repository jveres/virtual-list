# Safari momentum and Chrome scroll-to-top investigation

The Chrome capture recorded the first-scroll pause that the user noticed.
Two delayed animation frames coincided with long tasks in Chrome's GPU process.
The renderer main thread did not show a matching CPU stall.
The date-pill controls neither established nor excluded the pill as a contributor.
The later Safari export identified image-preview work inside scroll dispatches,
slow page-preparation callbacks, and separate long paints. It did not establish
the native compositor defect behind every visible shift. A measured follow-up
removes redundant source reads for inline images in the streaming demo. The
audit follow-up also fixes live-shrink reconciliation and restores the gallery
fade. Compositing hints and synchronous window reconciliation remain unchanged.

## Scope and environment

The source revision was `0307c94`. The user reported Safari jitter during
trackpad momentum, especially on the external LU28R55 display. The separate
Chrome symptom occurred during Scroll to top, with default and imported chats.

The initial diagnosis used an explicit exception to Firefox-first profiling:
it examined browser-specific failures before proposing a patch. The later
image-binding change was measured in installed Firefox first, then Safari.
Those focused measurements and their limits are recorded below.

| Property | Recorded value |
| --- | --- |
| Chrome | Installed Chrome 153.0.8010.50, headed, isolated temporary context |
| Safari | Installed Safari 27.0, build 22625.1.29.11.27 |
| External display | LU28R55, logical 1920 × 1080, scale 2, maximum 60 Hz |
| External origin | x=1440, y=0 |
| Chrome window | x=1440, y=31, outer 1900 × 1029 |
| Chrome content | 1900 × 942, devicePixelRatio=2, scroll viewport height 793 |
| Workloads | Default simulated chat and synthetic 160-turn rich-chat fixture |
| Capture | Four seconds per top-button click, DevTools UI closed |

The synthetic fixture included tables, code, math, tool panels, and local images.
The initial Chrome captures used no private conversation. Later Safari captures
used a user-supplied image transcript, as described below. Private inputs and raw
captures stayed local. The reported maximum refresh rate was not a measurement
of physical frame presentation.

## Chrome measurements

The first default-chat run contained gaps of 83.3 ms and 100.0 ms between animation
callbacks. The user noticed the hard stop in that run. The near-top gap ended at
836 ms, with the last sampled scroll position at 480.5 px.

| Workload or control | Clicks | Largest callback gap per click (ms) | Main-thread long tasks over 50 ms |
| --- | --- | --- | --- |
| Original default chat | 4 | 100.0, 17.5, 17.7, 17.6 | 0 |
| Rich fixture, same browser | 4 | 17.7, 17.5, 17.6, 17.7 | 0 |
| Unchanged default, fresh browser | 2 | 17.6, 17.7 | 0 |
| Pill paint hidden, fresh browser | 2 | 17.6, 17.7 | 0 |
| Sticky header disabled, fresh browser | 2 | 17.3, 17.4 | 0 |

Every run recorded movement and paging progress. No run recorded a blur or resize
invalidation, page error, or long-task observer entry. The original probe did not
record initial document focus or visibility changes. The retained tool adds these
guards. Regular callbacks alone do not establish smooth physical presentation.

### Trace correlation

Times below start at `top-probe-default-0-start` in the original default trace.
Thread CPU time measures execution on the CPU. Elapsed time also includes waits
and scheduling delays.

| Event | Start (ms) | Elapsed (ms) | Thread CPU (ms) |
| --- | --- | --- | --- |
| GPU process scheduler task | 269.307 | 125.111 | 3.383 |
| Associated `DawnPlatformImpl::RunWorkerTask` | 272.373 | 121.679 | 1.063 |
| GPU process scheduler task | 704.440 | 138.095 | 7.999 |
| Associated `DawnPlatformImpl::RunWorkerTask` | 712.358 | 130.018 | 3.547 |

The GPU process was PID 17454, thread 4826929. Its scheduler tasks came from
`gpu/command_buffer/service/scheduler.cc`. The Dawn worker tasks came from
`gpu/command_buffer/service/dawn_platform.cc`.

The renderer main thread was PID 17461, thread 4827034. Its longest recorded task
during the first 1,300 ms lasted 5.072 ms. This evidence points toward a delay in
Chrome's rendering pipeline, not a one-second JavaScript CPU task. It does not
identify the waiting resource or prove shader compilation. A Dawn event does
not imply that the application called WebGPU.

The first run reached scrollTop=0 at 1,253.1 ms. The later page insertion adjusted
the anchor at 1,489.2 ms. That page commit did not coincide with the near-top gap.
The measured callback interruption was 100 ms, not one second. Longer pauses
outside this capture remain possible.

## Date-pill hypothesis

The existing pill fix hides the duplicate inline pill through transparent paint,
without changing its geometry. The sticky overlay includes 12 px of bottom space
for its border and shadow. The pill uses a translucent background and a shadow,
but no backdrop blur. See `demos/shared/styles.css` and
`src/companions/sticky-headers.ts`.

The paint-hidden control preserved the inline pill's layout space and hid the
sticky overlay. The sticky-disabled control used the demo's existing option.
That option also changed the follow inset by 40 px, so it was not a pure
paint-only comparison.

All controls were smooth by callback timing, including the unchanged control.
The original failure did not recur, so the controls cannot attribute an
improvement to removal of the pill. Fresh browser processes do not guarantee
cold operating-system or graphics-driver caches.

Gallery contains no date-pill companion, but the user also reported Safari jitter
there. The pill cannot explain all reported Safari failures. A shared rendering
problem and a separate pill contribution remain possible.

## Safari evidence and limitations

The [September 16 investigation](safari27-scroll-investigation-2026-09-16.md)
preserves the earlier native measurements and rejected rendering changes. Its
user-supplied Safari timeline showed short JavaScript and layout work, with
some longer composite events. Those events did not identify a particular layer.
Neither that report nor this capture established the cause of momentum shifts.

The fresh Safari gallery attempt failed before input because the native helper
could not activate the capture window. Its initial document focus was false.
The run was excluded. The runner closed its own window and temporary server.
Even a successful synthetic native-input run would not replace real trackpad
gesture-release evidence.

The user initially could not provide a manual capture. The follow-up below
records a later real-trackpad capture. The initial measurements did not justify
a pill or compositing change.

## Follow-up with real trackpad input

The user later installed Safari Technology Preview and provided trackpad input.
The installed builds were Safari `22625.1.29.11.27` and Technology Preview
`22626.1.6.19.1`. Both reported version 27.0. The runner selected each application
by an allowlisted path and bundle ID, without closing unrelated windows.

### Additional Chrome evidence

The original trace recorded two `AnimationFrame::Presentation` gaps of 149.995 ms
and 149.994 ms. Their intervals were 276.421–426.416 ms and 726.421–876.415 ms
after the first top-click marker. These are browser presentation records, not
independent measurements of physical display output.

Renderer main-thread tasks occupied 7.336 ms and 1.752 ms inside those intervals.
The largest individual tasks lasted 3.193 ms and 0.615 ms. The GPU-process waits
therefore accompanied delayed presentation without continuous application CPU work.

The second delay followed the loader's appearance at 637.5 ms. A paint event at
638.4 ms identified the boundary spinner and its 52 CSS-pixel slot. No row-mutation
notification appeared between that loading-state change and the GPU task start.
This identifies spinner rendering as a test candidate, not a demonstrated cause.

An expanded trace of the unchanged repeat recorded raster flushes near the same
progress points. Their elapsed times were 2.620 ms and 13.022 ms. Associated Dawn
worker tasks lasted 0.830 ms and 4.940 ms, with cache-hit records. The original
trace lacked these detailed categories, so its slow tasks cannot receive the
same parent attribution with certainty.

Fresh Chrome controls `chrome-scroll-top/run-II3AKB` and `run-CG64HT` recorded
unchanged and hidden-spinner variants. Each contained two clicks, with maximum
callback gaps of 17.7 ms. The first glides still included roughly 33.3 ms
presentation intervals. Neither reproduced the severe delay. The control does
not establish a spinner fix or a performance gain.

The offline tool `scripts/firefox-profile/chrome-presentation.mjs` summarizes
presentation records and thread tasks. Its default window includes paging and
idle time after the glide. Do not compare those full-window gaps with
movement-only intervals. Six portable tests cover marker pairing, missing
telemetry, thread selection, invalid inputs, and JSON/gzip handling.

### Fresh Safari scripted captures

The following captures used the external display and the retained rendering
setup. Their native gestures had no momentum tail. CPU samples were enabled
for both chat runs, but not for the gallery run.

| Local run | Workload | Maximum callback gap | Mounts / removals | Scroll writes |
| --- | --- | ---: | ---: | ---: |
| `run-PNuCS7` | Small masonry gallery | 25 ms | 130 / 130 | 0 |
| `run-4geSxi` | Default chat, first capture | 214 ms | 9 / 9 | 0 |
| `run-1L4QRg` | Default chat, unchanged repeat | 24 ms | 9 / 9 | 0 |

The gallery's maximum moving callback gap was 19 ms. All 360 scroll deltas were
exactly 12 px in their gesture direction. The last scroll followed the last
wheel by 6–9 ms, which confirms that this was not a decaying-momentum workload.

The first chat capture contained a 214 ms gap at timestamps 6631–6845 ms. A wheel
event timestamped 6638 reached its listener at 6844, a 206 ms delivery delay.
Two mount notifications followed at 6846. An earlier 70 ms gap also preceded
the first mount notification. These records do not establish synchronous row
recycling as the immediate trigger. Mutation notifications do not timestamp the
exact DOM operation, and pending rendering work remains possible.

The coarse native sample placed 1,384 of 1,470 main-thread samples in the run-loop
wait. Fourteen commit-queue samples waited for remote image-buffer handles.
The sample lacks timestamps needed to assign that wait to the 214 ms interval.
The unchanged repeat did not reproduce the long delay.

### Real-trackpad default chat

Regular Safari capture `run-Ubl5Md` lasted 45 seconds. The user reported that it
was "butter smooth." The capture had no focus or geometry invalidations. Its
main manual-scrolling interval covered timestamps 26169–44646 ms.

| Main manual-scrolling interval | Result |
| --- | ---: |
| Wheel / scroll events | 958 / 899 |
| Mounted / removed rows | 116 / 113 |
| Moving callback gap, median / p95 / maximum | 17 / 18 / 24 ms |
| Wheel delivery delay, median / p95 / maximum | 8 / 15 / 19 ms |
| Application scroll writes | One settled prepend adjustment |

That prepend adjustment occurred 484 ms after the last wheel event and 916 ms
after reaching scrollTop=0. Two later programmatic glides accounted for 150
additional scroll writes, with no wheel events during either glide. The total
write count therefore does not represent repeated momentum interruptions.

The run establishes smooth behavior in this specific temporary-server window.
It does not establish a fix for the affected regular page or an image-heavy
import. The user subsequently requested a repeat with an image-heavy transcript.

Technology Preview capture `run-BswW3t` lost focus and is excluded from timing
comparisons. It cannot establish that Preview is faster or resolves the defect.
Other excluded captures were `run-7B21Oc` (hidden-pill control, activation failure)
and `run-CMKPgh` (Preview, initial document-focus failure).

### Image transcript and production control

The imported transcript contained 60 turns and occupied 26,555,344 bytes. Its
SHA-256 was
`8122aeb7134dde22e1d557df97b59ddd3f45a8d294532d48a64b6f68c7d4d93e`.
The runner confirmed the import and initial image readiness before capture.
Each run started with one mounted image, decoded without error or timeout.
The normal Safari windows used 1920 × 997 content at devicePixelRatio=2.

| Local run | Browser and server | Outcome |
| --- | --- | --- |
| `run-YgqSDy` | Safari, development server with HMR disabled | Valid capture. User reported a shift at the final top landing. |
| `run-ufHETg` | Technology Preview, HMR disabled | User reported a top shift. Focus loss excluded timing comparison. |
| `run-2NbaPq` | Safari, production build | Valid capture. User marked a top-landing shift without Vite client code. |
| `run-MYUx67` | Safari, production, pills hidden | User reported jitter throughout scrolling. Focus loss excluded performance comparison. |

The production runs loaded zero Vite clients, zero source TypeScript modules,
and 16 bundled JavaScript resources. Thus HMR was not necessary for the reported
top-landing symptom. This did not establish why other development-page runs
differed.

In `run-YgqSDy`, the final actual scroll positions were `6, 4, 2, 1, 0`, without
reversal or an oversized final correction. The first jitter marker followed
arrival at zero by 56 ms. The last glide had a maximum callback gap of 18 ms.
Three deferred row removals occurred 350 ms after arrival at zero, after that
first marker.

In production run `run-2NbaPq`, the marked glide also had an 18 ms maximum callback
gap. The pill switched from floating to inline 200 ms before arrival at zero.
This happened as scrolling crossed 58 to 48 px, across the retained 52 px loader
slot. Three row removals followed arrival by 350 ms. The jitter marker arrived
729 ms after landing, near stationary callback gaps of 83 and 49 ms. No scroll,
pill change, or row mutation coincided with those gaps. A delayed user marker
did not establish which earlier event caused the visible shift.

The hidden-pill control preserved inline layout but used `visibility:hidden`
and `display:none`. Those declarations changed rendering structure, so the
control did not preserve compositor layers. All 81 production JavaScript and
CSS assets were otherwise byte-identical to the normal production run.

All seven jitter markers in `run-MYUx67` preceded focus loss. There were no
top-button commands. The first three markers preceded any application scroll
write. The two writes were settled prepend adjustments. This preserved the
user's observation but did not prove that removing the pill caused a slowdown.
The gestures differed, and the whole run remained invalid for comparison.

### User-supplied Safari timeline

The user supplied a Web Inspector export after declining an Xcode installation.
The raw copy is local-only at
`browser-artifacts/safari-timeline-2026-09-20-JzunIU/recording.json`.
Its SHA-256 is
`9fe0a68e2e745b75aca3d3a060de6dbae2b76b49c6415a9b2311d435b4df8a3d`.
No new browser session or manual capture was requested for this analysis.

The recording covered 28.199 seconds and contained 10,217 records. Its script
URLs referenced the normal development demo on port 5173. Layout records showed
1420 × 997 document geometry, rather than the earlier 1920-wide test windows.
The export did not record monitor identity, display scaling, or the Safari build.
This was diagnostic evidence, not a matched performance comparison.

Times below are relative to recording start, `6.004401833` in the export.
Event durations are elapsed intervals, not independent CPU measurements.
Nested script, paint, and composite intervals must not be added together.

| Recorded event | Count | p95 duration | Maximum duration |
| --- | ---: | ---: | ---: |
| Composite | 1,449 | 3.153 ms | 35.010 ms |
| Paint | 697 | 0.420 ms | 25.488 ms |
| Layout | 293 | 0.451 ms | 1.361 ms |
| Forced layout | 54 | 0.745 ms | 1.311 ms |
| Style recalculation | 353 | 0.825 ms | 2.866 ms |

The enabled rendering-frame instrument exported no rendering-frame records.
Composite spacing therefore did not provide presented-frame or dropped-frame
counts. Of 456 JavaScript stack samples, 406 had timestamp zero. Their aggregate
weights remained useful, but they could not identify a particular timed event.

#### Image-preview work during scrolling

At 22.562–22.572 seconds, a 10.135 ms scroll dispatch contained a 9.825 ms
MutationObserver callback. Timed samples first showed `mountRow` appending a
row, then repeatedly showed the image-preview binding expression. A second
callback at 23.812–23.822 seconds lasted 9.903 ms inside a 10.227 ms scroll
dispatch and showed the same expression.

The served module mapped that expression to `imageId(message, ordinal, image.src)`
in `demos/streaming/image-preview.ts`. The observer rebinds images after row
changes. `bind()` reads `currentSrc || src`, then reads `src` again for identity
before its unchanged-binding return. The transcript contained large data URLs.
The trace directly located repeated work at that second `src` read. It did not
expose the browser's internal URL allocation or serialization operations.

Across the complete sample set, that expression received 111.372 ms of self
weight out of 444.009 ms. Most of that weight lacked timestamps. The two timed
clusters supplied the stronger evidence linking this work to scroll dispatches.
This was a demo-side cost, not evidence that the virtual-list reconciliation
algorithm alone consumed those intervals.

#### Historical-page preparation

Matching animation request IDs to their enclosing callbacks separated the
timer-rooted preparation chains from the click-rooted glide chains. A 140 ms
timer started the first 17 callbacks, from 11.680 to 11.985 seconds. They occupied
214.469 ms of the 305 ms interval. The longest callbacks lasted 33.202 and
34.269 ms, before the first recorded click at 12.399 seconds. They therefore
could not originate from that click's programmatic glide.

A second 140 ms timer started 22 callbacks with 94.238 ms total work and a
24.739 ms maximum. The two click-rooted chains contained 144 callbacks with
67.844 ms total work and an 8.358 ms maximum. The largest callbacks belonged
to the timer-rooted chains, not to the programmatic glides.

Aggregate stacks rooted in `stageFrame` carried 228 ms of sample weight, compared
with 16 ms rooted in the glide's `tick`. Image attachment construction and static
message rendering were prominent in the former. Twenty data-URL loads also
appeared in the network timeline. These records were consistent with queued
historical-page preparation, not a network-server wait. Missing sample timestamps
prevented exact attribution of each long callback.

The runtime's `stageFrame` checks its 3 ms budget after rendering each row.
A single synchronous render can exceed that budget before the runtime can yield.
The offscreen measurement root still uses the main thread. Smaller page batches
alone cannot bound the cost of one expensive row.

The 35.010 ms composite at 11.825 seconds overlapped the 34.269 ms callback.
It was not an independent 35 ms GPU or compositor CPU task. The half-second CPU
sample near this preparation phase peaked at 51% on the main thread.

#### Separate long paints

At 24.300 seconds, a 33.465 ms composite contained a 25.488 ms paint. A 4.398 ms
scroll dispatch preceded it, including a 4.044 ms image-preview observer. The
following style and layout work each took less than 0.5 ms.

At 24.512 seconds, another composite lasted 28.694 ms and contained a 17.397 ms
paint. Its preceding scroll dispatch took only 0.017 ms. These were separate
rendering outliers, not explained by slow layout or by a long scroll handler.

Their paint rectangles covered full-width strips near the document bottom:
`x=0..1420, y=878..1036` and `x=0..1420, y=914..1096`. That footprint was consistent
with newly exposed content rather than only the small date pill. The export
contained no DOM identity for those rectangles, so it did not identify the
specific row, image, or native rendering operation.

The next source change can target redundant image-source reads and repeated
large image-data processing. Its effect needs a comparable trace before any
claim of improvement. The separate paint/compositor path remains open. No
CSS change or complete jitter fix followed from this recording alone.

### Image-source candidates

The first candidate used the raw `src` attribute for identity in both mounted
images and the lazy navigation index. It passed correctness checks but failed
the native Safari performance comparison. With approximately 2 MiB data URLs,
80 row-observer callbacks took 364 ms before and 381 ms after this change.
Reading the raw attribute remained expensive. Removing the normalized getter
did not remove the large-string cost. This candidate was rejected.

The replacement reuses the already-read `currentSrc` for ordinary data-URL
images. Relative URLs and responsive images retain their original `src`-based
identity, since the selected source can differ from the logical source used by
navigation. When `currentSrc` is empty, the fallback `src` value is read only
once. The lazy navigation index, sanitization, and stored messages are unchanged.

Focused unit regressions use the real Markdown parser and DOM observer.
They cover relative and entity-bearing URLs, responsive sources, offscreen
navigation, duplicate URLs, source replacement and restoration, row movement
and rekeying, getter counts, and cleanup. The real-browser reconciliation
regression now supplies a message model and asserts zero normalized `src` reads
for loaded data-URL images. The unit getter regression also rejects redundant
raw-attribute reads.

The first two Playwright Firefox launches failed during macOS profile discovery.
Changing only the temporary directory did not help. The successful run isolated
`MOZ_APP_DATA` and `MOZ_LOCAL_APP_DATA`, as the native Firefox profiler already
does. Failed launches are not verification or performance evidence. Test-owned
temporary directories were removed after the successful run.

No virtual-list runtime, date-pill, or compositing CSS changed. The separate
long paints and the one-row page-preparation costs remain open.

Final verification passed: `pnpm run check`, `pnpm test` (1,058 tests in 47
files), and `pnpm run test:firefox-profile` (64 checks). The 10 new unit cases
include a base-URL change with an already-loaded image. Image reconciliation,
including data-URL replacement and Blob fallback, passed in Chromium, Firefox,
and WebKit. The full image-preview regression passed in Firefox and WebKit.
`pnpm run format` completed without changes.

#### Matched source-work measurements

The final comparison used installed Firefox 156.0 first, then installed Safari
27.0, build `22625.1.29.11.27`. Both used the external LU28R55 at 1920 × 1080
logical pixels, DPR 2, and 60 Hz. Firefox's page viewport was 1920 × 965;
Safari's was 1920 × 997. Each browser's baseline and candidate matched.
DevTools were closed. The fixture used synthetic 64 × 64 PNGs with valid,
inert PNG metadata padding: URL lengths were 524,286 and 2,097,150 characters.
This isolated long-source handling, not large-image rasterization.

The baseline was `0307c94`. The candidate changed only image binding; attachment
and static-content module hashes stayed unchanged. The image-preview source
SHA-256 changed from
`d31bfdc31e6ac1e0e1bf670f2ef70c557bf04779fefd57d1ac4e614654204c12` to
`3f938ada98383d5963386a65c48967f5a4a7c55457a05556b7510f52cdaf6eae`.
The comparison server froze these sources at startup.

Each case ran five repeats of eight operations. Row insertion/removal produced
80 observer callbacks; alt-text changes produced 40. The table gives total
instrumented observer elapsed time across those callbacks, in milliseconds.

| Browser | URL length | Row changes, baseline → candidate | Alt changes, baseline → candidate |
| --- | --- | ---: | ---: |
| Firefox 156 | About 0.5 MiB | 94 → 30 | 60 → 23 |
| Firefox 156 | About 2 MiB | 231 → 98 | 132 → 64 |
| Safari 27 | About 0.5 MiB | 173 → 19 | 100 → 12 |
| Safari 27 | About 2 MiB | 394 → 20 | 200 → 11 |

At each size, redundant `src` reads fell from 120 to zero. All 120 selected-source
reads remained. Safari's combined 2 MiB callback total fell from 594 to 31 ms;
Firefox's fell from 363 to 162 ms. Getter intervals are nested in observer
intervals and must not be added to them.

These results demonstrate reduced image-binding work, not a complete scroll
fix. They are elapsed-time instrumentation, not a sampled CPU profile. The
clock resolution was 1 ms. Each revision used one page with repeated cases,
not five independent browser runs. Mutation-case wall time includes timer
yields and is not the observer-work metric. There was no scrolling or physical
presentation measurement. The fixture does not reproduce the recorded large
paints or private image contents.

The valid final reports are under `browser-artifacts/image-source/`:
Firefox `run-eZm86O` → `run-p7wnwy`; Safari `run-ZajtuP` → `run-sQICaS`.
Two earlier Safari candidate launches failed their initial focus assertion and
supplied no timing evidence. The final reports had no focus invalidations.
Owned windows, Firefox profiles, and comparison servers were cleaned up;
the pre-existing demo server and user browser sessions were preserved.

#### Page-preparation candidates not adopted

Cloning a prepared image did not materially improve Safari construction:
40 direct image constructions took 195/201 ms in the final two pages, versus
190/192 ms for cloning. Preparing the clone template also added first-use work.

A short Blob URL made repeated attachment construction much cheaper, but
JavaScript base64 decoding plus the first chip cost 6/7 ms, compared with
5/11 ms for the direct first chip. This did not establish a reliable first-use
gain. A native `Uint8Array.fromBase64` variant measured below 1/1 ms in Safari
and 2/2 ms in Firefox. It is a promising next candidate, not production proof:
these were single first-call observations after the fixture image was decoded.
Zero in these reports means below timer resolution, not free work.

No Blob cache was added. Such a change needs bounded ownership and cleanup,
canonical image identities, unchanged stored/exported/provider bytes, and
preserved intrinsic image dimensions. Static message construction remains
expensive: 40 constructions of the 2 MiB fixture took 1,182/1,184 ms in Safari.
The image-binding change does not reduce that rendering cost.

### Limits of the proposed engine-race explanation

The source confirms synchronous reconciliation and compositing hints. It does
not prove one backing surface per row or a stale Core Animation scroll offset.
The earlier all-mounted control had no user confirmation of physical smoothness.
Both connected displays currently report a maximum refresh rate of 60 Hz.

The relevant [WebKit change](https://github.com/WebKit/WebKit/commit/80eaeca1f565e58a3df57b5d6b2a77cb40446dea)
dates to April 28, 2026. It reduces a race involving programmatic scroll or
anchoring requests and backing-store updates. It does not establish that an
ordinary mount causes the same race, or that the fix is exclusive to Preview.
A matched browser-version difference can narrow the cause, but cannot identify
the precise engine defect by itself.

## External audit follow-up

The external review stopped before adversarial verification. Its consensus
identified useful investigation targets, not a confirmed engine root cause.
The follow-up separated source facts from unmeasured platform behavior.

| Candidate | Follow-up result |
| --- | --- |
| Boundary layer changes | Mounting and removal are synchronous. Actual native layer allocation and stale compositor offsets remain unverified. Unchanged row translations already skip writes. |
| Declared-row recreation | Confirmed, but intentional. Destruction on retirement is a tested lifecycle and memory contract. Unbounded retention is not an equivalent fix. |
| Live geometry changes | Allowed by the live-mode contract. A separate, reproducible clamp/reconciliation defect is fixed below. Ordinary same-height mount observations already exit without committing. |
| Synchronous image decoding | Not established. A missing decoding hint means automatic browser selection. The padded 64-pixel fixture does not measure raster decoding. |
| Tiled chat layers | Unverified. CSS width and DPR alone do not establish native backing-store allocation. |
| Top landing | The existing landing hold already delays measured-row departures until settle. The engine-race attribution remains unverified. |
| Extra sticky scroll listener | Disproved for streaming chat. It imports the companion directly and supplies onState/onViewport. Only the unused compatibility wrapper enables observeScroll by default. |
| Gallery fade | Confirmed CSS cascade defect, now fixed for either stylesheet order. Cached images stay instant and reduced-motion disables the transition. |

### Live shrink exposes stale row heights

Two deterministic tests reproduced a live-mode defect. A tail shrink clamped the
browser upward and exposed an earlier dirty row. The runtime mounted that row
but left its committed height unchanged until another event.

In the first case, the exposed slot stayed at 100 pixels instead of 200. In the
second, successive dirty-row shrinks stopped at scrollTop 4400 instead of 4250.
Both failures occurred without an explicit scrollTop write.

The fix consumes newly eligible dirty measurements after an upward browser
clamp. Each pass removes dirty work. The ordinary non-clamping path uses one
pass. Reconciliation and publication happen once, after the final measurements.
The fix does not freeze live updates or change mounting and destruction rules.
Later-pass measurement and host-predicate failures also have regression tests.
The runtime publishes already-committed geometry before surfacing such failures,
and leaves uncommitted dirty work available for retry. Rows above the final
anchor remain deferred. The tests require one final state publication.

Final verification passed: all 1,062 unit tests, `pnpm run check`, and all 64
profiling-tool checks. The real-layout browser regression passed single and
successive clamp cases in Firefox, Chromium, and WebKit. It asserts mounted
slot heights and zero explicit scrollTop writes before another event can repair
the result. These browser cases use synthetic input only to open a scroll phase.

An installed-Firefox comparison used the external LU28R55, DPR 2, 60 Hz, and a
1900 by 965 page viewport. The workload imported the synthetic 160-turn rich
chat and performed four upward native gestures, each with 90 ticks. Both runs
moved from scrollTop 20697 to 12057, produced four scrollend events, and wrote
scrollTop zero times during capture. DevTools were closed.

| Diagnostic | Before | After |
| --- | ---: | ---: |
| Capture duration | 9.94 s | 10.19 s |
| Scroll events | 355 | 358 |
| Animation callback p95 | 17.22 ms | 17.22 ms |
| Animation callback maximum | 17.64 ms | 17.60 ms |
| Content main-thread CPU | 256.5 ms | 221.6 ms |
| Scroll-handler maximum | 1.531 ms | 1.149 ms |

The local run IDs are `run-W9FzSp` and `run-cywY8D`. This single pair is a
regression check, not evidence of a speedup or smooth physical presentation.
It does not reproduce real trackpad momentum or exercise the forced-shrink
case. The separate deterministic tests establish that correction. An earlier
run, `run-Y2B583`, spent its two downward gestures at the bottom and is excluded
from the comparison.

### Rejected ordered-message cache

Ordered assistant messages render text segments around tool panels. Unlike
ordinary messages, this path does not use the demo's message HTML cache.
Large inline-image segments exceed the renderer's own cache-entry budget.

A diagnostic-only source overlay compared passthrough rendering with a
per-message segment cache. It changed no application file. In installed Firefox
156, 40 repeated constructions of a synthetic 2 MiB image reply took 1,741 ms
without the cache and 142 ms with it. Actual Markdown rendering accounted for
1,615 ms in the uncached case and zero warm calls in the cached case. The source
still passed through innerHTML in both variants. Cold construction was separate.

This improvement does not apply to the reported scroll path. Measured chat rows
retain their rendered content when unmounted. Ordinary re-entry does not build
them again. Paging eviction and message updates clear the owning HTML cache.
Those later rebuilds therefore remain cold under the proposed cache lifetime.

The cache patch was rejected. A cache benchmark cannot justify extra retained
memory without an actual repeated-render path. Safari recorded an uncached
diagnostic page only. Its cached comparison and further repeats were cancelled
after this lifecycle check. No cross-browser cache speedup is claimed.

The local benchmark runs are Firefox `run-ExW8LQ` and `run-LCypRX`, plus Safari
`run-9hhHPT`. All used the external display, had no focus invalidations, and
passed the post-timing DOM comparisons for edits, tool offsets, and tool state.
These measurements isolate synchronous construction, not image decode or paint.

### Local artifact cleanup

The profiler refused to start with less than its required 10 GiB free. With
user approval, cleanup compared SHA-256 hashes of each plain capture and its
decompressed gzip copy. It removed 98 matching plain copies, reclaiming
7,767,506,306 bytes. All compressed captures remained available.
Eight obsolete per-experiment Swift caches were also removed. They are
regenerable. The active shared compiler caches, reports, scripts, metadata,
and unique recordings were retained. Free space increased from about 9 GiB
to about 19 GiB before new captures.

After verification, the same hash check removed three new plain-profile
duplicates, reclaiming another 171,174,803 bytes. The combined cleanup removed
101 plain copies and reclaimed 7,938,681,109 bytes, with every compressed capture
retained.

## Remaining-findings review after `5dd2a8b`

The user reported that Safari jitter was almost gone, with occasional shifts in
both demos. This feedback did not isolate which preceding change helped. This
follow-up preserved the application code and compositing CSS.

The review started with installed Firefox 156.0, then used Safari 27.0 for the
engine-specific questions. All runs used the external LU28R55 at 1920 × 1080
logical pixels, DPR 2, and maximum 60 Hz, with DevTools closed. Firefox's page
was 1900 × 965; Safari's page was 1920 × 997. Native scripted gestures verified
movement and release events, but did not generate a real trackpad momentum tail.

An optional source overlay recorded numeric mount, position, height, and
preparation events. It added no layout reads to the animation sampler. Image
snapshots recorded dimensions and decoding policy only at capture boundaries.
No capture exceeded the 50,000-event limit. These diagnostics added work and did
not measure physical display presentation.

### Runtime geometry and image decoding

| Capture | Workload | Mounts / unmounts | Actual resize changes / live passes | Largest callback gap |
| --- | --- | --- | --- | --- |
| Firefox `run-o3toYS` | Masonry baseline, two down/up rounds | Not instrumented | Not instrumented | 17.66 ms |
| Firefox `run-q6RVh9` | Same workload with numeric audit | 180 / 180 | 0 / 0 | 17.64 ms |
| Safari `run-lcwFP7` | Small masonry, native CPU sampling | 130 / 130 | 0 / 0 | 268 ms |
| Safari `run-om7h5o` | Small masonry, no CPU sampling | 129 / 129 | 0 / 0 | 24 ms |
| Safari `run-SqGQ4B` | Imported image chat, three up/down rounds, CPU sampling | 16 / 16 | 0 / 0 | 76 ms |

Both Firefox runs recorded 328 scroll events, four scroll ends, no programmatic
scroll writes, and successful paging. Content-main-thread CPU was 322.8 ms over
10.05 seconds in the baseline and 354.8 ms over 10.12 seconds with instrumentation.
Maximum scroll-handler time was 2.24 ms and 2.07 ms respectively. This single
pair checked diagnostic behavior; it did not establish a performance change.

Gallery paging wrote canvas height once per audited pass. All recorded row
height commits kept the previous height, and existing row offsets did not
change. The chat pass recorded no height commits, image loads, or canvas changes.
These runs did not reproduce the proposed live-resize contributor. They did not
exclude it for late-loading images or other inputs.

The unsampled Safari gallery run began at scrollTop 317 instead of zero. It was
not a matched control for the sampled run. CPU sampling also added overhead.
The largest sampled callback gaps had no nearby audited runtime events. These
gaps alone did not establish a mounting defect or a sampling-induced defect.

Safari's native stacks included image decoding on `org.webkit.ImageDecoder`
workers, including in chat, where images used `decoding="auto"`. Therefore, the
claim that a missing decoding attribute necessarily caused synchronous raster
decoding was unsupported. The sample did not establish asynchronous decoding
for every image. Gallery already requested `decoding="async"`.

Layer-tree transaction stacks appeared in the native sample. The sample did not
identify native layer counts, tiled backing ownership, or stale presented
offsets. Those compositor claims remained unverified.

### Confirmed page-preparation stall

Two unsampled Safari captures clicked Scroll to top twice after a native up/down
round in the same imported image chat. Both loaded two earlier pages. Their final
scroll position was 4,784 px with total height 25,759 px: the prepend preserved
the old visible anchor rather than leaving it at zero.

The runtime-only capture, `run-PhphxH`, recorded a 36 ms row preparation and a
37 ms preparation frame. Its largest animation callback gap was 43 ms. The
attribution capture, `run-bxBRV5`, separated these synchronous operations:

| Operation | Calls | Total elapsed time | Maximum call |
| --- | --- | --- | --- |
| Preparation frame | 23 | 289 ms | 37 ms |
| Row construction and retention | 37 | 257 ms | 37 ms |
| Markdown rendering | 42 | 99 ms | 11 ms |
| Ordered-message innerHTML assignment | 21 | 47 ms | 5 ms |
| Attachment image `src` assignment | 4 | 88 ms | 34 ms |

These operations nested; their totals must not be added. Timer resolution was
approximately 1 ms. The attribution run's largest callback gap was 52 ms.

The slowest attachment assignment passed a 1,552,274-character data URL to
`img.src`. It occupied 34 ms inside a 37 ms row preparation. The other three
assignments took 25, 20, and 9 ms. This was synchronous source-assignment cost,
not proof of synchronous raster decoding. The runtime's preparation budget
could yield between rows, but could not interrupt a single synchronous renderer.
Neither capture recorded a ResizeObserver mismatch or live-commit pass.

The sibling markdown-viewer checkout matched the pinned `v0.4.0`. Static review
confirmed that glyph geometry was published once per document, with a new
measurement after a DPR change, rather than on every row mount. Its pipeline
already distinguished generated HTML from raw HTML for sanitization. The measured
rendering cost did not justify changing sanitizer guarantees or compositing CSS.
No renderer change was made.

The clearest remaining optimization target was the demo's attachment display
source. A Blob URL experiment would need bounded ownership, revocation, stable
preview identity, and unchanged export/provider data. The earlier synthetic
conversion timings did not substitute for this real paging workload. This review
did not implement that change or claim that it would resolve gallery shifts.

### Reproduce the numeric audit

Start the isolated Firefox diagnostic server, then run the normal native runner:

```sh
node scripts/firefox-profile/runtime-audit-server.mjs 4196
pnpm run profile:firefox -- --display=LU28R55 --url=http://127.0.0.1:4196/demos/gallery/ --layout=masonry --down=2 --up=2 --ticks=90 --live
```

Stop the diagnostic server after the run. It disables HMR and applies exact-match
source overlays without editing application files. Changed source targets fail
explicitly. Audit data is stored in `frames.json.runtimeAudit`.

Safari owns its server and production build. Use `RUNTIME_AUDIT=1` with the
existing native runner; add `TOP_COMMANDS=2` for the streaming button path:

```sh
RUNTIME_AUDIT=1 SERVE_MODE=production DEMO=gallery GALLERY_LAYOUT=masonry GALLERY_SIZE=s ROUNDS=2 node scripts/firefox-profile/safari-scroll.mjs
RUNTIME_AUDIT=1 TOP_COMMANDS=2 SERVE_MODE=production DEMO=streaming MATCH_OPTIONS=1 CHAT_FILE=/path/to/local-chat.md ROUNDS=1 node scripts/firefox-profile/safari-scroll.mjs
```

The runner waits six seconds after each top command and records whether the
button was available. Check paging progress and errors before interpreting a
capture. `SAMPLE=1` adds native CPU sampling and its overhead. Safari stores audit
data in `capture.json.runtimeAudit`. Private inputs and captures remain ignored
and local. This follow-up changed diagnostic tooling and documentation only.

Verification passed: formatting, `pnpm run check`, all 68 profiling-tool tests,
and all 1,062 unit tests. The first sandboxed unit run blocked 24 localhost relay
tests; the rerun with loopback permission passed. The owned diagnostic server
and profiling processes were closed. The user's existing server and browsers
were left running.

## Retained tooling and next measurement

The offline Safari analyzer reads a Web Inspector JSON export without opening
a browser. It reports absent instruments, overlapping durations, and untimed
samples explicitly. It excludes network payloads and removes source URL queries
and directory paths from its output.

```sh
node scripts/firefox-profile/safari-timeline.mjs /path/to/recording.json
pnpm run test:firefox-profile
```

The source-work fixture and comparison server are also retained. Start each
server in a separate terminal; the runner owns only its test browser, not the
server supplied in its URL. Stop both servers after measurement. The runner
requires the native helper built by the Safari diagnostic and the external
display geometry described above.

```sh
node scripts/firefox-profile/image-source-server.mjs 0307c94 4196
node scripts/firefox-profile/image-source-server.mjs working 4197
node scripts/firefox-profile/run-image-source.mjs firefox http://127.0.0.1:4196/scripts/firefox-profile/fixtures/image-source.html '{"lengths":[524288,2097152],"repeats":5,"iterations":8}'
node scripts/firefox-profile/run-image-source.mjs firefox http://127.0.0.1:4197/scripts/firefox-profile/fixtures/image-source.html '{"lengths":[524288,2097152],"repeats":5,"iterations":8}'
```

Repeat the two runner commands with `safari` for the Safari comparison. Source
hashes, browser and display details, invalidations, and raw measurements are
saved in ignored local reports. This fixture does not substitute for native
scroll profiling or the user's trackpad momentum capture.

The reusable diagnostic is `scripts/firefox-profile/chrome-scroll-top.mjs`. It requires the
existing demo server on port 5173 and an external display at x=1440. It opens
installed Chrome in a temporary context and closes its browser on completion.
Its animation sampler records cached scroll positions without DOM layout reads.
Its scroll listener, mutation observers, and accessor instrumentation add cost.
Treat the output as diagnostic evidence, not a benchmark of uninstrumented use.

```sh
node scripts/firefox-profile/chrome-scroll-top.mjs --help
node scripts/firefox-profile/chrome-scroll-top.mjs
PROBE_DEFAULT_ONLY=1 PROBE_VARIANT=no-pill-paint node scripts/firefox-profile/chrome-scroll-top.mjs
PROBE_DEFAULT_ONLY=1 PROBE_VARIANT=sticky-off node scripts/firefox-profile/chrome-scroll-top.mjs
```

Raw captures stay under ignored `browser-artifacts/`. The original captures are
in `scroll-investigation-2026-09-20/`. Their filenames distinguish `default`,
`rich`, `current-repeat-default`, `no-pill-default`, and `sticky-off-default`.
Each workload has a `-trace.json.gz` and a `-measurements.json` file. The failed
Safari report is `safari-native-scroll/run-dVavRr/report.json`.

The original trace used `devtools.timeline,blink.user_timing,toplevel,v8`.
Later controls added `gpu,cc,skia,disabled-by-default-gpu.service`. This changed
capture overhead, so these runs are not a matched performance-gain comparison.
The retained tool uses the expanded categories for future matched runs.

The next useful Chrome capture must reproduce the first-scroll delay with these
expanded categories. Safari's saved timeline now supplies concrete code and paint
costs, but not native display-present events. Preserve the current rendering
setup while addressing source-attributed work. Do not claim that regular page
callbacks prove correct physical presentation.
