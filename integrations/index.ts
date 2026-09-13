/** Optional UI layout helpers. This entry does not load a Markdown renderer. */

export type { TextareaSizeOptions } from "./composer";
export { autosizeTextarea } from "./composer";
export {
  EMBEDDED_IMAGE_PATTERN,
  streamingMarkdownText,
} from "./streaming-text";
export {
  mountUserMessageCollapse,
  prepareUserMessageCollapse,
  syncUserMessageCollapse,
  unmountUserMessageCollapse,
} from "./user-message-collapse";
