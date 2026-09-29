# Scroll handler audit, September 29, 2026

The loading spinner animated an inherited CSS property across the entire chat.
Moving its rotation onto the spinner reduced main-thread CPU time by 21% in the
first matched Firefox comparison, with 55% less style recalculation. The local
spinner change is retained at the user's request. A follow-up CSS change cuts
another 18% of main-thread CPU and 66% of style recalculation relative to a fresh
baseline with that fix. The user accepted both changes. A subsequent renderer
fix reduces end-follow CPU by 9% in a separate workload and is released from
`markdown-viewer` as `v0.8.8`. The user confirmed its trail still renders correctly.
These captures do not establish that intermittent presentation jitter is resolved.

The measured scroll handler itself is small. The audit found no expensive
synchronous scroll-handler loop that justifies changing anchoring or window
reconciliation.

## Conditions

Both diagnostic captures used installed Firefox 156.0.1, build 20260921121718,
a fresh temporary profile, closed DevTools, and the LU28R55 at 1920 × 1080 logical
resolution, 2× scaling, and 60 Hz. The browser viewport was 1900 × 965. The source
was commit `3dec64e2c38a373e5d70f6ff27fde810df33404f` plus the retained working-tree
patch, including the confirmed partial-collapse and terminal-branch fixes.

The deterministic stream contained 48 rich sections, 44,230 characters, and
461 chunks over about 12 seconds, with 160 history turns. Ten native upward
scroll bursts exercised reading during streaming and older-history paging.
Both captures passed validity checks and completed the stream. The recorder's
`send-cancelled` phase means the initial send glide was interrupted by scrolling;
it does not mean that the reply stream failed.

The second capture ran with four background worker threads. Each attempted
10 ms of CPU work followed by sleep in a 20 ms period. This is a bounded CPU-load
control, not CPU saturation or a model of GPU or memory contention. It does not
reproduce another tab's exact workload.

## Results

These inclusive operation timings include diagnostic overhead. Nested totals
must not be added together. Sub-millisecond calls are quantized by Firefox's
page timer; Gecko's sampled profile provides separate attribution.

| Metric | Baseline | CPU-load control |
| --- | ---: | ---: |
| Capture duration | 25.32 s | 25.09 s |
| Main-phase scroll handler calls | 883 | 882 |
| Scroll handler total / maximum | 61 / 2 ms | 50 / 2 ms |
| Runtime `onScrolled` total | 51 ms | 38 ms |
| Message-content update total | 450 ms | 404 ms |
| `viewportState` total, all call sites | 338 ms | 188 ms |
| Callback gap p99 / maximum | 21 / 31 ms | 19 / 26 ms |

The baseline's Gecko markers report scroll-event p95 of 0.346 ms and maximum
2.566 ms. The runtime already avoids most reconciliation work when the mounted
range has not changed, and suppresses unchanged state publications. Sticky
header updates account for 15 ms in the baseline, far below streaming work.

The larger viewport-read total is not the cost of the scroll handler: most of
it occurs during streaming commits after DOM changes. The baseline includes a
burst of seven item updates in one animation frame, totaling 17 ms, with eight
live-commit calls totaling 11 ms inside that work. Coalescing streaming updates
is a candidate for a separate investigation, with attention to synchronous
update semantics, end-follow, and anchor correctness.

This initial audit made no performance patch. The CPU-load control did not show
worse callback delays, and the lower totals are not evidence of an improvement: the runtime
was unchanged. Regular callbacks cannot establish smooth physical presentation.
These scripted gestures do not measure real trackpad release and momentum.

## Reproduction and retained evidence

Run the baseline with:

```sh
node scripts/profile-chat.mjs --browser=firefox --scenario=scrollback \
  --mode=diagnostic --display=LU28R55 --refresh-hz=60 --seconds=20 \
  --stream-ms=12000 --sections=48 --history=160 \
  --output=browser-artifacts/scroll-hot-path
```

For the CPU-load control, prefix that command with:

```sh
node scripts/firefox-profile/cpu-contention.mjs --
```

Compact evidence, source patches, hashes, browser/display metadata, and workload
recipes are retained under ignored `browser-artifacts/scroll-hot-path/`:
`firefox-diagnostic-0KJ8iy` and `firefox-diagnostic-lfiblS`. The runner removes raw
profiles and temporary browser profiles. The contention helper terminates its
workers when the profiling command exits, including failure to launch. Portable
checks cover successful exit, unsuccessful exit, and launch failure.


## Pretext algorithm comparison

The requested [pretext.cool](https://pretext.cool/) site identifies itself as a
community hub. This comparison uses the official implementation, without
proposing its text pre-measurement approach.

The [chat controller](https://github.com/chenglou/pretext/blob/main/pages/demos/markdown-chat.ts)
coalesces events into one requested frame and orders viewport reads, numeric
calculation, DOM writes, and any scroll correction. Rows remain mounted across
range overlap. Our runtime already preserves overlap and skips unchanged ranges;
the useful experimental transfer is coalescing repeated streaming commits,
not automatically adding another frame of delay to scroll reconciliation.

The [chat model](https://github.com/chenglou/pretext/blob/main/pages/demos/markdown-chat.model.ts)
uses typed height/top arrays and binary searches. Our Fenwick structure already
provides logarithmic lookup and individual height updates. Replacing it with
flat cumulative tops would require updating later offsets when heights change,
so there is no evident algorithmic gain for this streaming workload.

The [official pattern notes](https://github.com/chenglou/pretext/blob/main/pages/demos/markdown-chat.md)
explicitly exclude streaming and content requiring post-mount measurement, and
acknowledge blank edges without overscan. Their static demo is not evidence that
our measured-content runtime can safely omit its resize and anchoring work.

[Incremental preparation research](https://github.com/chenglou/pretext/issues/313)
also discusses reusing unchanged markdown blocks, invalidation generations, and
cache lifetime. Those are useful review principles for our renderer dependency,
but a single growing paragraph can still require substantial repeated work.
No dependency or runtime change was made from this comparison.


## Rejected frame-batching experiment

At the user's request, a third installed-Firefox trial tested an opt-in frame
queue in the shared paging companion. Source updates composed immediately;
render submission coalesced by message key. Flushes projected current source
state, and disposal cancelled queued work. Four focused runtime cases passed
before capture, covering coalescing, newer edits, disposal, and render failure.

The candidate used the same CPU-contention wrapper, workload, browser, and
monitor as `firefox-diagnostic-lfiblS`. Its compact evidence and candidate source
patch are in `firefox-diagnostic-ZRkE0v`. The capture was valid and the stream
completed. This was the third Firefox trial in that comparison round.

| Metric | CPU-load control | Frame-batched candidate |
| --- | ---: | ---: |
| Message-content renders | 467 | 453 |
| Message-content update total | 404 ms | 343 ms |
| Viewport-read total | 188 ms | 522 ms |
| Gecko main-thread awake total | 2,813 ms | 2,892 ms |
| Gecko animation-frame callback total | 128 ms | 1,226 ms |
| Callback gap p99 / maximum | 19 / 26 ms | 18 / 27 ms |

Animation-frame cost increasing is partly expected: the experiment moves work
there. It is not, by itself, a measure of extra total work. Nevertheless, the
small render-count reduction and unchanged overall awake time provide no
convincing benefit, while viewport reads grew substantially. One diagnostic
pair does not establish a universal regression or physical jitter improvement.

The candidate runtime option, demo opt-in, and experimental tests were reverted.
The previously confirmed anchor fixes remain intact. A better next hypothesis
is reducing synchronous work within each streaming commit, especially forced
style/layout reads, rather than merely moving it into an animation callback.

## Loading animation and image-binding follow-up

The user requested continued experiments and web research, with early manual
testing before the full regression suite. Two further Firefox captures used
the same CPU-contention command, display, browser, and deterministic workload.

First, the image-preview binder assigned new identities to unchanged images
whenever streaming produced a new immutable message object. That repeatedly
removed and restored preview attributes and event listeners. The candidate
reuses a mounted image's identity when its message ID, ordinal, and logical
source match, retaining the existing weak caches. Fourteen focused unit cases
passed, including repeated immutable updates and preview navigation. Binding
time fell from 45 ms to 9 ms, but overall main-thread CPU remained near 2.7 s.
This was useful cleanup, not the requested substantial reduction.

The profile's heaviest refresh intervals occurred after the reply finished,
while older-history loading was active. The shared stylesheet animated
`--boundary-spin` on `.viewport-wrap`, with `inherits: true`. The final chat
contained 9,619 elements. Every spinner tick could therefore propagate style
invalidation through the chat, including the offscreen streaming row retained
for measurement. [Google's custom-property benchmark](https://web.dev/blog/at-property-performance)
explains the descendant invalidation cost of inherited animated properties.

The second candidate removes that inherited animation and its wrapper-state
bookkeeping. Each visible spinner uses the existing local `transform` rotation.
This fixes the shared loading style where the work originates; the list's
scroll handler and anchoring logic are unchanged by this performance change.

| Metric | Image-binding candidate | Plus local spinner animation |
| --- | ---: | ---: |
| Capture duration | 24.32 s | 24.83 s |
| Sampled content main-thread CPU | 2,719 ms | 2,143 ms |
| Main-thread awake time | 2,861 ms | 2,253 ms |
| Style recalculation | 1,154 ms | 517 ms |
| Refresh-driver work | 1,740 ms | 805 ms |
| Active-input CPU p95, per 100 ms | 68.8% of one core | 27.1% of one core |
| Completed history range | 109–162 / 162 | 109–162 / 162 |

Both runs passed validity checks and completed all 461 streaming chunks.
The 21% CPU and 55% style reductions are from one matched pair, not a
cross-browser average. Native gesture timing and scheduling vary; regular
frame callbacks cannot prove smooth physical presentation. A spinner's local
animation can restart when its virtualized slot remounts.

The user requested keeping this candidate and continuing exploration. The focused bottom-loader
regression now also requires a rotating spinner-local animation and no wrapper
animation, guarding against the inherited-animation cost returning.
The focused Firefox regression passed for both slot and floating-pill loaders.
`pnpm run check` passes with two existing compositing-debug CSS warnings.

Compact evidence is in `firefox-diagnostic-vxYzAR` (image binding) and
`firefox-diagnostic-W3xZPa` (local spinner), under the same ignored output
directory as the earlier trials. Their source patches and hashes preserve both
candidates. Raw profiles and temporary browser profiles were removed by the
runner.

## Streaming style invalidation follow-up

Three further captures use the same CPU-contention command, browser build,
external display, and deterministic workload. All include the retained spinner
and image-binding changes. This round adds diagnostic spans around the two
viewport reads in `liveCommit`, without changing production runtime code.
The instrumentation checks require both call sites to exist and verify return
values and span cleanup when a read throws.

The baseline separates 424 ms spent in the first viewport read after host DOM
updates from 14 ms in the later read after runtime geometry writes. Removing the
later read offers little benefit and risks missing browser clamping. The first
read flushes pending style and layout work, as described in
[Mozilla's performance guidance](https://firefox-source-docs.mozilla.org/performance/bestpractices.html).
Moving the same flush to a later geometry read would not remove its cost.

The candidate instead reduces pending style work in the shared Markdown
integration:

- Restrict the generated-file `:has()` check to its known location immediately
  inside `.message-content`. It previously searched the entire reply subtree
  whenever streaming changed descendants. This follows
  [MDN's guidance on bounding `:has()` searches](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/:has).
- Define the changing `--cursor-gap` on the cursor itself. It previously changed
  on the Markdown root as image-only paragraphs and the cursor appeared, making
  that value available through the entire growing descendant tree. Preserve
  finished-image padding with a non-inherited padding rule instead. Intermediate
  text segments, thinking panels, and action footers retain their existing
  spacing overrides.

| Metric | Retained spinner baseline | Bounded file selector | Plus cursor-local gap |
| --- | ---: | ---: | ---: |
| Capture duration | 24.83 s | 24.87 s | 25.18 s |
| Sampled content main-thread CPU | 2,056 ms | 1,936 ms | 1,678 ms |
| Main-thread awake time | 2,151 ms | 2,002 ms | 1,729 ms |
| Style recalculation | 517 ms | 392 ms | 177 ms |
| Synchronous reflow | 139 ms | 140 ms | 139 ms |
| Viewport read after host updates | 424 ms | 322 ms | 130 ms |
| Viewport read after geometry writes | 14 ms | 16 ms | 17 ms |
| Active-input CPU p95, per 100 ms | 27.1% of one core | 24.5% of one core | 18.5% of one core |
| Completed history range | 109–162 / 162 | 109–162 / 162 | 109–162 / 162 |

All three captures passed validity checks and completed 461 streaming chunks.
The combined CSS candidate uses 18% less main-thread CPU and 66% less style
recalculation than this round's baseline. Reflow cost stays near 139 ms, which
supports reducing style invalidation rather than changing layout or anchoring.
These are individual matched trials, not a cross-browser average or evidence of
smooth physical presentation. The user requested retaining this change after
the early test.

The existing image-cursor spacing regression passes in Firefox, Chromium, and
WebKit: image gaps remain 16 px and finalization preserves the row height, both
with and without an action footer. Additional focused footer and file-control
checks validate the shared reservation during streaming and finalization.

Compact evidence is in `firefox-diagnostic-tyIx8i` (baseline),
`firefox-diagnostic-P3hlBx` (bounded selector), and `firefox-diagnostic-zOxwUF`
(cursor-local gap). Each directory retains source patches, hashes, and exact
reproduction metadata. The runner removed raw and temporary browser profiles.
This completes the three-trial limit for the comparison round.

## Streaming trail block index

The follow-up uses end-follow to keep the growing reply and its trail visible.
The browser, display, CPU-contention wrapper, 48-section stream, and 160-turn
history are unchanged. The trail repeatedly traversed and parsed source labels
in completed blocks, even after their highlights had expired. This is renderer
work in `markdown-viewer`, outside the list's scroll handler.

An initial weak cache of each element's last source position still visited every
label. Main-thread CPU changed from 3,292 ms to 3,245 ms, a 1.4% difference that
does not justify retaining that implementation. The rejected candidate remains
reproducible from its compact source patch.

The retained implementation indexes each root block's mapped descendants and
greatest source end. Expired blocks skip descendant traversal. The existing
mutation observer invalidates changed blocks, and the reader drains pending
records before reading. Text-only mutations do not change that index; the
reader always reads current text. Removed and reinserted blocks are invalidated,
and clearing a trail resets its weak cache. A mapped text node directly inside
an already-checked element also skips a duplicate ancestor selector match.

| Metric | Unchanged renderer control | Block index | Plus duplicate-check removal |
| --- | ---: | ---: | ---: |
| Main-thread CPU | 3,292 ms | 3,071 ms | 3,000 ms |
| Main-thread awake time | 3,423 ms | 3,201 ms | 3,138 ms |
| Animation-frame callback total | 1,276 ms | 1,144 ms | 1,053 ms |
| Trail paint inclusive samples | 1,078 | 892 | 816 |
| Style recalculation | 344 ms | 338 ms | 348 ms |

The final candidate reduces CPU by 8.9%, animation-frame work by 17.5%, and
inclusive trail-paint samples by 24.3% relative to the unchanged-renderer build.
All runs passed movement and completion checks. Sample counts are attribution,
not exact operation timings. This end-follow result cannot be added to the
scrollback percentages above. A separate timing-only scrollback control used
1,610 ms of CPU, confirming that the diagnostic spans did not account for the
earlier style reductions.

The user tested the owning-repository preview and confirmed correct text and
bullet trails, scrolling, and end-follow. Unit cases cover source ranges moving
backward, mapping changes, live text edits, block reordering, removal, reinsertion,
and cache reset. The renderer's complete 1,157-case unit suite passes. Its browser
regressions check 551 streaming fragments, delayed highlighting, changing math,
and native list markers.

The fix belongs to `markdown-viewer` `v0.8.8`; virtual-list pins that GitHub tag.
No installed dependency patch is used. The release adds 2,624 runtime bytes and
5,241 generated bytes including declarations and maps. Runtime output remains
285,106 bytes within the unchanged 290,000-byte limit; the total-output ceiling
is adjusted from 520,000 to 526,000 bytes for the measured increase.

Compact evidence is under `browser-artifacts/scroll-hot-path/`:
`firefox-diagnostic-Mbm0G7` (unchanged owner build),
`firefox-diagnostic-87QPrh` (rejected element cache),
`firefox-diagnostic-S4U0ob` (block index), and
`firefox-diagnostic-DJ1yJv` (retained candidate).
`firefox-diagnostic-tt38q4` is the original pinned-renderer control;
`firefox-timing-PRpR6e` is the timing-only scrollback control. Each preview run
retains its owner's revision, patch, and hashes as well as the consumer's source.
Raw profiles and temporary browser profiles were removed.

Reproduce end-follow using the command above with `--scenario=follow`. For
historical owner-preview captures, apply the recorded `upstream.patch` in the
sibling checkout and use the recorded build recipe, then prefix the profiling
command with `env MARKDOWN_VIEWER_LOCAL=1`. The reusable profiler records both
repositories and the CPU-contention wrapper automatically.

## Release verification

`markdown-viewer` commit `2746e73877809d0e04231a12028c6b1b3d0d7283` is published
with patch tag `v0.8.8`. The consumer's manifest, lockfile, and exact-commit build
allowlist select that tag. Installed trail modules match the tested owner build
byte for byte. The temporary local-renderer preview server is closed.

The renderer passes its static checks, build/package boundary, 1,157 unit tests,
and the 551-fragment source-trail regression in each of Firefox, Chromium, and
WebKit. Native list-marker coverage also passes in all three engines.

With the pinned package, virtual-list passes `pnpm run check`, all 5,616 unit
tests, and all 152 portable profiler checks. The two existing CSS diagnostic
override warnings and missing-source dependency sourcemap warnings remain.
Both `streaming-trail` browser regressions pass across all three engines,
including geometry, final fade, idle reads, reduced motion, disposal, and pixel
stability after DOM replacement. The retained terminal-branch/collapse script
also passes all nine cases in each engine.

The first consumer browser attempt lost its connection to the regular demo
server. The completed runs used fresh runner-owned servers. Those servers and
browsers exited. Reproducible screenshots and about 204 MiB of preview/compiler
caches were removed; compact reports and source recipes remain. No new memory
plateau comparison or physical momentum capture was performed for this release.

## Follow-up after the release checkpoint

After both repositories were committed and pushed, a smaller owner-side
experiment bypassed `TreeWalker` construction for mapped elements containing
exactly one text node. Nested markup and mixed child nodes still use the existing
filtered traversal. The user confirmed correct text and bullet highlighting,
following, and scrolling in the separate renderer preview.

`firefox-diagnostic-hfFyDE` repeats the installed-Firefox end-follow capture with
the same CPU load, display, browser build, and deterministic stream. Its control
is the retained `firefox-diagnostic-DJ1yJv` source; the intervening release made
no further production changes. Both use the owner-preview loading path.

| Metric | Released block-index implementation | Single-text-node candidate |
| --- | ---: | ---: |
| Main-thread CPU | 3,000 ms | 2,841 ms |
| Main-thread awake time | 3,138 ms | 2,995 ms |
| Animation-frame callback total | 1,053 ms | 936 ms |
| Source-reading inclusive samples | 289 | 126 |
| Trail-paint inclusive samples | 816 | 686 |
| Style recalculation | 348 ms | 341 ms |

The candidate reduces CPU by 5.3% in this comparison. Both runs complete the same
461 chunks and finish with 10,764 elements and a 41,784-pixel scroll height.
These are individual captures, not a statistical estimate or a jitter fix.
The 36 focused source/trail unit cases pass, and the package build remains within
the released limits at 525,045 generated bytes and 285,350 runtime bytes. After
the user's early check, the full 1,157-case renderer unit suite and static checks
pass. The 551-fragment source-trail regression and native list-marker checks
also pass in Firefox, Chromium, and WebKit.

The new capture retains source patches and reproduction metadata. Its raw
profile and temporary Firefox profile were removed automatically.

### Closing trial and patch release

A final allocation experiment reversed the fresh segment array once per paint
instead of copying it for each fade group, and iterated fragment rectangles
backward without allocating entry tuples. Its pixel-stability checks passed in
all three engines. The matched installed-Firefox capture
`firefox-diagnostic-WSWVvc` was valid and completed the same stream and final
geometry, but CPU changed only from 2,841 to 2,809 ms, or 1.1%. Trail-paint
samples increased from 686 to 703. That pair does not establish a useful gain,
so both allocation changes were reverted. This closes the three-capture round,
including its retained control.

The remaining measured work is mainly trail geometry and Markdown parsing.
The confirmed candidate's scroll handlers total 39 ms across the 20-second
end-follow capture, including send landing. This review found no further
evidence-backed change to the handler worth adding. It does not establish that
all workloads are optimal or that browser presentation cannot jitter under
external contention.

The user-confirmed single-text-node change is published from the owning
repository as `markdown-viewer` `v0.8.9`, commit
`bf0b908ddbb55e79cc4db1efa517e2157261ab5d`. Virtual-list's manifest, lockfile,
and exact-commit build allowlist select that tag. The installed modules match
the tested owner build. No dependency patch or production preview alias is used.
The pinned package passes both three-engine trail regressions, including
coverage, final fade, idle reads, reduced motion, disposal, and pixels after DOM
replacement. Virtual-list's 5,616 unit tests and static checks pass.

The memory runner previously used the fresh demo's default disabled trail.
It now accepts `--trail=short|long` for the streaming workload, verifies the
selected setting, and requires observed trail rectangles during a scroll cycle.
Portable checks cover rejected mode/workload combinations and reset the
observation between cycles. The default remains `off` for reproducibility of
earlier captures. No memory budget is raised.

The first trail-enabled Safari memory run, `safari-streaming-ZkRYBc`, failed
the new coverage guard: it finished the reply while traversing older history
without observing rendered trail rectangles. It is invalid evidence even though
its memory counters stayed within budget. The finalized workload waits for
rendered trail rectangles and starts its first instant-scroll cycle with ten
alternating 120-pixel steps near the reply, then performs the existing full
history traversals. A portable regression verifies that this phase observes the
trail before row recycling and that observations reset between cycles.

The corrected installed-Safari run, `safari-streaming-L3br7C`, passes with actual
trail coverage. Safari 27.0.1, build 22625.1.29.11.28, uses the LU28R55 at 2×
scaling, with a 1920 × 1049 outer window and 1920 × 945 inner viewport. Across
six cycles, its largest process peak is 568.81 MiB against the 768 MiB limit;
the browser-wide checkpoint maximum is 649.91 MiB against 1,400 MiB. The growth
measure is 46.92 MiB against 64 MiB, and the final-three-cycle range is
38.78 MiB against 40 MiB. The latter is close to the calibrated limit; this
passing finite check does not establish zero retained growth over longer runs.
Cleanup reports no errors, and the temporary browser and server exit.

The finalized Firefox workload, `firefox-streaming-dXrtDm`, also passes with
observed trail rectangles. Firefox 156.0.1, build 20260921121718, uses the same
display and scaling, a 1920 × 1049 outer window, and a 1920 × 965 inner viewport.
Its largest process peak is 440.57 MiB against 600 MiB; the browser-wide
checkpoint maximum is 1,069.10 MiB against 1,400 MiB. Growth is 12.03 MiB against
64 MiB, and the final-three-cycle range is 21.72 MiB against 40 MiB. Cleanup
reports no errors. These are allocation stress checks with instant scroll
steps, not physical momentum or presentation measurements.

Reproduce the finalized memory checks with the installed browsers and the
LU28R55 available:

```sh
pnpm run test:memory -- --browser=firefox --workload=streaming --trail=long --cycles=6 --display=LU28R55
pnpm run test:memory -- --browser=safari --workload=streaming --trail=long --cycles=6 --display=LU28R55
```

Each trial contains six allocation cycles; these are not six comparison trials.
The compact summaries retain the exact commands, source patches, browser builds,
display geometry, and selected trail mode. All 154 portable profiler checks and
the final static check pass. The existing two CSS diagnostic override warnings
remain. Raw captures, generated screenshots, temporary browser profiles, and
reproducible compiler and preview caches were removed. The owned preview server
was stopped; compact summaries and reproduction recipes remain under ignored
`browser-artifacts/`.
