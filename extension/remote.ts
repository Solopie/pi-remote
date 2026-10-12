import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import WebSocket from 'ws';
import { randomToken, seal, open } from '../src/crypto.js';
import { publicMessage, validCommand, boundSnapshot } from '../src/protocol.js';
import { normalizeRelayURL, readConfig, saveConfig, resolveConfig } from '../src/config.js';
import { pairingMessage } from '../src/pairing.js';

type Message = NonNullable<ReturnType<typeof publicMessage>>;
type Submission = { id: string; timer: ReturnType<typeof setTimeout>; timedOut: boolean };
const MAX_BUFFERED_BYTES = 2_000_000;
const FRAME_OVERHEAD = 14; // Maximum masked WebSocket frame header.
const RELAY_TIMEOUT = 45000; // The relay pings every 15 seconds.

export default function remoteExtension(pi: ExtensionAPI) {
  let ctx: ExtensionContext;
  let enabled = false, socket: WebSocket | undefined, reconnect: ReturnType<typeof setTimeout> | undefined;
  let flush: ReturnType<typeof setTimeout> | undefined, retry = 0, room = '', key = '', link = '', relay = '', hostToken = '';
  let operation: AbortController | undefined;
  let messages: Message[] = [], activeTools = new Map<string, string>();
  let revision = 0, submitting = false, streamingIndex = -1;
  let submission: Submission | undefined;
  const submissionContext = new AsyncLocalStorage<Submission>();
  const commands = new Map<string, { id: string; ok: boolean; error?: string }>();

  function status(text?: string) { ctx?.ui.setStatus('remote', text); }
  function transmit(type: 'state' | 'ack', value: unknown) {
    const ws = socket;
    if (ws?.readyState !== WebSocket.OPEN) return;
    const packet = JSON.stringify({ type, payload: seal(key, type === 'state' ? boundSnapshot(value) : value, 'host', type) });
    if (ws.bufferedAmount + Buffer.byteLength(packet) + FRAME_OVERHEAD > MAX_BUFFERED_BYTES) {
      // Never queue unbounded snapshots in the local agent. Rejoining publishes
      // current state; acknowledgements can be recovered by command-ID retries.
      status('Remote connection stalled · reconnecting…');
      ws.terminate(); return;
    }
    ws.send(packet);
  }
  function publish() {
    if (!enabled || flush) return;
    flush = setTimeout(() => {
      flush = undefined;
      try {
        transmit('state', { revision: ++revision, session: ctx.sessionManager.getSessionId().slice(0, 256),
          name: (pi.getSessionName() || ctx.cwd.split('/').pop() || 'Pi session').slice(0, 256),
          busy: !!submission || submitting || !ctx.isIdle(), submitting: !!submission, tools: [...activeTools.values()].slice(0, 100).map(name => name.slice(0, 128)), messages });
      } catch {
        // Timer callbacks must never let snapshot/transport failures crash pi.
        status('Remote snapshot failed · /remote off to revoke');
      }
    }, 150);
  }
  function cancelOperation() { operation?.abort(); operation = undefined; }
  function stop() {
    cancelOperation();
    enabled = false;
    clearTimeout(reconnect); clearTimeout(flush); flush = undefined;
    try {
      const leave = JSON.stringify({ type: 'leave' });
      if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount + Buffer.byteLength(leave) + FRAME_OVERHEAD <= MAX_BUFFERED_BYTES) {
        socket.send(leave); socket.close();
      } else socket?.terminate();
    } catch { socket?.terminate(); }
    socket = undefined;
    clearTimeout(submission?.timer); submission = undefined; submitting = false;
    submissionContext.disable();
    commands.clear(); key = ''; room = ''; link = ''; hostToken = ''; status();
  }
  function connect() {
    if (!enabled) return;
    const ws = new WebSocket(relay, { maxPayload: 1_000_000, handshakeTimeout: 10000 });
    socket = ws;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const alive = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => ws.terminate(), RELAY_TIMEOUT);
    };
    ws.on('ping', alive);
    ws.on('open', () => {
      if (!enabled || socket !== ws) { ws.terminate(); return; }
      alive();
      ws.send(JSON.stringify({ type: 'join', role: 'host', room, token: hostToken }));
    });
    ws.on('message', raw => {
      if (!enabled || socket !== ws) return;
      try {
        const packet = JSON.parse(raw.toString());
        if (packet.type === 'joined') {
          retry = 0; status('Remote ON · /remote off to revoke'); publish(); return;
        }
        if (packet.type !== 'command') return;
        const command = open(key, packet.payload, 'client', 'command');
        if (!validCommand(command)) return;
        const prior = commands.get(command.id);
        if (prior) { if (submission?.id !== command.id || submission?.timedOut) transmit('ack', prior); return; }
        const result = { id: command.id, ok: false, error: undefined as string | undefined };
        // Bounded, non-evicting deduplication. Start a new pairing after this limit.
        if (commands.size >= 10000) result.error = 'Command limit reached. Restart /remote.';
        else {
          commands.set(command.id, result);
          if (!Number.isFinite(command.createdAt) || Math.abs(Date.now() - command.createdAt) > 120000) {
            result.error = 'Command expired. Check device clocks and resend.';
          } else try {
            if (command.action === 'interrupt') {
              // Pi cannot cancel asynchronous preflight through its void API.
              // Do not claim success when an idle/pending turn can still start.
              if (submission) result.error = 'Message submission is still pending and cannot be cancelled. Wait for the agent to start, then interrupt.';
              else if (ctx.isIdle()) result.error = 'No agent is running. A previously unconfirmed submission may still start; interrupt once it is running.';
              else { ctx.abort(); result.ok = true; }
            }
            else if (submission || submitting || !ctx.isIdle() || ctx.hasPendingMessages()) result.error = 'Agent is busy. Wait or interrupt first.';
            else {
              submitting = true;
              // Pi's void API swallows asynchronous preflight failures. Only acknowledge
              // acceptance once a turn starts; otherwise report an unknown outcome.
              submission = { id: command.id, timedOut: false, timer: setTimeout(() => {
                // A timeout cannot cancel preflight. Retain the lock/identity so
                // a late start cannot be mistaken for a later remote prompt.
                if (!submission || submission.id !== command.id) return;
                submission.timedOut = true;
                result.error = 'Submission was not confirmed. Its outcome is unknown; check pi before restarting /remote or resending.';
                try { transmit('ack', result); publish(); }
                catch { status('Remote acknowledgement failed · /remote off to revoke'); }
              }, 15000) };
              // Pi 1.1.0 awaits preflight and emits agent_start in this call's async
              // context. Tag the invocation, not its text: input hooks may transform
              // the prompt, and a local turn (even with identical text) is unrelated.
              submissionContext.run(submission, () => pi.sendUserMessage(command.text, { expandPromptTemplates: false }));
              publish(); return;
            }
          } catch (error) {
            if (submission && submission.id === command.id) {
              clearTimeout(submission.timer); submission = undefined; submitting = false;
            }
            result.error = error instanceof Error ? error.message : 'Command failed';
          }
        }
        if (submission?.id !== command.id) transmit('ack', result);
        publish();
      } catch { /* Ignore unauthenticated or malformed encrypted packets. */ }
    });
    ws.on('error', () => { if (enabled && socket === ws) status('Remote reconnecting… · /remote off'); });
    ws.on('close', code => {
      clearTimeout(watchdog);
      if (!enabled || socket !== ws) return;
      if (code === 1008) {
        stop(); ctx.ui.notify('Relay rejected the connection. Check PI_REMOTE_TOKEN and restart /remote.', 'error'); return;
      }
      status('Remote reconnecting… · /remote off');
      reconnect = setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
    });
  }
  async function setup(context: ExtensionContext, file: string, signal: AbortSignal) {
    let saved: Awaited<ReturnType<typeof readConfig>>, unreadable = false;
    try { saved = await readConfig(file); }
    catch { unreadable = true; }
    if (signal.aborted) return;
    if (unreadable) context.ui.notify('Existing remote settings could not be read. Setup can replace them after confirmation.', 'warning');
    let suggested: string | undefined;
    try {
      const previous = process.env.PI_REMOTE_URL || saved?.url;
      if (previous) suggested = normalizeRelayURL(previous);
    } catch { /* Do not show an invalid URL that might contain credentials. */ }
    let base: string;
    while (true) {
      const input = await context.ui.input('Remote relay URL (HTTPS root URL; Enter keeps an existing URL)',
        suggested || 'https://relay-host.your-tailnet.ts.net', { signal });
      if (signal.aborted) return;
      if (input === undefined) { context.ui.notify('Remote setup cancelled. Settings unchanged.', 'info'); return; }
      try { base = normalizeRelayURL(input.trim() || suggested || ''); break; }
      catch (error) { context.ui.notify(error instanceof Error ? error.message : 'Invalid relay URL.', 'error'); }
    }
    if (saved || unreadable || process.env.PI_REMOTE_TOKEN) {
      const approved = await context.ui.confirm('Replace remote settings?',
        'A new relay token will be generated. Update PI_REMOTE_TOKEN on the relay and restart it; other pi hosts using that relay must also use the new token. Replace these settings?', { signal });
      if (signal.aborted) return;
      if (!approved) { context.ui.notify('Remote setup cancelled. Settings unchanged.', 'info'); return; }
    }
    const token = randomToken(); // 256 bits of cryptographic randomness, independent of pairing keys.
    await saveConfig(file, { url: base, token }, signal);
    if (signal.aborted) return;
    // Apply to this pi process immediately, including /reload. The parent shell
    // is unchanged; explicit environment variables override saved settings on restart.
    process.env.PI_REMOTE_URL = base; process.env.PI_REMOTE_TOKEN = token;
    context.ui.notify(`Remote setup saved to ${file} (private, mode 0600).\nRelay URL: ${base}\n\nGenerated passphrase — keep private. Set this on the relay:\nexport PI_REMOTE_TOKEN='${token}'\n\nStart/restart the relay with that token, then run /remote to enable access. Setup does not enable access or reconfigure the relay.\nFor future pi launches, update or unset old PI_REMOTE_URL/PI_REMOTE_TOKEN shell overrides to use the saved settings.`, 'info');
  }
  pi.registerCommand('remote', {
    description: 'Configure with /remote setup; /remote enables phone access; /remote off revokes it',
    getArgumentCompletions: prefix => ['setup', 'on', 'off'].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, context) => {
      ctx = context;
      const action = args.trim();
      if (action === 'off') { stop(); context.ui.notify('Remote access disabled.', 'info'); return; }
      if (!['', 'on', 'setup'].includes(action)) { context.ui.notify('Usage: /remote [setup|on|off]', 'warning'); return; }
      if (action === 'setup' && enabled) { context.ui.notify('Run /remote off before setup so active access is not reconfigured.', 'warning'); return; }
      if (enabled) { context.ui.notify(pairingMessage(link, process.stdout?.columns), 'info'); return; }
      if (operation) { context.ui.notify('Remote configuration is in progress. Finish it or run /remote off to cancel.', 'warning'); return; }
      if (action === 'setup' && !context.hasUI) { context.ui.notify('/remote setup requires an interactive UI. Set PI_REMOTE_URL and PI_REMOTE_TOKEN instead.', 'error'); return; }
      const controller = new AbortController(); operation = controller;
      try {
        const file = join(getAgentDir(), 'pi-remote.json');
        if (action === 'setup') { await setup(context, file, controller.signal); return; }
        const config = await resolveConfig(file, process.env);
        if (controller.signal.aborted) return;
        const token = config.token;
        if (!token || token.length < 32) { context.ui.notify('Run /remote setup, or set PI_REMOTE_TOKEN (at least 32 characters) before starting pi.', 'error'); return; }
        const url = new URL(config.url);
        room = randomToken(); key = randomToken(); hostToken = token;
        link = `${url.origin}/#room=${room}&key=${key}`;
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.pathname = '/ws'; relay = url.href;
        messages = context.sessionManager.getBranch().filter(entry => entry.type === 'message')
          .map(entry => publicMessage((entry as { message: unknown }).message)).filter((m): m is Message => !!m).slice(-40);
        activeTools.clear(); commands.clear(); revision = 0; retry = 0; submitting = false; streamingIndex = -1;
        enabled = true; status('Remote connecting… · /remote off'); connect();
        context.ui.notify(pairingMessage(link, process.stdout?.columns), 'info');
      } catch (error) {
        if (!controller.signal.aborted) context.ui.notify(`Remote ${action === 'setup' ? 'setup' : 'configuration'} failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
      } finally { if (operation === controller) operation = undefined; }
    },
  });
  pi.on('session_start', (_event, context) => { cancelOperation(); if (enabled) stop(); ctx = context; });
  pi.on('session_shutdown', () => stop());
  pi.on('agent_start', (_event, context) => {
    ctx = context;
    if (submission && submissionContext.getStore() === submission) {
      clearTimeout(submission.timer);
      const result = commands.get(submission.id)!;
      submission = undefined; result.ok = true; result.error = undefined;
      transmit('ack', result);
    }
    publish();
  });
  pi.on('agent_end', (_event, context) => { ctx = context; submitting = false; activeTools.clear(); publish(); });
  pi.on('agent_settled', (_event, context) => { ctx = context; submitting = false; publish(); });
  pi.on('message_start', (event, context) => {
    ctx = context; if (!enabled) return;
    const message = publicMessage(event.message);
    streamingIndex = -1;
    if (message) { messages.push(message); messages = messages.slice(-40); streamingIndex = messages.length - 1; }
    publish();
  });
  const updateMessage = (message: unknown) => {
    if (!enabled) return;
    const value = publicMessage(message);
    if (value) {
      if (streamingIndex < 0) { messages.push(value); messages = messages.slice(-40); streamingIndex = messages.length - 1; }
      else messages[streamingIndex] = value;
    }
    publish();
  };
  pi.on('message_update', event => updateMessage(event.message));
  pi.on('message_end', event => { updateMessage(event.message); streamingIndex = -1; });
  pi.on('tool_execution_start', event => { activeTools.set(event.toolCallId, event.toolName); publish(); });
  pi.on('tool_execution_end', event => { activeTools.delete(event.toolCallId); publish(); });
  // Branch navigation changes the transcript; rebuild from the authoritative session.
  pi.on('session_tree', (_event, context) => {
    ctx = context;
    messages = ctx.sessionManager.getBranch().filter(e => e.type === 'message').map(e => publicMessage((e as { message: unknown }).message))
      .filter((m): m is Message => !!m).slice(-40);
    streamingIndex = -1; publish();
  });
}
