# OpenAI Subscription demo provider

The streaming demo can use a ChatGPT subscription without a Codex process.
The browser owns the conversation and sends the selected context with each
request. A local relay handles OpenAI authentication and forwards the stream.
The relay is demo code, not part of the virtual-list runtime.

> **Note:** This is a preview feature currently under active development.

## Start and sign in

You need a ChatGPT account with access to the requested models. Enable
device-code login in your ChatGPT security settings before you start.
OpenAI documents this prerequisite in its
[authentication guide](https://learn.chatgpt.com/docs/auth).

Use only a trusted network. Every device that can reach the enabled dev
server can use its signed-in account and consume its subscription allowance.
The relay rejects cross-origin browser requests, but it does not authenticate
individual LAN devices. Do not expose this server through a public tunnel.

1. Start the dev server on your Mac:

   ```sh
   pnpm run dev --host 0.0.0.0
   ```

2. Open `/demos/streaming/index.html` at the server address on your device.
3. Open AI settings and select **OpenAI Subscription**.
4. Select **Sign in**.
5. Enter the displayed device code in ChatGPT sign-in.
6. Return to the demo and wait for the connected status.

There is no console token to copy. **Check connection** reads authentication
status and the available models without generating a response. A blank model
field uses the first visible model from the account catalog. You can choose
another model from the field suggestions or enter its identifier.

On macOS, **Sign in** opens ChatGPT sign-in in the Mac's default browser.
This also applies when a LAN device starts sign-in. If the browser does not
open, use the displayed sign-in link on your current device instead.

The ordinary `pnpm run dev` command includes the relay. It connects to an
account only after sign-in, or when it loads credentials from an earlier
sign-in. Production builds and `pnpm run preview` do not provide the relay.

## Conversation ownership

The **OpenAI API token**, **OpenAI Subscription**, and **Simulated** providers
keep separate histories in the browser. The subscription relay has no shared
thread and no conversation database. Signing in on the relay does not copy
conversation history between devices.

- **Delete** removes the selected messages from future request context.
- **Edit** regenerates from the edited prompt without the old continuation.
- **Regenerate** sends the history before the selected answer.
- **Clear history** clears the active provider's local conversation.
- Reloading the page restores all saved versions and the selected branch,
  including earlier errors and stopped replies.

The request includes either the selected number of turns or the full active
history. Completed response data preserves reasoning items and message phases
for later requests. Subscription requests always use `store: false` and omit
`previous_response_id` and `conversation`.

Stopping a reply or disconnecting the browser cancels the relay's upstream
connection. The relay does not retain a background response for reconnection.
A page refresh restores the last saved state, not a resumable server stream.
This implementation does not perform automatic context compaction.

## Credentials and limits

OpenAI access and refresh tokens stay on the Mac in
`~/.config/virtual-list-demo/chatgpt.json`. The relay writes this file with
owner-only permissions and never sends its contents to the browser. It does
not read or change Codex CLI credentials. Run only one enabled dev server at
a time because the credential file belongs to that relay account.

**Sign out** removes the relay's saved credentials and cancels active requests
across its devices. It does not clear browser histories or revoke other OpenAI
sessions. Normal server restarts retain the account login and refresh expired
access tokens when needed.

Requests go only to `https://chatgpt.com/backend-api/codex`. There is no fallback
to the paid OpenAI API. Tool and attachment support depends on the selected
model and backend. Unsupported combinations produce an inline error.
Generated image bytes can use the existing renderer. Downloads that require
the public API's generated-file endpoint are explicitly unsupported here.

The relay limits each request body to 24 MiB, allows four concurrent requests,
and ends generation connections after 15 minutes. Sign-out remains available
when those slots are full and cancels unfinished uploads as well as streams.
The relay validates local hostnames,
request origins, and a browser request header. These checks block cross-site
browser access, not other users on the same trusted network.

This integration follows the direct OAuth patterns in
[Pi's authentication implementation](https://github.com/earendil-works/pi/blob/main/packages/ai/src/auth/oauth/openai-codex.ts)
and [OpenCode's subscription provider](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/openai/codex.ts).
Their use of this backend is not a guarantee of official third-party API
support or future compatibility.

## Verification

The automated checks use fake OpenAI responses, not real account credentials.
Unit tests cover device login, polling intervals, token refresh races,
credential permissions, host and origin checks, request validation, context
replay, and disconnect cancellation. The browser regression exercises sign-in
controls, edit, regenerate, delete, reload, and provider isolation.

```sh
pnpm run check
pnpm test
pnpm run test:regression --match=chatgpt-provider
pnpm run test:regression --match=provider-versions
pnpm run test:regression --match=image-cursor-spacing
```

A real account sign-in and live model response still require manual validation.
The offline checks do not establish current account entitlement or tool support.
