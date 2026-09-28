# Safari HDR chat images, September 28, 2026

After importing an image-heavy transcript, Safari scrolling in the streaming
demo lagged. Images appeared late, and fast flicks stalled. The user reports
smooth scrolling on both displays after two demo changes. Inline chat images
now render in standard dynamic range. Large data-URL images also show a
display-sized copy made in a worker. This is a Safari-specific exception to
the Firefox-first workflow. The runtime in `src/` is unchanged.

## Workload and conditions

The imported local transcript has 46 turns and 27,721,797 bytes, with 45
embedded images. Most are 1536 × 1024 JPEG or PNG images. Five are iPhone
JPEGs between 3758 × 2160 and 4032 × 3024. These include Apple HDR gain
maps, MPF data, and ICC profiles.

The user tested installed Safari 27.0, build 22625.1.29.11.27, with
DevTools closed. The LU28R55 external display used 1920 × 1080 logical pixels
at 2× and 60 Hz. The built-in display used a 1440 × 756 content area at 2×.
Safari reported `(dynamic-range: high)` only on the built-in display, and
`dynamic-range-limit` was supported. Both displays delivered animation frames
at about 60 Hz.

## Rejected causes

The first suspect was the row compositing hint from `dd88370`. A temporary
control removed only that hint, and another removed the canvas's
`preserve-3d`. The user saw no difference with either control. Disabling
fast-scroll skeletons also made no difference. Relaunching Safari did not
change the lag.

Two scripted native Safari captures with `COMPOSITING=current` and
`flat-rows` did not isolate the cause. Their content heights differed, 959
and 997 pixels, so they were not comparable. Content-process CPU was similar.

## Diagnosis

A temporary, gated demo trace recorded real trackpad input. It sent
animation-frame gaps over 20 ms, scroll and wheel events, row mounts, forced
layout time, and image load or decode timings to the development report sink.
Layout forcing and decode requests were attribution controls. They were not
production behavior.

The page did not block on JavaScript or layout. Row renders took at most
18 ms, and forced layout of mounted rows took at most 5 ms. Scroll events
arrived at almost every frame, even during flicks of about 9,600 pixels per
frame. Long gaps coincided with mounting rows that contained images.

Explicit `decode()` requests took 2.4–5.2 seconds for the large HDR JPEGs.
Safari then decoded these images again when their recycled rows remounted.
On the built-in HDR display, rows with only 1536 × 1024 images also stalled
for 300–720 ms. A narrow window on the external display did not reproduce
those stalls. The display, not the width change, correlated with the stalls.
The mechanism inside WebKit remains inferred from these controls.

## Changes

`.message-content img` uses `dynamic-range-limit: standard`. The full-screen
viewer is attached to the document body, outside that selector, and keeps its
original rendering. Unsupported browsers ignore the declaration.

Loaded data-URL images with a long edge over 2048 pixels request a copy. A
module worker decodes one image at a time with `createImageBitmap`, draws it
into `OffscreenCanvas`, and re-encodes it. PNG copies stay PNG, and other
images become JPEG at quality 0.9. Redrawing into the canvas omits the source
gain map. The runtime swaps a mounted image only if it still shows the same
source. Missing width and height attributes are copied from the original, so
the reserved box is unchanged.

A row rebuilt by the list's `render` callback adopts a finished copy before
insertion. Otherwise, it could paint and decode the original until the copy
loaded. `displaySource()` maps a copy back to its data URL, so preview identity
and navigation still use the original. Copies remain cached for the page's
lifetime. Browsers without module workers, `OffscreenCanvas`, or
`createImageBitmap` keep the original image.

## Real-input results

The traces are single observations, not a controlled benchmark. Gesture paths
differ, and one baseline included a display move.

| Build | Display | Frames over 50 ms | Frames over 100 ms | Longest frame |
| --- | --- | ---: | ---: | ---: |
| Before changes | External, then built-in | 20 | 10 | 734 ms |
| Copies only | External | 6 | 0 | 85 ms |
| Copies only | Built-in, after a move | 11 | 7 | 723 ms |
| Standard range and copies | Both | 21 | 4 | 218 ms |
| Standard range only | Both | 9 | 3 | 247 ms |

The standard-range-only row excludes a 247 ms page-load gap. Its longest
scrolling gap was 122 ms. The user reported that this control felt less smooth
than using both changes, so both changes remain.

## Checks

The new `chat-image-display-copy` browser regression uses a synthetic
4000 × 3000 image in Chromium, Firefox, and WebKit. It verifies a 2048 × 1536
copy, an unchanged row box, preserved identity, adoption in rebuilt rows,
unchanged small images, and the computed standard-range rule. It cannot verify
physical HDR presentation or real trackpad momentum.

`pnpm run check`, all 1,074 unit tests, and all 20 chat-content browser
regressions pass. The temporary trace and A/B controls have been removed.
Scripted capture summaries remain under ignored
`browser-artifacts/safari-native-scroll/`. Their raw samples were deleted.
