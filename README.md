# Pi Remote

Turn on `/remote` in an **existing pi session**, then control it from your phone. Your agent, tools, credentials, and repository stay on your computer. Both the computer and phone make outbound connections to a small relay.

**MVP:** a pi 1.1.0 extension, Node WebSocket relay, and mobile-first web client. This is not a native iOS/Android app yet.

```
pi session → outbound WSS → relay ← WSS ← phone browser
```

## Features

- `/remote` enables access; `/remote off` disables it and invalidates the active pairing on a connected relay.
- Private pairing link with an end-to-end AES-256-GCM key in the URL fragment (not sent in HTTP requests).
- Existing conversation, streamed assistant text, active tool names, expandable tool results.
- Send a prompt while idle; interrupt a running agent. Busy prompts are explicitly rejected, not silently queued.
- Reconnect and latest-state replay; command IDs prevent duplicate execution during retries. Outbound host buffering is capped at 2 MB, and silent relay connections are terminated after 45 seconds.
- No server-side repository access, model API keys, plaintext session storage, or command execution.
- Visible terminal status while remote access is enabled.

## Requirements

- Node.js 22.19+ and npm.
- Pi 1.1.0 (`@earendil-works/pi-coding-agent`); extension APIs are version-specific.
- HTTPS relay address reachable from both devices. HTTP is supported only for local development on localhost.

## 1. Run the relay

On your server:

```sh
cd /home/solopie/repos/pi-remote
npm ci

# Generate this once, save it securely, and use the SAME token on the pi machine.
export PI_REMOTE_TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
npm start
```

The relay binds to `127.0.0.1:8787`. Environment variables are read from the process; `.env` is **not automatically loaded**. Node supports `node --env-file=.env src/server.js` if you prefer a file. See `.env.example`.

Put a TLS reverse proxy in front of the relay. Example Caddy configuration (replace the domain):

```caddy
pi.example.com {
    reverse_proxy 127.0.0.1:8787 {
        # Overwrite any client-supplied value; never pass it through.
        header_up X-Real-IP {remote_host}
    }
}
```

For this same-machine proxy, set `PI_REMOTE_TRUSTED_PROXIES=127.0.0.1` before starting the relay (restart an existing relay). This makes admission quotas per client rather than shared by all proxy users. The setting is a comma-separated list of **exact TCP peer IP addresses**, not CIDRs. For containers or other proxy arrangements, use the actual proxy peer address seen by the relay. Leave it unset for direct connections. Trusted proxies must overwrite `X-Real-IP` with a single valid client IP; missing or malformed values are rejected. Keep the backend private and trust only proxies you control.

Caddy automatically supports WebSocket upgrades. Use an HTTPS URL, keep port 8787 private, and do not log WebSocket payloads. For private access you can instead use a properly configured Tailscale HTTPS endpoint. A VPN is recommended for an initial deployment.

Optional container:

```sh
docker build -t pi-remote .
docker run --rm -e PI_REMOTE_TOKEN -p 127.0.0.1:8787:8787 pi-remote
```

The server token authorizes **pi hosts**, not phones. Never include it in a pairing link. Rotating it requires restarting the relay and updating your pi environment.

## 2. Load the extension on your computer

```sh
cd /home/solopie/repos/pi-remote
npm ci
export PI_REMOTE_URL=https://pi.example.com
export PI_REMOTE_TOKEN='the-same-server-token'

# Temporary extension, preserving your normal pi configuration:
cd /path/to/your/project
pi -e /home/solopie/repos/pi-remote/extension/remote.ts
```

For permanent installation, use pi's local-package installer:

```sh
pi install /home/solopie/repos/pi-remote
```

Then start pi with the two environment variables set. Installing is optional; this project does not change your pi settings automatically.

## 3. Connect your phone

1. In the local pi terminal, run `/remote`.
2. Open the printed private link in Safari/Chrome on your phone. Alternatively open the relay website and paste the link there.
3. View activity, send prompts, or tap **Stop agent**.
4. Run `/remote off` locally to revoke control. Running `/remote` again while enabled prints the same pairing link; after disabling, the next enable generates a new room and key.

The phone immediately strips the secret fragment from the address bar, including when a new link is opened in an already-loaded tab, and stores the key **only in memory**. Opening another link disconnects the previous session before pairing. Keep the link securely if you want to reconnect after closing/reloading the page. Disconnecting the phone does not revoke that link or stop the agent. The manifest supports standalone display when added to a home screen, but offline support, service workers, and push notifications are not implemented.

For a localhost-only smoke test, set `PI_REMOTE_URL=http://localhost:8787` and open the link on the same computer. Plain HTTP at a LAN IP is intentionally unsupported; mobile cryptography requires a secure browser context.

## Behavior and limits

- Pi is authoritative. Losing the relay/phone connection does not interrupt local work.
- Computer sleep or pi exit makes the session unavailable; the relay does not keep your agent alive.
- Latest snapshots contain up to **40 messages**, with **4,000 characters per message**. Snapshots also have a 600 KB UTF-8 JSON budget; older messages are omitted when necessary to stay below the encrypted transport limit. Session names and IDs are capped at 256 characters, and active tool names at 100 entries of 128 characters each. Snapshot failures are contained and shown in the terminal status instead of crashing pi. Thinking, images, raw tool arguments, and custom messages are omitted. Public tool output can still contain sensitive information.
- There is no durable relay database. Disconnected rooms expire after approximately five minutes. A restarted relay is repopulated by reconnecting pi hosts; if a phone reconnects first, reopen its link once pi is connected. Stale host connections and temporary room/client capacity limits cause retryable `1013` closes, not revocation; hosts and phones retain their pairing and retry as capacity becomes available. Invalid authentication still produces a terminal `1008` rejection.
- Commands expire after two minutes and are deduplicated for the active pairing. After 10,000 commands, start a fresh pairing. A successful prompt acknowledgement is sent when that submission's own agent turn starts, not when the task completes. Its asynchronous invocation context is tracked, so unrelated local turns cannot acknowledge it. Pi’s fire-and-forget submission API does not expose asynchronous preflight errors or cancellation. While submission is pending, the phone disables **Stop agent** and the host explicitly rejects interrupt requests; an idle abort cannot cancel preflight. If no correlated turn starts within 15 seconds, the phone receives an unknown-outcome warning. The submission identity and lock remain until that submission's turn starts or remote access is disabled, preventing an unrelated or late start from acknowledging a newer prompt. Check pi before restarting `/remote` or resending: a delayed submission may still execute. Retries of the same command ID never submit it again.
- No follow-up/steering queue, file browser, dedicated diff viewer, multi-session account dashboard, push notifications, or voice input yet.
- Starting/switching/forking a pi session disables remote access; enable it again in the new session. Branch navigation rebuilds the transcript.
- Remote input does not expand slash commands or prompt templates. It goes through pi's normal user-message API.

## Security model

**A pairing link grants agent control, which can amount to shell access. Treat it like a password.** Do not share it in screenshots, tickets, or public messages.

The relay routes encrypted snapshots, acknowledgements, and commands. It can see room identifiers, connection timing, and ciphertext sizes, but does not receive the encryption key. Host and client packets use different authenticated encryption contexts to prevent reflection. Protocol v2 also authenticates each packet type (`state`, `ack`, or `command`), preventing relabelling attacks. The client validates snapshot/acknowledgement schemas before changing its revision or UI, and uses text rendering, not unsafe HTML.

However, this is an MVP, not a security-audited product. The web client is delivered by the relay: a compromised relay could serve malicious JavaScript that steals a pairing key. Use a server you trust. A future signed native client would strengthen this boundary. Local extensions can also observe user input through normal pi hooks.

The relay enforces payload, connection, room, client, and per-connection message limits, same-origin browser connections, and heartbeat checks. Upgrade admission also limits unauthenticated connections to 32 globally and 8 per TCP peer, with at most 60 upgrades per minute per peer and a bounded 1,000-peer tracking table. Unauthenticated connections are terminated after five seconds. Behind a reverse proxy, configure `PI_REMOTE_TRUSTED_PROXIES` and the overwriting `X-Real-IP` header as shown above to isolate client quotas; otherwise these peer quotas remain shared by its users. Forwarded headers from untrusted TCP peers are ignored, including `X-Forwarded-For`. Configure client-IP connection and upgrade-rate limits at the proxy as well. These are basic safeguards, not a complete internet-facing abuse defense. Keep the relay behind a VPN initially; TLS remains required for the phone UI.

`/remote off` immediately stops the extension accepting commands. If the relay is connected, its room is deleted. If it is unreachable, a cached encrypted snapshot may remain accessible to someone with the old link until the room expires; it cannot control the disabled agent.

## Development and validation

```sh
npm run check  # TypeScript checks and Node tests; no model calls
```

Tests exercise Node/browser cryptography interoperability, transcript filtering, relay authentication/routing/reconnect/replay/revocation, extension prompt/interrupt/deduplication behavior against a real relay with mocked pi APIs, same-document pairing and key-import races, and temporary capacity recovery. A real pi 1.1.0 SDK test verifies submission identity across delayed/transformed preflight and unrelated local turns using a synthetic stream (no model requests). The extension was also loaded through the real pi 1.1.0 RPC CLI, and a 390px-wide Chromium smoke check covered pairing, prompt submission, encrypted acknowledgement, layout, and disconnect.

### Protocol sketch

WebSocket `/ws`; first record is `{type:"join",role:"host"|"client",room,...}`. Hosts include the server token. Room IDs and encryption keys are independent random 256-bit values. Clients route using the room ID; neither join record includes the encryption key.

Hosts send `state` and `ack`; clients send `command`. Those records contain `{payload:{iv,data}}`, base64url AES-GCM envelopes, with authenticated additional data `pi-remote/v2/<direction>/<type>`. Snapshots have monotonic revisions and boolean `busy`/`submitting` fields. Commands have `id`, `action`, optional `text`, and `createdAt`; acknowledged IDs are retained locally for the pairing lifetime. Reconnecting clients receive the latest encrypted snapshot instead of unbounded event history. Relay presence messages are routing status, not authenticated agent output.

**Upgrade note:** Protocol v2 intentionally rejects v1 ciphertext; there is no insecure compatibility fallback. Restart the updated relay, update/restart the extension, reload the phone website, and create a new pairing with `/remote off` followed by `/remote`.
