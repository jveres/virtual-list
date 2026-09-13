// Start the built-in fast reply before the runner's post-setup warmup.
(() => {
  const prompt = document.querySelector("#prompt");
  prompt.value = "fast long response for native scroll CPU profiling";
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
  document.querySelector("#send-btn").click();
  return {
    workload:
      "built-in fast long reply, scrolling back while generation continues",
    prompt: prompt.value,
  };
})();
