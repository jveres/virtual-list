import { createVirtualList, type VirtualList } from "../../src/index";

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
}

const viewport = document.querySelector<HTMLElement>("#viewport")!;
const form = document.querySelector<HTMLFormElement>("form")!;
const input = form.querySelector<HTMLInputElement>("input")!;
const send = document.querySelector<HTMLButtonElement>("#send")!;
const stop = document.querySelector<HTMLButtonElement>("#stop")!;
const bottom = document.querySelector<HTMLButtonElement>("#bottom")!;
const reset = document.querySelector<HTMLButtonElement>("#reset")!;
const follow = document.querySelector<HTMLSelectElement>("#follow")!;
const status = document.querySelector<HTMLOutputElement>("#status")!;
const lifetime = new AbortController();
let messages: Message[] = [];
let stream: AbortController | undefined;
let list: VirtualList<Message>;
let nextId = 0;

function mount(): void {
  list = createVirtualList(viewport, {
    items: messages,
    key: (message) => message.id,
    pinning: { match: (message) => message.role === "user" },
    scrollingUpdates: "live",
    followBehavior: "smooth",
    followMode: follow.value === "keep-start" ? "keep-start" : "end",
    render: (message, existing) => {
      const row = existing ?? document.createElement("article");
      row.className = "message";
      row.dataset.key = message.id;
      row.dataset.role = message.role;
      row.dataset.streaming = String(message.streaming === true);
      row.textContent = message.text;
      return row;
    },
    onState: (state) => {
      bottom.hidden = state.atEnd;
    },
  });
}

/** Replace the source object, then let the runtime render and measure it. */
function update(message: Message): void {
  messages = messages.map((old) => (old.id === message.id ? message : old));
  list.updateItem(message.id, message);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

async function submit(): Promise<void> {
  if (stream || !input.value.trim()) return;
  const active = new AbortController();
  stream = active;
  send.disabled = true;
  stop.disabled = false;
  status.value = "Streaming";
  const prompt: Message = {
    id: String(nextId++),
    role: "user",
    text: input.value,
  };
  let reply: Message = {
    id: String(nextId++),
    role: "assistant",
    text: "",
    streaming: true,
  };
  messages = [...messages, prompt, reply];
  input.value = "";
  try {
    list.setItems(messages, { anchor: "viewport" });
    // False means interrupted, not failed: the reply may continue without follow.
    await list.scrollTo(prompt.id, { align: "start", behavior: "smooth" });
    for (let line = 0; line < 100 && !active.signal.aborted; line++) {
      reply = {
        ...reply,
        text: `${reply.text}Line ${line + 1}: live content stays readable while you scroll.\n`,
      };
      update(reply);
      // A quiet gap deliberately exercises follow intent across a stalled stream.
      await delay(line === 50 ? 600 : 25, active.signal);
    }
  } finally {
    if (stream === active) {
      try {
        update({ ...reply, streaming: false });
      } finally {
        stream = undefined;
        send.disabled = false;
        stop.disabled = true;
        status.value = active.signal.aborted ? "Stopped" : "Done";
      }
    }
  }
}

const listeners = { signal: lifetime.signal };
form.addEventListener(
  "submit",
  (event) => {
    event.preventDefault();
    void submit().catch((error: unknown) => {
      status.value = String(error);
    });
  },
  listeners,
);
stop.addEventListener("click", () => stream?.abort(), listeners);
bottom.addEventListener(
  "click",
  () => {
    void list.scrollTo("end", { behavior: "smooth" });
  },
  listeners,
);
follow.addEventListener(
  "change",
  () => {
    list.setFollowMode(follow.value === "keep-start" ? "keep-start" : "end");
  },
  listeners,
);
reset.addEventListener(
  "click",
  () => {
    stream?.abort();
    stream = undefined;
    list.dispose();
    messages = [];
    mount();
    send.disabled = false;
    stop.disabled = true;
    status.value = "Ready";
  },
  listeners,
);
window.addEventListener(
  "pagehide",
  () => {
    lifetime.abort();
    stream?.abort();
    stream = undefined;
    list.dispose();
  },
  { once: true },
);
mount();
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
