// Fresh profiling profiles only. Make the demo's token deadlines repeatable.
(() => {
  Math.random = () => 0.5;
  const prompt = document.querySelector("#prompt");
  prompt.value = "fast long response for native scroll CPU profiling";
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
  document.querySelector("#send-btn").click();
  return { workload: "fast long reply with fixed midpoint token delays" };
})();
