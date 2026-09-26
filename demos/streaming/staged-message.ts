/** Spread a completed reply's first layout across hidden preparation frames. */
export function stageMessageLayout(
  row: HTMLElement,
): Iterator<void, void> | undefined {
  const hosts = Array.from(
    row.querySelectorAll<HTMLElement>(
      ".message-content > .markdown-viewer > .markdown",
    ),
  );
  const blocksPerStep = 16;
  if (
    hosts.reduce((count, host) => count + host.childElementCount, 0) <=
    blocksPerStep
  )
    return undefined;
  const groups = hosts.map((host) => {
    const remaining = document.createDocumentFragment();
    while (host.firstChild) remaining.append(host.firstChild);
    return { host, remaining };
  });
  let index = 0;
  return {
    next() {
      let blocks = 0;
      while (index < groups.length && blocks < blocksPerStep) {
        const group = groups[index];
        if (!group) break;
        const batch = document.createDocumentFragment();
        while (group.remaining.firstChild && blocks < blocksPerStep) {
          const node = group.remaining.firstChild;
          if (node.nodeType === Node.ELEMENT_NODE) blocks++;
          batch.append(node);
        }
        group.host.append(batch);
        if (!group.remaining.firstChild) index++;
      }
      return { done: index === groups.length, value: undefined };
    },
    return() {
      for (const group of groups) group.host.append(group.remaining);
      index = groups.length;
      return { done: true, value: undefined };
    },
  };
}
