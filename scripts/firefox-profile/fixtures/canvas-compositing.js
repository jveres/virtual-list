// Diagnostic only: compare one compositing property after identical warmup.
// Pass ?profile-canvas=flat|preserve-3d|runtime in the capture URL.
(() => {
  const mode = new URL(location.href).searchParams.get("profile-canvas");
  if (mode !== "flat" && mode !== "preserve-3d" && mode !== "runtime")
    throw new Error("Expected profile-canvas=flat|preserve-3d|runtime");
  const canvas = document.querySelector("#viewport")?.firstElementChild;
  if (!(canvas instanceof HTMLElement))
    throw new Error("Runtime canvas is not mounted");
  const webkit = CSS.supports("-webkit-nbsp-mode", "space");
  if (mode !== "runtime") canvas.style.transformStyle = mode;
  const style = getComputedStyle(canvas);
  const expected =
    mode === "runtime" ? (webkit ? "preserve-3d" : "flat") : mode;
  if (style.transformStyle !== expected)
    throw new Error("Canvas compositing control did not apply");
  return {
    webkit,
    transform: style.transform,
    transformStyle: style.transformStyle,
  };
})();
