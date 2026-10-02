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
  const rowsPerStep = 100;
  const tableBodies = hosts.flatMap((host) =>
    Array.from(host.querySelectorAll("tbody")).filter(
      (body) => body.rows.length >= 1000,
    ),
  );
  if (
    tableBodies.length === 0 &&
    hosts.reduce((count, host) => count + host.childElementCount, 0) <=
      blocksPerStep
  )
    return undefined;
  function withhold(host: HTMLElement) {
    const remaining = document.createDocumentFragment();
    while (host.firstChild) remaining.append(host.firstChild);
    return { host, remaining };
  }
  // Empty large bodies before their table wrappers enter the preparation slot.
  const tables = tableBodies.map(withhold);
  const groups = hosts.map(withhold);
  function appendBatch(group: (typeof groups)[number], limit: number) {
    const batch = document.createDocumentFragment();
    let count = 0;
    while (group.remaining.firstChild && count < limit) {
      const node = group.remaining.firstChild;
      if (node.nodeType === Node.ELEMENT_NODE) count++;
      batch.append(node);
    }
    group.host.append(batch);
    return count;
  }
  let index = 0;
  let tableIndex = 0;
  return {
    next() {
      let blocks = 0;
      while (index < groups.length && blocks < blocksPerStep) {
        const group = groups[index];
        if (!group) break;
        blocks += appendBatch(group, blocksPerStep - blocks);
        if (!group.remaining.firstChild) index++;
      }
      let rows = 0;
      while (tableIndex < tables.length && rows < rowsPerStep) {
        const table = tables[tableIndex];
        // A table in a later top-level block must not fill while detached.
        if (!table || !row.contains(table.host)) break;
        rows += appendBatch(table, rowsPerStep - rows);
        if (!table.remaining.firstChild) tableIndex++;
      }
      return {
        done: index === groups.length && tableIndex === tables.length,
        value: undefined,
      };
    },
    return() {
      for (const group of groups) group.host.append(group.remaining);
      for (const table of tables) table.host.append(table.remaining);
      index = groups.length;
      tableIndex = tables.length;
      return { done: true, value: undefined };
    },
  };
}
