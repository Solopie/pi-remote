# Pi Remote

Turn on `/remote` in an **existing pi session**, then control it from your phone. Your agent, tools, model API credentials, and repository stay on your computer. Both the computer and phone make outbound connections to a small relay. Choose private QR pairing or Google-authenticated, trusted-relay session discovery.

**MVP:** a pi 1.1.0 extension, Node WebSocket relay, and mobile-first web client. This is not a native iOS/Android app yet.

```
pi session → outbound WSS → relay ← WSS ← phone browser
```

## Features

- `/remote` enables access; `/remote off` disables it and invalidates the active pairing on a connected relay.
- `/remote setup` prompts for the relay URL and its existing token, then saves private local settings.
- Optional Google SSO restricted to one verified email, with a connected-session dashboard and QR-free selection for explicitly enrolled Pi clients.
- Locally generated terminal QR code and copyable private pairing link, with an end-to-end AES-256-GCM key in the URL fragment (not sent in HTTP requests).
- Existing conversation, streamed assistant text, expandable provider-exposed thinking, tool inputs (including bash commands), active tool details, and expandable tool results.
- On phones, the connected view fits the screen: only the chat scrolls, including live tool details, while the header and composer stay in place.
- Send a prompt while idle; interrupt a running agent. Busy prompts are explicitly rejected, not silently queued.
- Reconnect and latest-state replay; command IDs prevent duplicate execution during retries. Outbound host buffering is capped at 2 MB, and silent relay connections are terminated after 45 seconds.
- No relay-side repository access or model API keys. In trusted-dashboard mode, the relay holds session keys and can read/control enrolled sessions; Google login gates browser access.
- Visible terminal status while remote access is enabled.

## Requirements

- Node.js 22.19+ and npm.
- Pi 1.1.0 (`@earendil-works/pi-coding-agent`); extension APIs are version-specific.
- HTTPS relay address reachable from both devices. HTTP is supported only for local development on localhost.

The examples below use `/path/to/pi-remote` as a placeholder for your local checkout. Replace it with the directory where you cloned this repository. Relay domains and tailnet names are examples too; use your own.

## 1. Run the relay

Start the relay on your server:

```sh
cd /path/to/pi-remote
npm ci
npm start
```

When `PI_REMOTE_TOKEN` is **unset**, the relay generates a **43-character, 256-bit cryptographically random token** and prints it once after successfully starting. Copy the token **value** into `/remote setup` on each Pi client. The relay owns this credential; clients do not generate or rotate it.

An automatically generated token is kept in process memory, so restarting the relay generates a **new token**. To keep the same relay-issued token across restarts, set `PI_REMOTE_TOKEN` to that value in the relay's private environment or environment file. Explicitly configured tokens must be at least 32 characters and are not printed at startup. Keep startup output and service logs private, since automatically generated credentials appear there.

The relay binds to `127.0.0.1:8787`. **`npm start` automatically loads `.env` from this checkout if it exists**, using Node’s `--env-file-if-exists` option. Explicit process environment variables take precedence over file values. Missing `.env` is allowed. Direct `node src/server.js` does not load a file; use `node --env-file=.env src/server.js` to require one explicitly. Keep `.env` private (`chmod 600 .env`); see `.env.example`.

Choose one of the following HTTPS setups. **Tailscale Serve is recommended for private access; it does not require Caddy.** Both options proxy the website and WebSocket connections to the local relay.

### Option A: Private HTTPS with Tailscale Serve

1. Install Tailscale and sign in on the relay machine, the pi computer (if separate), and your phone. Connect all of them to the same tailnet. Your tailnet's ACLs/grants must allow the pi computer and phone to reach the relay machine on TCP port 443.
2. Enable **MagicDNS** and **HTTPS certificates** in the tailnet's DNS settings, or follow the HTTPS enablement link if `tailscale serve` prompts you. See [Tailscale's HTTPS setup](https://tailscale.com/kb/1153/enabling-https). Certificate transparency logs expose the machine's `.ts.net` name, so choose a non-sensitive machine name.
3. Keep the Node relay running on `127.0.0.1:8787`. On the relay machine, in another terminal, run:

   ```sh
   sudo tailscale serve --bg http://127.0.0.1:8787
   sudo tailscale serve status
   ```

   You can configure Serve before starting the Node relay if you need its URL for `/remote setup`. Serve terminates HTTPS and forwards WebSocket upgrades automatically. Use the **root URL** it reports, for example `https://relay-host.example-tailnet.ts.net`, as `PI_REMOTE_URL` on the pi computer when [loading the extension](#2-load-the-extension-on-your-computer). Do not append `/ws`, use port 8787 in that URL, or serve the app under a subpath.
4. Keep Tailscale connected on your phone when [opening the private pairing link](#3-connect-your-phone). Use **Serve**, not **Funnel**: Serve is tailnet-only, whereas Funnel exposes the endpoint to the public internet. Tailnet access is an additional layer: hosts still need the relay token, and phones still need the private pairing link.

Leave `PI_REMOTE_TRUSTED_PROXIES` **unset or empty** for this option, and restart the relay if you previously set it for Caddy. Serve supplies `X-Forwarded-For`, which this relay does not use for admission quotas; it does not provide the required overwriting `X-Real-IP` header. Quotas therefore remain shared by users connecting through Serve. Do not copy the Caddy trusted-proxy setting below into this setup.

`--bg` keeps Serve configured in the Tailscale daemon; it does **not** keep the Node relay process running. Run the relay separately (for example, as a systemd service) if it should survive terminal closure or reboot. No public port forwarding is needed, and port 8787 should remain private.

**NixOS:** enable Tailscale declaratively in your NixOS configuration and rebuild it:

```nix
services.tailscale.enable = true;
```

Then run `sudo tailscale up` if the machine is not already signed in. The Tailscale package lives in `/nix/store` and its daemon is managed by NixOS; no separate Caddy binary or Nix profile is needed for Serve. This enables Tailscale, not the pi-remote Node service.

### Option B: HTTPS with Caddy

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

Caddy automatically supports WebSocket upgrades. Use an HTTPS URL, keep port 8787 private, and do not log WebSocket payloads. A VPN is recommended for an initial deployment.

### Optional container (either HTTPS option)

```sh
docker build -t pi-remote .
docker run --rm -e PI_REMOTE_TOKEN -p 127.0.0.1:8787:8787 pi-remote
```

The server token authorizes **pi hosts**, not phones. Never include it in a pairing link. Rotating it requires restarting the relay and updating your pi environment.

## Optional: Google login and trusted session dashboard

Without Google configuration the existing private-link, opaque-transport mode remains available. If any Google variable is present, **all four are required**; incomplete configuration prevents startup rather than opening unauthenticated access. With Google configured, **every browser/client connection requires login**, even when using a pairing link. Pi hosts continue to use `PI_REMOTE_TOKEN` and do not need Google credentials.

1. In Google Auth Platform, create a **Web application** OAuth client. For an External app in Testing, add your account as a test user. Only `openid` and `email` scopes are used. Testing-user configuration is not the security allowlist: the relay independently verifies the signed ID token, issuer, audience, expiration, nonce, `email_verified`, and exact configured email.
2. Register this exact authorized redirect URI, substituting your real HTTPS origin:
   `https://relay-host.your-tailnet.ts.net/auth/google/callback`.
   No JavaScript origin is needed. Google redirects your browser; a private Tailscale Serve URL works without exposing the relay through Funnel. Both the browser and relay need access to Google. If Google's domain rules reject your hostname, use an HTTPS hostname on a domain you own.
3. Add these settings to private `.env` (already Git-ignored) or a private runtime environment file:

   ```dotenv
   PI_REMOTE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   PI_REMOTE_GOOGLE_CLIENT_SECRET=your-client-secret
   PI_REMOTE_ALLOWED_EMAIL=owner@example.com
   PI_REMOTE_PUBLIC_URL=https://relay-host.your-tailnet.ts.net
   ```

   `chmod 600 .env`. Use your real email only in private configuration, not committed examples. Keep OAuth secrets out of Nix expressions and `/nix/store`; use a runtime environment file. `PI_REMOTE_PUBLIC_URL` must be the externally visible HTTPS root origin, not the backend HTTP listener. Loopback HTTP is supported only for development. No arbitrary forwarded headers are used to construct OAuth redirects.
4. Preserve the same relay-issued `PI_REMOTE_TOKEN` if you want existing Pi clients to reconnect. When you are ready to deploy, stop the old relay and start **one** replacement with `npm start`. It loads the checkout’s `.env` automatically; use `node --env-file=/path/to/private/relay.env src/server.js` for a different runtime file. Automatic host tokens rotate on restart if you do not persist one. Do not restart a running relay until you are ready to apply the configuration.
5. In an existing interactive Pi process, load the updated extension and opt in without restarting Pi:

   ```text
   /remote off
   /reload
   /remote trust
   /remote
   ```

   Confirm the explicit key-sharing warning. This applies to the current Pi process, including `/reload`, but is not written to disk. `/remote off` followed by `/remote untrust` disables discovery for that process. Changing the relay URL through `/remote setup` clears this process's trust flag.

   For **future Pi launches**, set the explicit environment opt-in:

   ```sh
   PI_REMOTE_TRUST_RELAY=true pi -e /path/to/pi-remote/extension/remote.ts
   ```

   Use existing saved `/remote setup` settings or supply the relay URL/token as before. Resume an existing Pi session if needed. The flag must be in **Pi's environment**, not only the relay's `.env`; changing a parent shell after Pi started does not change Pi's environment. Reloading extension code alone cannot set this flag; use `/remote trust` interactively or set it before launch. Run `/remote` in each desired session. Enrollment lasts only for that enabled pairing and is re-registered on reconnect; `/remote off` removes it. Session labels are captured at host connection time. Unenrolled connected hosts appear as “pairing required”; they can still be opened using their private link **after signing in**.
6. Open the relay root page, sign in with the allowed Google account, and select a session. The dashboard refreshes every ten seconds and has a manual Refresh button. “Sessions” disconnects this browser and returns to the list without revoking Pi access. “Sign out” invalidates that login and closes its active client sockets. Login cookies are HttpOnly, SameSite=Lax, Secure on HTTPS, and expire after eight hours. OAuth transactions expire in five minutes; state/cookie binding, PKCE, and nonce checks protect the login flow. Logout requires same-origin POST with a session CSRF token.

**Trust boundary:** `PI_REMOTE_TRUST_RELAY=true` sends the enabled session's pairing key and bounded label to the relay over WSS. The authenticated key endpoint lets your browser open it without a QR code. Snapshots/commands still use authenticated encryption, but this is **not end-to-end confidentiality against the relay**: a compromised relay can read/control enrolled sessions. Unenrolled hosts never send their keys. Dashboard lists, keys, OAuth transactions, and login sessions are memory-only; relay restart logs browsers out. Keys are not included in the session-list response, browser history, or application logs.

## 2. Load the extension on your computer

```sh
cd /path/to/pi-remote
npm ci
# Interactive setup does not require PI_REMOTE_URL/PI_REMOTE_TOKEN beforehand.

# Temporary extension, preserving your normal pi configuration:
cd /path/to/your/project
pi -e /path/to/pi-remote/extension/remote.ts
```

For permanent installation, use pi's local-package installer:

```sh
pi install /path/to/pi-remote
```

Installing is optional. It loads the extension but does not configure or enable remote access.

### Interactive configuration: `/remote setup`

In the pi terminal:

1. Start the relay as described in [step 1](#1-run-the-relay), then run `/remote setup` in Pi and enter the **root relay URL**, such as the actual `https://relay-host.example-tailnet.ts.net` URL printed by `tailscale serve status`, or your Caddy domain. HTTPS is required except for localhost development. If a valid URL is already configured, Enter keeps it; Escape cancels without changing settings.
2. Confirm replacement if settings already exist, then paste the **relay-issued token value** from the relay's startup output (or obtain its explicitly configured token from the relay operator). Enter keeps an existing token only for the same relay URL; the token is never shown as a default or repeated in the completion notification.
3. Setup saves this Pi client's credentials; it does **not** generate or rotate tokens, change the running relay, manage Tailscale/Caddy, or enable remote access automatically.
4. Run `/remote` to enable access, then follow [step 3](#3-connect-your-phone) to pair your phone.

The URL and token are saved to `~/.pi/agent/pi-remote.json` (or the directory selected by `PI_CODING_AGENT_DIR`). The file is written atomically with mode `0600` on Unix, and `/remote` loads it automatically. Setup also applies the values to the current pi process, so no pi restart is needed; your parent shell is unchanged. This is a dedicated extension file, not a modification to pi's main settings or session transcript. Pairing encryption keys are separate and are never stored there.

Explicit `PI_REMOTE_URL` and `PI_REMOTE_TOKEN` environment variables take precedence over saved settings on later launches. Update or unset old overrides **in the shell that launches pi**, not the relay's environment. To override a saved URL with a different relay, supply its token too; saved tokens are not sent to another relay.

Run `/remote off` before re-running setup. Replacing existing settings requires confirmation but does not affect the relay or other clients. If the relay issues a new token after a restart, update the saved token on each Pi client before reconnecting. `/remote off`, session changes, or shutdown cancel a pending setup dialog. Setup requires an interactive UI; non-interactive clients can use the environment variables below instead.

### Manual configuration (optional)

Before starting pi, set both variables instead of using the setup wizard:

```sh
# Replace with the root HTTPS URL from your chosen setup above.
# Tailscale Serve: the actual .ts.net URL printed by `tailscale serve status`.
# Caddy: your configured domain, e.g. https://pi.example.com.
export PI_REMOTE_URL=https://relay-host.example-tailnet.ts.net
export PI_REMOTE_TOKEN='the-token-issued-by-the-relay'
pi -e /path/to/pi-remote/extension/remote.ts
```

The relay and Pi extension must use the same relay-issued token. Phones use the separate private QR/pairing link; the relay token is never included in it.

## 3. Connect your phone

1. In the local pi terminal, run `/remote`.
2. **Scan the terminal QR code with your phone's camera** and open the link in Safari/Chrome. The copyable private link is also printed below the QR; alternatively open the relay website and paste that link there.
3. View activity, send prompts, or tap **Stop agent**.
4. Run `/remote off` locally to revoke control. Running `/remote` again while enabled displays the same QR and pairing link; after disabling, the next enable generates a new room and key.

QR generation happens entirely on the pi computer: no external QR service, relay request, or image file receives the pairing secret. The terminal uses high-contrast Unicode half-blocks. Keep the **entire QR, including its white border**, visible; enlarge the terminal or reduce its font size if clipped. A narrow terminal shows the copyable link and the required width instead of a broken QR; widen it and run `/remote` again. RPC clients receive the QR as ANSI text in the UI notification.

The phone immediately strips the secret fragment from the address bar, including when a new link is opened in an already-loaded tab, and stores the key **only in memory**. Opening another link disconnects the previous session before pairing. Keep the link securely if you want to reconnect after closing/reloading the page. Disconnecting the phone does not revoke that link or stop the agent. The manifest supports standalone display when added to a home screen, but offline support, service workers, and push notifications are not implemented.

For a localhost-only smoke test, set `PI_REMOTE_URL=http://localhost:8787` and open the link on the same computer. Plain HTTP at a LAN IP is intentionally unsupported; mobile cryptography requires a secure browser context.

## Behavior and limits

- Pi is authoritative. Losing the relay/phone connection does not interrupt local work.
- Computer sleep or pi exit makes the session unavailable; the relay does not keep your agent alive.
- Latest snapshots contain up to **40 messages**, with **4,000 characters per message**. Snapshots also have a 600 KB UTF-8 JSON budget; older messages are omitted when necessary to stay below the encrypted transport limit. Provider-exposed thinking text is capped at 4,000 characters per message; up to 20 tool calls per message carry inputs capped at 4,000 characters each. Thinking starts collapsed, and tool inputs start expanded. Live tool inputs appear while executing, including nested tool calls emitted by Pi; completed top-level calls remain in the conversation. Session names and IDs are capped at 256 characters, active tool names at 100 entries of 128 characters each, and live tool details at 20 entries. Snapshot failures are contained and shown in the terminal status instead of crashing pi. Images, provider signatures, safety-redacted thinking, and custom messages are omitted. Thinking is available only when the provider exposes it; opaque reasoning payloads are never decoded or forwarded. Tool inputs, thinking, and tool output can contain sensitive information.
- There is no durable relay database. Disconnected rooms expire after approximately five minutes. With a stable, explicitly configured relay token, a restarted relay is repopulated by reconnecting pi hosts; if a phone reconnects first, reopen its link once pi is connected. With automatic startup tokens, update each Pi client's token after a relay restart and re-enable `/remote`. Stale host connections and temporary room/client capacity limits cause retryable `1013` closes, not revocation; hosts and phones retain their pairing and retry as capacity becomes available. Invalid authentication still produces a terminal `1008` rejection.
- Commands expire after two minutes and are deduplicated for the active pairing. After 10,000 commands, start a fresh pairing. A successful prompt acknowledgement is sent when that submission's own agent turn starts, not when the task completes. Its asynchronous invocation context is tracked, so unrelated local turns cannot acknowledge it. Pi’s fire-and-forget submission API does not expose asynchronous preflight errors or cancellation. While submission is pending, the phone disables **Stop agent** and the host explicitly rejects interrupt requests; an idle abort cannot cancel preflight. If no correlated turn starts within 15 seconds, the phone receives an unknown-outcome warning. The submission identity and lock remain until that submission's turn starts or remote access is disabled, preventing an unrelated or late start from acknowledging a newer prompt. Check pi before restarting `/remote` or resending: a delayed submission may still execute. Retries of the same command ID never submit it again.
- No follow-up/steering queue, file browser, dedicated diff viewer, push notifications, or voice input yet.
- Starting/switching/forking a pi session disables remote access; enable it again in the new session. Branch navigation rebuilds the transcript.
- Remote input does not expand slash commands or prompt templates. It goes through pi's normal user-message API.

## Security model

**A pairing link or its QR code grants agent control, which can amount to shell access. Treat both like passwords.** Do not share them in screenshots, tickets, or public messages.

The setup file contains a plaintext relay token protected by user-only file permissions. Keep it, the relay's generated-token startup output, and any relay environment file private; do not commit them to a repository or embed secrets in Nix configuration that puts them in the world-readable `/nix/store`. Setup uses terminal UI only: it does not add credentials to model messages, the session transcript, or phone snapshots.

Thinking and tool inputs are included only inside encrypted snapshots (end-to-end only for unenrolled hosts), never added to pairing URLs or relay logs. Treat the phone display as sensitive: commands, paths, file contents, and provider-exposed thinking may contain secrets.

**Transport-only mode:** the relay routes encrypted snapshots, acknowledgements, and commands. It can see room identifiers, connection timing, and ciphertext sizes, but does not receive the encryption key. Host and client packets use different authenticated encryption contexts to prevent reflection. Protocol v2 also authenticates each packet type (`state`, `ack`, or `command`), preventing relabelling attacks. The client validates snapshot/acknowledgement schemas before changing its revision or UI, and uses text rendering, not unsafe HTML.

However, this is an MVP, not a security-audited product. The web client is delivered by the relay: a compromised relay could serve malicious JavaScript that steals a pairing key. Use a server you trust. A future signed native client would strengthen this boundary. Local extensions can also observe user input through normal pi hooks.

The relay enforces payload, connection, room, client, and per-connection message limits, same-origin browser connections, and heartbeat checks. Upgrade admission also limits unauthenticated connections to 32 globally and 8 per TCP peer, with at most 60 upgrades per minute per peer and a bounded 1,000-peer tracking table. Unauthenticated connections are terminated after five seconds. For the Caddy option, configure `PI_REMOTE_TRUSTED_PROXIES` and the overwriting `X-Real-IP` header as shown above to isolate client quotas. For Tailscale Serve, leave `PI_REMOTE_TRUSTED_PROXIES` unset or empty; peer quotas remain shared by its users. Forwarded headers from untrusted TCP peers are ignored, including `X-Forwarded-For`. Configure client-IP connection and upgrade-rate limits at the proxy where supported. These are basic safeguards, not a complete internet-facing abuse defense. Keep the relay behind a VPN initially; TLS remains required for the phone UI.

`/remote off` immediately stops the extension accepting commands. If the relay is connected, its room is deleted. If it is unreachable, a cached encrypted snapshot may remain accessible to someone with the old link until the room expires; it cannot control the disabled agent.

## Development and validation

```sh
npm run check  # TypeScript checks and Node tests; no model calls
```

Tests exercise Google JWT verification, OAuth state/PKCE/nonce/cookie binding, email restrictions, dashboard key authorization, login expiration/logout/socket revocation, explicit Pi trust opt-in, authenticated browser selection, Node/browser cryptography interoperability, bounded thinking/tool-input projection and browser rendering, transcript filtering, relay authentication/routing/reconnect/replay/revocation, extension prompt/interrupt/deduplication behavior against a real relay with mocked pi APIs, same-document pairing and key-import races, temporary capacity recovery, QR decoding (including the complete private fragment, terminal themes, and narrow-width fallback), and interactive setup (relay-issued token input, validation, private persistence, cancellation, and relay authentication), plus relay startup token generation, explicit overrides, and restart rotation. A real pi 1.1.0 SDK test verifies the setup UI and submission identity across delayed/transformed preflight and unrelated local turns using a synthetic stream (no model requests). Extension loading, setup, and QR pairing were also verified through the real pi 1.1.0 RPC CLI (including URL retries, private persistence, independently decoded QR payloads, relay authentication, and an empty transcript). A 390px-wide Chromium smoke check covered pairing, prompt submission, encrypted acknowledgement, layout, and disconnect. Single-scroll connected layout was also checked in Chrome with long conversations and live tool inputs at phone, landscape, and keyboard-sized viewports. A separate 390px Chrome smoke check with a synthetic OAuth provider covered the login gate, authenticated dashboard, QR-free selection, encrypted prompt/acknowledgement, sign-out, and the connected single-scroll layout; real Google sign-in requires deployment credentials.

### Protocol sketch

WebSocket `/ws`; first record is `{type:"join",role:"host"|"client",room,...}`. Hosts include the server token. Room IDs and encryption keys are independent random 256-bit values. Clients route using the room ID; neither join record includes the encryption key.

Hosts send `state` and `ack`; clients send `command`. Those records contain `{payload:{iv,data}}`, base64url AES-GCM envelopes, with authenticated additional data `pi-remote/v2/<direction>/<type>`. Snapshots have monotonic revisions and boolean `busy`/`submitting` fields. Commands have `id`, `action`, optional `text`, and `createdAt`; acknowledged IDs are retained locally for the pairing lifetime. Reconnecting clients receive the latest encrypted snapshot instead of unbounded event history. Relay presence messages are routing status, not authenticated agent output.

**Upgrade note:** Protocol v2 intentionally rejects v1 ciphertext; there is no insecure compatibility fallback. Restart the updated relay, update/restart the extension, reload the phone website, and create a new pairing with `/remote off` followed by `/remote`.
