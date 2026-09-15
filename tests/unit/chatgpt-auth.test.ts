import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatGPTAuth,
  type ChatGPTCredentials,
  type CredentialStore,
  fileCredentialStore,
} from "../../demos/streaming/server/chatgpt-auth";

function memoryStore(
  initial: ChatGPTCredentials | null = null,
): CredentialStore {
  let value = initial;
  return {
    load: async () => value,
    save: async (next) => {
      value = next;
    },
  };
}

function tokenResponse() {
  const claims = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
    }),
  ).toString("base64url");
  return {
    access_token: `header.${claims}.signature`,
    refresh_token: "private-refresh",
    expires_in: 3600,
  };
}

function fixture() {
  let now = 1000;
  const fetcher = vi.fn<typeof fetch>();
  const store = memoryStore();
  const auth = new ChatGPTAuth(store, fetcher, () => now);
  fetcher.mockResolvedValueOnce(
    Response.json({
      device_auth_id: "private-device-id",
      user_code: "TEST-CODE",
      interval: "2",
    }),
  );
  return {
    auth,
    fetcher,
    store,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("ChatGPT device authentication", () => {
  it("should retain OAuth secrets on the server and expose only the login code", async () => {
    const { auth, fetcher, store, advance } = fixture();
    const pending = await auth.startLogin();
    expect(pending).toEqual({
      authenticated: false,
      login: {
        userCode: "TEST-CODE",
        url: "https://auth.openai.com/codex/device",
        expires: 901000,
        intervalMs: 2000,
      },
    });
    expect(JSON.stringify(pending)).not.toContain("private-device-id");
    expect(await auth.startLogin()).toEqual(pending);
    expect(await auth.status()).toEqual(pending);
    expect(fetcher).toHaveBeenCalledTimes(1);

    advance(2000);
    fetcher.mockResolvedValueOnce(
      Response.json({
        authorization_code: "private-code",
        code_verifier: "private-verifier",
      }),
    );
    fetcher.mockResolvedValueOnce(Response.json(tokenResponse()));
    expect(await auth.status()).toEqual({ authenticated: true });
    const exchange = fetcher.mock.calls[2];
    expect(exchange?.[0]).toBe("https://auth.openai.com/oauth/token");
    expect(String(exchange?.[1]?.body)).toContain(
      "grant_type=authorization_code",
    );
    expect(await store.load()).toEqual({
      access: tokenResponse().access_token,
      refresh: "private-refresh",
      accountId: "test-account",
      expires: 3603000,
    });
    expect(await auth.getCredentials()).toEqual(await store.load());
    auth.dispose();
  });

  it.each([403, 404])(
    "should keep polling a pending %i without exceeding the server interval",
    async (status) => {
      const { auth, fetcher, advance } = fixture();
      await auth.startLogin();
      advance(2000);
      fetcher.mockResolvedValueOnce(new Response(null, { status }));
      const values = await Promise.all([
        auth.status(),
        auth.status(),
        auth.status(),
      ]);
      expect(values.map((value) => value.login?.userCode)).toEqual([
        "TEST-CODE",
        "TEST-CODE",
        "TEST-CODE",
      ]);
      expect(fetcher).toHaveBeenCalledTimes(2);
      auth.dispose();
    },
  );

  it("should back off on slow_down and expire abandoned logins", async () => {
    const { auth, fetcher, advance } = fixture();
    await auth.startLogin();
    advance(2000);
    fetcher.mockResolvedValueOnce(
      Response.json({ error: "slow_down" }, { status: 400 }),
    );
    expect((await auth.status()).login?.intervalMs).toBe(7000);
    advance(900000);
    await expect(auth.status()).rejects.toThrow("expired");
    expect(await auth.status()).toEqual({ authenticated: false });
    auth.dispose();
  });

  it("should serialize token refresh across concurrent requests", async () => {
    const store = memoryStore({
      access: "old-access",
      refresh: "old-refresh",
      accountId: "test-account",
      expires: 0,
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(tokenResponse()));
    const auth = new ChatGPTAuth(store, fetcher, () => 1000);
    const result = await Promise.all([
      auth.getCredentials(),
      auth.getCredentials(),
      auth.getCredentials(),
    ]);
    expect(result.map((value) => value.access)).toEqual(
      Array(3).fill(tokenResponse().access_token),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toContain(
      "refresh_token=old-refresh",
    );
    auth.dispose();
  });

  it("should not resurrect credentials when logout races with token refresh", async () => {
    const store = memoryStore({
      access: "old",
      refresh: "old-refresh",
      accountId: "account",
      expires: 0,
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(tokenResponse()));
    const auth = new ChatGPTAuth(store, fetcher, () => 1000);
    await Promise.all([auth.getCredentials(), auth.logout()]);
    expect(await store.load()).toBeNull();
    await expect(auth.getCredentials()).rejects.toThrow("Sign in");
    auth.dispose();
  });

  it("should redact malformed and rejected token responses", async () => {
    const store = memoryStore({
      access: "old",
      refresh: "private-refresh",
      accountId: "account",
      expires: 0,
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("private-refresh private-access", { status: 401 }),
      );
    const auth = new ChatGPTAuth(store, fetcher);
    await expect(auth.getCredentials()).rejects.toThrow(
      "ChatGPT token exchange failed (401); sign in again.",
    );
    fetcher.mockResolvedValueOnce(new Response("malformed-private-token"));
    await expect(auth.getCredentials()).rejects.toThrow(
      "ChatGPT returned incomplete credentials.",
    );
    auth.dispose();
  });

  it("should reject use after disposal", async () => {
    const { auth, fetcher } = fixture();
    auth.dispose();
    await expect(auth.startLogin()).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("should not expose malformed device-auth payloads in client-visible errors", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("private-device-secret:not-json"));
    const auth = new ChatGPTAuth(memoryStore(), fetcher);
    try {
      await expect(auth.startLogin()).rejects.toThrow(
        "ChatGPT returned an invalid device code.",
      );
    } finally {
      auth.dispose();
    }

    const pending = fixture();
    try {
      await pending.auth.startLogin();
      pending.advance(2000);
      pending.fetcher.mockResolvedValueOnce(
        new Response("private-verifier:not-json"),
      );
      await expect(pending.auth.status()).rejects.toThrow(
        "ChatGPT returned an invalid sign-in result.",
      );
      expect(await pending.auth.status()).toEqual({ authenticated: false });
    } finally {
      pending.auth.dispose();
    }
  });
});

describe("dedicated ChatGPT credential storage", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("should round-trip credentials with owner-only permissions and remove them on logout", async () => {
    directory = await mkdtemp(join(tmpdir(), "virtual-list-oauth-test-"));
    const path = join(directory, "auth", "chatgpt.json");
    const store = fileCredentialStore(path);
    expect(await store.load()).toBeNull();
    const saved = {
      access: "test-access",
      refresh: "test-refresh",
      accountId: "test-account",
      expires: 12345,
    };
    await store.save(saved);
    expect(await store.load()).toEqual(saved);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "auth"))).mode & 0o777).toBe(0o700);
    await store.save(null);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("should not expose file contents when stored credentials are malformed", async () => {
    directory = await mkdtemp(join(tmpdir(), "virtual-list-oauth-test-"));
    const path = join(directory, "chatgpt.json");
    await writeFile(path, "private-token:broken-json");
    await expect(fileCredentialStore(path).load()).rejects.toThrow(
      "Could not read the demo's ChatGPT credentials. Sign out and sign in again.",
    );
  });
});
