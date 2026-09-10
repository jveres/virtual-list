import { type StoredTurn, validateStoredTurns } from "./openai.js";
import {
  parseTranscriptMarkdown,
  type TranscriptDays,
  type TranscriptMessage,
  transcriptMarkdown,
} from "./transcript.js";

export interface TranscriptNode<M extends TranscriptMessage = StoredTurn> {
  id: number;
  /** Zero denotes the root sentinel, which has no message. */
  parentId: number;
  selectedChildId: number | null;
  message: M;
}

export interface TranscriptTree<M extends TranscriptMessage = StoredTurn> {
  selectedRootId: number | null;
  /** Array order defines sibling/version order. */
  nodes: TranscriptNode<M>[];
}

export interface ImportedTranscript {
  turns: StoredTurn[];
  tree: TranscriptTree | null;
}

const TREE_TAG = "<!-- branching-tree ";
const COMMENT_END = " -->";
const TITLE = "# streaming-chat transcript";

function invalid(reason: string): never {
  throw new Error(`Invalid transcript version tree: ${reason}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

/** Validate every branch iteratively, including inactive and disconnected nodes. */
function indexTree<M extends TranscriptMessage>(
  tree: TranscriptTree<M>,
): {
  active: TranscriptNode<M>[];
} {
  const nodes = new Map<number, TranscriptNode<M>>();
  const children = new Map<number, number[]>();
  for (const node of tree.nodes) {
    if (!isId(node.id) || nodes.has(node.id))
      invalid("duplicate or invalid ID");
    if (node.parentId !== 0 && !isId(node.parentId))
      invalid("invalid parent ID");
    if (node.selectedChildId !== null && !isId(node.selectedChildId))
      invalid("invalid selection");
    nodes.set(node.id, node);
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.id);
    children.set(node.parentId, siblings);
  }
  const checkSelection = (id: number, selected: number | null): void => {
    const siblings = children.get(id) ?? [];
    if (
      selected === null ? siblings.length !== 0 : !siblings.includes(selected)
    )
      invalid("selection is not a child");
  };
  checkSelection(0, tree.selectedRootId);
  for (const node of nodes.values()) {
    if (node.parentId !== 0 && !nodes.has(node.parentId))
      invalid("missing parent");
    checkSelection(node.id, node.selectedChildId);
  }
  const pending = [...(children.get(0) ?? [])];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined) break;
    if (visited.has(id)) invalid("cycle");
    visited.add(id);
    for (const child of children.get(id) ?? []) pending.push(child);
  }
  if (visited.size !== nodes.size) invalid("unreachable nodes or cycle");
  const active: TranscriptNode<M>[] = [];
  let id = tree.selectedRootId;
  while (id !== null) {
    const node = nodes.get(id);
    if (!node) invalid("missing selected node");
    active.push(node);
    id = node.selectedChildId;
  }
  return { active };
}

/** Portable message data only: no API response IDs or runtime/UI state. */
function portableTurn(value: unknown): StoredTurn {
  if (
    !isRecord(value) ||
    (value.role !== "user" && value.role !== "assistant") ||
    typeof value.markdown !== "string"
  )
    invalid("invalid message");
  const turn = validateStoredTurns([
    {
      role: value.role,
      markdown: value.markdown || "-",
      sentAt: value.sentAt,
      stopped: value.stopped === true || value.status === "cancelled",
      attachments: value.attachments,
      toolCalls: value.toolCalls,
    },
  ])[0];
  if (!turn) invalid("invalid message");
  return {
    ...turn,
    markdown: value.markdown,
    ...(turn.toolCalls?.length
      ? {
          toolCalls: turn.toolCalls.map((call) =>
            call.status === "running"
              ? { ...call, status: "error" as const }
              : call,
          ),
        }
      : {}),
  };
}

/** Active bodies/attachments appear once, in the readable Markdown turns. */
export function branchingTranscriptMarkdown<M extends TranscriptMessage>(
  tree: TranscriptTree<M>,
  days: TranscriptDays<M>,
): string {
  const { active } = indexTree(tree);
  const indices = new Map(active.map((node, index) => [node.id, index]));
  const metadata = {
    version: 1,
    selectedRootId: tree.selectedRootId,
    nodes: tree.nodes.map((node) => {
      const turn = indices.get(node.id);
      return {
        id: node.id,
        parentId: node.parentId,
        selectedChildId: node.selectedChildId,
        ...(turn === undefined
          ? { message: portableTurn(node.message) }
          : { turn }),
      };
    }),
  };
  // Escaping '--' prevents alternate message content from closing the comment.
  const json = JSON.stringify(metadata).replace(/--/g, "-\\u002d");
  const readable = transcriptMarkdown(
    active.map((node) => node.message),
    days,
  );
  return `${TITLE}\n\n${TREE_TAG}${json}${COMMENT_END}\n${readable.slice(TITLE.length)}`;
}

/** Old files stay linear; a malformed new-format header never silently loses branches. */
export function parseBranchingTranscript(text: string): ImportedTranscript {
  const header =
    /^(?:\uFEFF)?# streaming-chat transcript\r?\n(?:[ \t]*\r?\n)*(<!-- branching-tree [^\r\n]*)(?:\r?\n|$)/.exec(
      text,
    )?.[1];
  if (header === undefined)
    return { turns: parseTranscriptMarkdown(text), tree: null };
  if (!header.endsWith(COMMENT_END)) invalid("truncated metadata");
  let metadata: unknown;
  try {
    metadata = JSON.parse(header.slice(TREE_TAG.length, -COMMENT_END.length));
  } catch {
    invalid("malformed metadata");
  }
  if (!isRecord(metadata) || metadata.version !== 1)
    invalid("unsupported format version");
  if (!Array.isArray(metadata.nodes)) invalid("missing nodes");
  if (metadata.selectedRootId !== null && !isId(metadata.selectedRootId))
    invalid("invalid root selection");
  const turns = parseTranscriptMarkdown(text, { preserveEmpty: true });
  const references = new Map<number, number>();
  const nodes = metadata.nodes.map((value: unknown): TranscriptNode => {
    if (
      !isRecord(value) ||
      !isId(value.id) ||
      (value.parentId !== 0 && !isId(value.parentId)) ||
      (value.selectedChildId !== null && !isId(value.selectedChildId))
    )
      invalid("invalid node");
    const referenced = Object.hasOwn(value, "turn");
    if (referenced === Object.hasOwn(value, "message"))
      invalid("ambiguous message reference");
    let message: StoredTurn;
    if (referenced) {
      if (!Number.isSafeInteger(value.turn) || Number(value.turn) < 0)
        invalid("invalid turn reference");
      const index = Number(value.turn);
      const turn = turns[index];
      if (!turn) invalid("missing readable turn");
      references.set(value.id, index);
      message = turn;
    } else {
      message = portableTurn(value.message);
    }
    return {
      id: value.id,
      parentId: value.parentId,
      selectedChildId: value.selectedChildId,
      message,
    };
  });
  const tree: TranscriptTree = {
    nodes,
    selectedRootId: metadata.selectedRootId,
  };
  const { active } = indexTree(tree);
  if (
    active.length !== turns.length ||
    references.size !== active.length ||
    active.some((node, index) => references.get(node.id) !== index)
  )
    invalid("readable turns do not match the selected branch");
  return { turns, tree };
}
