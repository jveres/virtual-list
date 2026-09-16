// Keep the first gesture away from paging boundaries and the prompt's pin.
(() => {
  const viewport = document.querySelector("#viewport");
  viewport.scrollTop = 1000;
  viewport.dispatchEvent(new Event("scroll"));
  return {
    workload: "idle simulated chat, interior manual-scroll workload",
    scrollTop: viewport.scrollTop,
    scrollHeight: viewport.scrollHeight,
    viewportHeight: viewport.clientHeight,
  };
})();
