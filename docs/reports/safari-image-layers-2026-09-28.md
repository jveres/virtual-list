# Safari chat image layers

Repeated visual testing on September 28 found smooth scrolling with real
images when compositing hints moved from entire native-flow rows to individual
chat images. Native anchoring remains unchanged.

## Evidence and limits

The user reported that image-heavy chat scrolling still jittered in Safari 27
and Safari Technology Preview. Previous page-level captures did not expose
the visible jitter, and retaining visited rows did not eliminate it.

Two sequential, opt-in visual controls used the same streaming demo:

1. `?imageRectangles=1` replaced loaded images with tiny muted SVG rectangles
   of the same intrinsic dimensions. The user reported very smooth scrolling.
2. `?compositing=image-layers` restored real images, removed native row-level
   `will-change: transform`, and applied that hint to individual message images.
   The canvas compositing settings remained unchanged. The user confirmed
   the exact URL and repeatedly reported smooth, fast scrolling.

These are user-observed comparisons, not controlled timing benchmarks. They
implicate image rendering and layer placement, but do not establish a specific
WebKit decoding, GPU-memory, or presentation defect. The earlier short-run
success of whole-row promotion did not persist.

## Default behavior

Native-flow slots no longer request individual layers. Chat image CSS requests
promotion for each image instead. Positioned slots retain their existing hints.
The change adds no scroll listeners, geometry reads, or image-source changes.
The temporary query flags and rectangle implementation have been removed.

The profiler's `COMPOSITING=row-layers` and `COMPOSITING=flat-rows` controls
remain available for reproducing row-promotion comparisons. To recreate the
image-layer candidate, use the normal streaming demo, import the same local
conversation, and repeat native flick-and-release gestures on the same display.
Do not interpret regular animation-frame callbacks as proof of smooth output.

The diagnostic geometry checks passed in Chromium, Firefox, and WebKit:
image dimensions, sources, and the canvas transform were unchanged when the
image-layer control was enabled. Physical smoothness was assessed by the user
in Safari. No raw captures or private transcript data were added.

## Boundary follow-up

The user subsequently reported jitter only during the top rubber-band bounce,
including after all history was loaded. Smooth normal scrolling does not imply
that this remaining boundary issue is resolved.

A focused geometry regression demonstrated that elastic offsets changed the
mounted range: a negative top offset retired rows at the bottom of the window,
then restored them on the return. Bottom overscroll similarly retired rows at
the start of the window. The candidate clamps only the window query to the
reachable scroll range. It preserves the browser's actual offset and bounce.
Geometry and native-list tests verify stable edge ranges and unchanged native
offsets. The user confirmed that top-bounce jitter was gone after this change.

Normal scrolling later showed occasional jitter again, including in the default
simulated chat without images. Images are therefore not required for the
remaining issue. Image-level promotion is not a complete jitter fix, and the
investigation continues with the image-free workload.

## Verification status

The current unit suite and 128 portable profiler checks pass. Native image
recycling and bottom-loader checks pass across Chromium, Firefox, and WebKit.
The bottom-loader test now checks actual spinner movement rather than an
outdated animation name. The preview checks pass in Firefox and WebKit.

The full 116-script browser run was interrupted to investigate the new bounce
report: 31 scripts passed, the bottom-loader assertion failed and was corrected
and rerun, and the idle-cursor check was interrupted. The full suite has not
completed for this revision. Browser correctness checks do not establish
physical Safari smoothness.
