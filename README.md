# Pi Remote

Turn on `/remote` in an **existing pi session**, then control it from your phone. Your agent, tools, credentials, and repository stay on your computer. Both the computer and phone make outbound connections to a small relay.

**MVP:** a pi 1.1.0 extension, Node WebSocket relay, and mobile-first web client. This is not a native iOS/Android app yet.

```
pi session → outbound WSS → relay ← WSS ← phone browser
```

## Features

- `/remote` enables access; `/remote off` disables it and invalidates the active pairing on a connected relay.
- `/remote setup` prompts for the relay URL, generates a strong random token, and saves private local settings.
- Locally generated terminal QR code and copyable private pairing link, with an end-to-end AES-256-GCM key in the URL fragment (not sent in HTTP requests).
- Existing conversation, streamed assistant text, active tool names, expandable tool results.
- Send a prompt while idle; interrupt a running agent. Busy prompts are explicitly rejected, not silently queued.
- Reconnect and latest-state replay; command IDs prevent duplicate execution during retries. Outbound host buffering is capped at 2 MB, and silent relay connections are terminated after 45 seconds.
- No server-side repository access, model API keys, plaintext session storage, or command execution.
- Visible terminal status while remote access is enabled.

## Requirements

- Node.js 22.19+ and npm.
- Pi 1.1.0 (`@earendil-works/pi-coding-agent`); extension APIs are version-specific.
- HTTPS relay address reachable from both devices. HTTP is supported only for local development on localhost.

The examples below use `/path/to/pi-remote` as a placeholder for your local checkout. Replace it with the directory where you cloned this repository. Relay domains and tailnet names are examples too; use your own.

## 1. Run the relay

For **interactive configuration**, first load the extension and run `/remote setup` as described in [step 2](#2-load-the-extension-on-your-computer). The relay need not be running yet. Copy its printed `export PI_REMOTE_TOKEN=...` command into the relay's environment, then start the relay. **Do not generate a different token on the server.**

For **manual configuration**, on your server:

```sh
cd /path/to/pi-remote
npm ci

# Manual setup only: generate once and use the SAME token on the pi machine.
# With /remote setup, use its printed export command instead of this next line.
export PI_REMOTE_TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
npm start
```

The relay binds to `127.0.0.1:8787`. Environment variables are read from the process; `.env` is **not automatically loaded**. Node supports `node --env-file=.env src/server.js` if you prefer a file. See `.env.example`.

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

1. Run `/remote setup` and enter the **root relay URL**, such as the actual `https://relay-host.example-tailnet.ts.net` URL printed by `tailscale serve status`, or your Caddy domain. HTTPS is required except for localhost development. If a valid URL is already configured, Enter keeps it; Escape cancels without changing settings.
2. Setup generates a fresh **43-character passphrase with 256 bits of cryptographic randomness** for `PI_REMOTE_TOKEN`. Copy the printed `export PI_REMOTE_TOKEN='...'` command to the **relay machine**, or place that value in the relay's private environment file. Keep it secret.
3. Start/restart the relay with that token. Setup does **not** change the relay's configuration, manage Tailscale/Caddy, or enable remote access automatically.
4. Run `/remote` to enable access, then follow [step 3](#3-connect-your-phone) to pair your phone.

The URL and token are saved to `~/.pi/agent/pi-remote.json` (or the directory selected by `PI_CODING_AGENT_DIR`). The file is written atomically with mode `0600` on Unix, and `/remote` loads it automatically. Setup also applies the values to the current pi process, so no pi restart is needed; your parent shell is unchanged. This is a dedicated extension file, not a modification to pi's main settings or session transcript. Pairing encryption keys are separate and are never stored there.

Explicit `PI_REMOTE_URL` and `PI_REMOTE_TOKEN` environment variables take precedence over saved settings on later launches. Update or unset old overrides **in the shell that launches pi**, not the relay's environment. To override a saved URL with a different relay, supply its token too; saved tokens are not sent to another relay.

Run `/remote off` before re-running setup. Replacing existing settings requires confirmation and generates a **new token**: update the relay and any other pi hosts that share it. `/remote off`, session changes, or shutdown cancel a pending setup dialog. Setup requires an interactive UI; non-interactive clients can use the environment variables below instead.

### Manual configuration (optional)

Before starting pi, set both variables instead of using the setup wizard:

```sh
# Replace with the root HTTPS URL from your chosen setup above.
# Tailscale Serve: the actual .ts.net URL printed by `tailscale serve status`.
# Caddy: your configured domain, e.g. https://pi.example.com.
export PI_REMOTE_URL=https://relay-host.example-tailnet.ts.net
export PI_REMOTE_TOKEN='the-same-server-token'
pi -e /path/to/pi-remote/extension/remote.ts
```

The relay and extension must use the same token, whether it was generated by setup or manually.

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
- Latest snapshots contain up to **40 messages**, with **4,000 characters per message**. Snapshots also have a 600 KB UTF-8 JSON budget; older messages are omitted when necessary to stay below the encrypted transport limit. Session names and IDs are capped at 256 characters, and active tool names at 100 entries of 128 characters each. Snapshot failures are contained and shown in the terminal status instead of crashing pi. Thinking, images, raw tool arguments, and custom messages are omitted. Public tool output can still contain sensitive information.
- There is no durable relay database. Disconnected rooms expire after approximately five minutes. A restarted relay is repopulated by reconnecting pi hosts; if a phone reconnects first, reopen its link once pi is connected. Stale host connections and temporary room/client capacity limits cause retryable `1013` closes, not revocation; hosts and phones retain their pairing and retry as capacity becomes available. Invalid authentication still produces a terminal `1008` rejection.
- Commands expire after two minutes and are deduplicated for the active pairing. After 10,000 commands, start a fresh pairing. A successful prompt acknowledgement is sent when that submission's own agent turn starts, not when the task completes. Its asynchronous invocation context is tracked, so unrelated local turns cannot acknowledge it. Pi’s fire-and-forget submission API does not expose asynchronous preflight errors or cancellation. While submission is pending, the phone disables **Stop agent** and the host explicitly rejects interrupt requests; an idle abort cannot cancel preflight. If no correlated turn starts within 15 seconds, the phone receives an unknown-outcome warning. The submission identity and lock remain until that submission's turn starts or remote access is disabled, preventing an unrelated or late start from acknowledging a newer prompt. Check pi before restarting `/remote` or resending: a delayed submission may still execute. Retries of the same command ID never submit it again.
- No follow-up/steering queue, file browser, dedicated diff viewer, multi-session account dashboard, push notifications, or voice input yet.
- Starting/switching/forking a pi session disables remote access; enable it again in the new session. Branch navigation rebuilds the transcript.
- Remote input does not expand slash commands or prompt templates. It goes through pi's normal user-message API.

## Security model

**A pairing link or its QR code grants agent control, which can amount to shell access. Treat both like passwords.** Do not share them in screenshots, tickets, or public messages.

The setup file contains a plaintext relay token protected by user-only file permissions. Keep it, the generated-token notification, and any relay environment file private; do not commit them to a repository or embed secrets in Nix configuration that puts them in the world-readable `/nix/store`. Setup uses terminal UI only: it does not add credentials to model messages, the session transcript, or phone snapshots.

The relay routes encrypted snapshots, acknowledgements, and commands. It can see room identifiers, connection timing, and ciphertext sizes, but does not receive the encryption key. Host and client packets use different authenticated encryption contexts to prevent reflection. Protocol v2 also authenticates each packet type (`state`, `ack`, or `command`), preventing relabelling attacks. The client validates snapshot/acknowledgement schemas before changing its revision or UI, and uses text rendering, not unsafe HTML.

However, this is an MVP, not a security-audited product. The web client is delivered by the relay: a compromised relay could serve malicious JavaScript that steals a pairing key. Use a server you trust. A future signed native client would strengthen this boundary. Local extensions can also observe user input through normal pi hooks.

The relay enforces payload, connection, room, client, and per-connection message limits, same-origin browser connections, and heartbeat checks. Upgrade admission also limits unauthenticated connections to 32 globally and 8 per TCP peer, with at most 60 upgrades per minute per peer and a bounded 1,000-peer tracking table. Unauthenticated connections are terminated after five seconds. For the Caddy option, configure `PI_REMOTE_TRUSTED_PROXIES` and the overwriting `X-Real-IP` header as shown above to isolate client quotas. For Tailscale Serve, leave `PI_REMOTE_TRUSTED_PROXIES` unset or empty; peer quotas remain shared by its users. Forwarded headers from untrusted TCP peers are ignored, including `X-Forwarded-For`. Configure client-IP connection and upgrade-rate limits at the proxy where supported. These are basic safeguards, not a complete internet-facing abuse defense. Keep the relay behind a VPN initially; TLS remains required for the phone UI.

`/remote off` immediately stops the extension accepting commands. If the relay is connected, its room is deleted. If it is unreachable, a cached encrypted snapshot may remain accessible to someone with the old link until the room expires; it cannot control the disabled agent.

## Development and validation

```sh
npm run check  # TypeScript checks and Node tests; no model calls
```

Tests exercise Node/browser cryptography interoperability, transcript filtering, relay authentication/routing/reconnect/replay/revocation, extension prompt/interrupt/deduplication behavior against a real relay with mocked pi APIs, same-document pairing and key-import races, temporary capacity recovery, QR decoding (including the complete private fragment, terminal themes, and narrow-width fallback), and interactive setup (validation, token generation, private persistence, cancellation, and relay authentication). A real pi 1.1.0 SDK test verifies the setup UI and submission identity across delayed/transformed preflight and unrelated local turns using a synthetic stream (no model requests). Extension loading, setup, and QR pairing were also verified through the real pi 1.1.0 RPC CLI (including URL retries, private persistence, independently decoded QR payloads, relay authentication, and an empty transcript). A 390px-wide Chromium smoke check covered pairing, prompt submission, encrypted acknowledgement, layout, and disconnect.

### Protocol sketch

WebSocket `/ws`; first record is `{type:"join",role:"host"|"client",room,...}`. Hosts include the server token. Room IDs and encryption keys are independent random 256-bit values. Clients route using the room ID; neither join record includes the encryption key.

Hosts send `state` and `ack`; clients send `command`. Those records contain `{payload:{iv,data}}`, base64url AES-GCM envelopes, with authenticated additional data `pi-remote/v2/<direction>/<type>`. Snapshots have monotonic revisions and boolean `busy`/`submitting` fields. Commands have `id`, `action`, optional `text`, and `createdAt`; acknowledged IDs are retained locally for the pairing lifetime. Reconnecting clients receive the latest encrypted snapshot instead of unbounded event history. Relay presence messages are routing status, not authenticated agent output.

**Upgrade note:** Protocol v2 intentionally rejects v1 ciphertext; there is no insecure compatibility fallback. Restart the updated relay, update/restart the extension, reload the phone website, and create a new pairing with `/remote off` followed by `/remote`.
