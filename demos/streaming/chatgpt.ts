import { isRecord, mustGet } from "../shared/utils.js";

// A custom header prevents cross-origin form/fetch requests without a CORS
// preflight. The dev relay separately validates Origin, Host, and Fetch Metadata.
export const CHATGPT_RELAY_HEADERS = {
  "x-virtual-list-client": "streaming-demo",
};

async function request(
  path: string,
  signal: AbortSignal,
  method = "GET",
): Promise<Record<string, unknown>> {
  const response = await fetch(`/__chatgpt/${path}`, {
    method,
    headers: CHATGPT_RELAY_HEADERS,
    signal,
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(value)) {
    const error =
      isRecord(value) && isRecord(value.error)
        ? value.error.message
        : undefined;
    throw new Error(
      typeof error === "string"
        ? error
        : "ChatGPT relay unavailable. Run pnpm run dev, then reload this page. The static preview does not include the relay.",
    );
  }
  return value;
}

/** Auth UI has no ownership of chat history; signing out does not delete it. */
export function initChatGPTSettings(): { open(): void; close(): void } {
  const panel = mustGet("ai-settings-panel", HTMLDialogElement);
  const status = mustGet("ai-chatgpt-status");
  const login = mustGet("ai-chatgpt-login", HTMLButtonElement);
  const check = mustGet("ai-chatgpt-check", HTMLButtonElement);
  const logout = mustGet("ai-chatgpt-logout", HTMLButtonElement);
  const code = mustGet("ai-chatgpt-code");
  const link = mustGet("ai-chatgpt-link", HTMLAnchorElement);
  const modelList = mustGet("ai-chatgpt-models", HTMLDataListElement);
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function close(): void {
    controller?.abort();
    controller = null;
    clearTimeout(timer);
    timer = undefined;
    login.disabled = check.disabled = logout.disabled = false;
  }

  async function run(
    action: "status" | "login" | "logout",
    quiet = false,
  ): Promise<void> {
    close();
    const active = new AbortController();
    controller = active;
    login.disabled = check.disabled = logout.disabled = true;
    if (!quiet)
      status.textContent =
        action === "login"
          ? "Starting sign-in…"
          : action === "logout"
            ? "Signing out…"
            : "Checking connection…";
    try {
      const value = await request(
        action,
        active.signal,
        action === "status" ? "GET" : "POST",
      );
      if (active.signal.aborted) return;
      const pending = isRecord(value.login) ? value.login : null;
      link.hidden = !pending;
      code.textContent = "";
      if (pending && typeof pending.userCode === "string") {
        code.textContent = `Code: ${pending.userCode}`;
        status.textContent =
          "Enter this code in ChatGPT sign-in, then return here. Waiting for approval…";
        if (action === "login" && value.browserOpened === false) {
          status.textContent =
            "Open the ChatGPT sign-in link below and enter this code. Waiting for approval…";
        }
        const interval =
          typeof pending.intervalMs === "number"
            ? Math.max(1000, pending.intervalMs)
            : 5000;
        timer = setTimeout(() => {
          if (panel.open) void run("status", true);
        }, interval);
      } else if (value.authenticated === true) {
        status.textContent = "Signed in. Checking available models…";
        const result = await request("models", active.signal);
        if (active.signal.aborted) return;
        const models = Array.isArray(result.models)
          ? result.models.filter(
              (item): item is string => typeof item === "string",
            )
          : [];
        modelList.replaceChildren(
          ...models.map((model) => {
            const option = document.createElement("option");
            option.value = model;
            return option;
          }),
        );
        status.textContent = `Connected to OpenAI. ${models.length} models available.`;
      } else {
        status.textContent = "Not signed in. Choose Sign in.";
      }
    } catch (error) {
      if (!active.signal.aborted) {
        status.textContent =
          error instanceof Error ? error.message : "ChatGPT connection failed.";
        link.hidden = true;
        code.textContent = "";
      }
    } finally {
      if (controller === active)
        login.disabled = check.disabled = logout.disabled = false;
    }
  }

  login.addEventListener("click", () => {
    void run("login");
  });
  check.addEventListener("click", () => {
    void run("status");
  });
  logout.addEventListener("click", () => {
    void run("logout");
  });
  panel.addEventListener("close", close);
  return {
    close,
    open: () => {
      void run("status");
    },
  };
}
