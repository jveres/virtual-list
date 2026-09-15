import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const AUTH_URL = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const LOGIN_LIFETIME_MS = 15 * 60_000;

export interface ChatGPTCredentials {
  access: string;
  refresh: string;
  accountId: string;
  expires: number;
}

export interface CredentialStore {
  load(): Promise<ChatGPTCredentials | null>;
  save(credentials: ChatGPTCredentials | null): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credentials(value: unknown): value is ChatGPTCredentials {
  return (
    record(value) &&
    typeof value.access === "string" &&
    value.access.length > 0 &&
    typeof value.refresh === "string" &&
    value.refresh.length > 0 &&
    typeof value.accountId === "string" &&
    value.accountId.length > 0 &&
    typeof value.expires === "number" &&
    Number.isFinite(value.expires)
  );
}

/** A dedicated store, outside Vite's served directories; never reads CLI tokens. */
export function fileCredentialStore(path: string): CredentialStore {
  return {
    async load() {
      try {
        const value: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!credentials(value))
          throw new Error("Invalid ChatGPT credential file; sign in again.");
        return value;
      } catch (error) {
        if (record(error) && error.code === "ENOENT") return null;
        throw new Error(
          "Could not read the demo's ChatGPT credentials. Sign out and sign in again.",
        );
      }
    },
    async save(value) {
      if (value === null) {
        await rm(path, { force: true });
        return;
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(value), {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}

interface PendingLogin {
  deviceId: string;
  userCode: string;
  intervalMs: number;
  nextPoll: number;
  expires: number;
}

export interface ChatGPTAuthStatus {
  authenticated: boolean;
  login?: {
    userCode: string;
    url: string;
    expires: number;
    intervalMs: number;
  };
}

/** Device-code protocol used by Pi/OpenCode, without running either CLI. */
export class ChatGPTAuth {
  private saved: ChatGPTCredentials | null | undefined;
  private pending: PendingLogin | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly abort = new AbortController();

  constructor(
    private readonly store: CredentialStore,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  dispose(): void {
    this.abort.abort();
    this.pending = null;
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      this.abort.signal.throwIfAborted();
      return action();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  private async load(): Promise<ChatGPTCredentials | null> {
    if (this.saved === undefined) this.saved = await this.store.load();
    return this.saved;
  }

  private request(
    path: string,
    body: Record<string, string>,
    form = false,
  ): Promise<Response> {
    return this.fetcher(`${AUTH_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": form
          ? "application/x-www-form-urlencoded"
          : "application/json",
      },
      body: form ? new URLSearchParams(body) : JSON.stringify(body),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]),
      redirect: "error",
    });
  }

  private async acceptToken(response: Response): Promise<ChatGPTCredentials> {
    // Never return upstream token response bodies in errors or logs.
    if (!response.ok)
      throw new Error(
        `ChatGPT token exchange failed (${response.status}); sign in again.`,
      );
    const value: unknown = await response.json().catch(() => null);
    if (
      !record(value) ||
      typeof value.access_token !== "string" ||
      typeof value.refresh_token !== "string" ||
      typeof value.expires_in !== "number" ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 0
    ) {
      throw new Error("ChatGPT returned incomplete credentials.");
    }
    let accountId: unknown;
    try {
      const claims: unknown = JSON.parse(
        Buffer.from(
          value.access_token.split(".")[1] ?? "",
          "base64url",
        ).toString("utf8"),
      );
      const account = record(claims)
        ? claims["https://api.openai.com/auth"]
        : null;
      accountId = record(account) ? account.chatgpt_account_id : undefined;
    } catch {
      /* A malformed token must not escape through an error message. */
    }
    if (typeof accountId !== "string" || !accountId)
      throw new Error("ChatGPT token has no account ID.");
    const next = {
      access: value.access_token,
      refresh: value.refresh_token,
      accountId,
      expires: this.now() + value.expires_in * 1000,
    };
    await this.store.save(next);
    this.saved = next;
    return next;
  }

  startLogin(): Promise<ChatGPTAuthStatus> {
    return this.exclusive(async () => {
      if (this.pending && this.pending.expires > this.now())
        return this.snapshot();
      const response = await this.request("/api/accounts/deviceauth/usercode", {
        client_id: CLIENT_ID,
      });
      if (!response.ok)
        throw new Error(
          `Could not start ChatGPT sign-in (${response.status}). Enable device-code login in ChatGPT security settings.`,
        );
      const value: unknown = await response.json().catch(() => null);
      const interval = record(value) ? Number(value.interval) : NaN;
      if (
        !record(value) ||
        typeof value.device_auth_id !== "string" ||
        !value.device_auth_id ||
        typeof value.user_code !== "string" ||
        !value.user_code ||
        !Number.isFinite(interval) ||
        interval < 0 ||
        interval > 900
      ) {
        throw new Error("ChatGPT returned an invalid device code.");
      }
      const intervalMs = Math.max(1000, interval * 1000);
      this.pending = {
        deviceId: value.device_auth_id,
        userCode: value.user_code,
        intervalMs,
        nextPoll: this.now() + intervalMs,
        expires: this.now() + LOGIN_LIFETIME_MS,
      };
      return this.snapshot();
    });
  }

  private async snapshot(): Promise<ChatGPTAuthStatus> {
    return {
      authenticated: (await this.load()) !== null,
      ...(this.pending
        ? {
            login: {
              userCode: this.pending.userCode,
              url: `${AUTH_URL}/codex/device`,
              expires: this.pending.expires,
              intervalMs: this.pending.intervalMs,
            },
          }
        : {}),
    };
  }

  status(): Promise<ChatGPTAuthStatus> {
    return this.exclusive(async () => {
      const pending = this.pending;
      if (pending && pending.expires <= this.now()) {
        this.pending = null;
        throw new Error("ChatGPT sign-in expired. Start sign-in again.");
      }
      if (pending && pending.nextPoll <= this.now()) {
        pending.nextPoll = this.now() + pending.intervalMs;
        const response = await this.request("/api/accounts/deviceauth/token", {
          device_auth_id: pending.deviceId,
          user_code: pending.userCode,
        });
        if (response.ok) {
          const value: unknown = await response.json().catch(() => null);
          this.pending = null;
          if (
            !record(value) ||
            typeof value.authorization_code !== "string" ||
            typeof value.code_verifier !== "string"
          ) {
            throw new Error("ChatGPT returned an invalid sign-in result.");
          }
          await this.acceptToken(
            await this.request(
              "/oauth/token",
              {
                grant_type: "authorization_code",
                client_id: CLIENT_ID,
                code: value.authorization_code,
                code_verifier: value.code_verifier,
                redirect_uri: `${AUTH_URL}/deviceauth/callback`,
              },
              true,
            ),
          );
        } else if (response.status !== 403 && response.status !== 404) {
          const value: unknown = await response.json().catch(() => null);
          const error = record(value) ? value.error : null;
          const code = record(error) ? error.code : error;
          if (code === "slow_down" || response.status === 429) {
            pending.intervalMs = Math.min(60_000, pending.intervalMs + 5000);
            pending.nextPoll = this.now() + pending.intervalMs;
          } else if (code !== "deviceauth_authorization_pending") {
            this.pending = null;
            throw new Error(
              `ChatGPT sign-in failed (${response.status}). Start sign-in again.`,
            );
          }
        }
      }
      return this.snapshot();
    });
  }

  getCredentials(): Promise<ChatGPTCredentials> {
    return this.exclusive(async () => {
      const current = await this.load();
      if (!current)
        throw new Error("Sign in with ChatGPT in AI settings first.");
      if (current.expires > this.now() + 60_000) return current;
      return this.acceptToken(
        await this.request(
          "/oauth/token",
          {
            grant_type: "refresh_token",
            client_id: CLIENT_ID,
            refresh_token: current.refresh,
          },
          true,
        ),
      );
    });
  }

  logout(): Promise<void> {
    return this.exclusive(async () => {
      this.pending = null;
      await this.store.save(null);
      this.saved = null;
    });
  }
}
