// Compatibility for older demo imports. New hosts use src/companions/index.
import {
  createStickyHeaders as create,
  type StickyHeadersConfig,
} from "../../src/companions/sticky-headers";

export type { StickyHeaders } from "../../src/companions/sticky-headers";
export function createStickyHeaders(config: StickyHeadersConfig) {
  return create({ observeScroll: true, ...config });
}
