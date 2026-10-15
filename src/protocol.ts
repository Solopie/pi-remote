export const MAX_PROMPT = 16000;
export function validCommand(command: any) {
  return command && typeof command.id === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(command.id)
    && (command.action === 'interrupt'
      || (command.action === 'rename' && typeof command.text === 'string' && command.text.trim().length > 0
        && command.text.length <= 256 && !/[\x00-\x1f\x7f]/.test(command.text)) || (['prompt', 'steer', 'followUp'].includes(command.action) && typeof command.text === 'string'
      && command.text.trim().length > 0 && command.text.length <= MAX_PROMPT));
}
// Only expose bounded, displayable text and tool inputs. Provider signatures,
// redacted thinking payloads, images, and arbitrary message metadata stay local.
export function toolCallDetails(name: any, args: any) {
  const tool = typeof name === 'string' ? name.slice(0, 128) : 'Tool';
  let input = '';
  try {
    if (tool === 'bash' && typeof args?.command === 'string') input = args.command.slice(0, 4000);
    else if (args !== undefined) {
      let budget = 4000;
      const seen = new WeakSet();
      const bounded = (value: any, depth = 0): any => {
        if (budget-- <= 0 || depth > 4) return '…';
        if (typeof value === 'string') { const text = value.slice(0, Math.max(0, budget)); budget -= text.length; return text; }
        if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
        if (typeof value !== 'object') return '[Unsupported value]';
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
        if (Array.isArray(value)) return value.slice(0, 30).map(item => bounded(item, depth + 1));
        const result = Object.create(null);
        for (const key of Object.keys(value).slice(0, 30)) {
          if (budget <= 0) break;
          const label = key.slice(0, 128); budget -= label.length;
          result[label] = bounded(value[key], depth + 1);
        }
        return result;
      };
      input = JSON.stringify(bounded(args), null, 2).slice(0, 4000);
    }
  } catch { input = '[Tool input unavailable]'; }
  return { name: tool, input };
}

export function publicMessage(message: any) {
  const role = message?.role;
  if (!['user', 'assistant', 'toolResult'].includes(role)) return null;
  let text = typeof message.content === 'string' ? message.content.slice(0, 4000) : '';
  let thinking = '';
  const toolCalls: { name: string; input: string; id?: string }[] = [];
  if (Array.isArray(message.content)) for (const part of message.content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') text = (text + (text ? '\n' : '') + part.text.slice(0, 4000)).slice(0, 4000);
    if (role === 'assistant' && part.type === 'thinking' && !part.redacted && typeof part.thinking === 'string') {
      thinking = (thinking + (thinking ? '\n' : '') + part.thinking.slice(0, 4000)).slice(0, 4000);
    }
    if (role === 'assistant' && part.type === 'toolCall' && toolCalls.length < 20) {
      const call = { ...toolCallDetails(part.name, part.arguments),
        ...(typeof part.id === 'string' ? { id: part.id.slice(0, 128) } : {}) };
      toolCalls.push(call);
      text = (text + (text ? '\n' : '') + `[Tool: ${call.name}]`).slice(0, 4000);
    }
  }
  const stopReason = role === 'assistant' && ['error', 'aborted'].includes(message.stopReason) ? message.stopReason : undefined;
  const errorMessage = stopReason
    ? (typeof message.errorMessage === 'string' && message.errorMessage.trim()
      ? message.errorMessage.slice(0, 4000)
      : stopReason === 'aborted' ? 'Response interrupted.' : 'The model provider returned an error without a message.')
    : undefined;
  if (!text && !thinking && !toolCalls.length && !errorMessage) return null;
  return { role, text, timestamp: typeof message.timestamp === 'number' && Number.isFinite(message.timestamp) ? message.timestamp : undefined,
    tool: typeof message.toolName === 'string' ? message.toolName.slice(0, 128) : undefined,
    ...(errorMessage ? { errorMessage, stopReason } : {}),
    ...(thinking ? { thinking } : {}), ...(toolCalls.length ? { toolCalls } : {}) };
}

// Budget the UTF-8 JSON before encryption. AES-GCM adds 16 bytes and base64
// expands it by 4/3; 600KB leaves ample room below the 1MB transport limit.
export const MAX_SNAPSHOT_BYTES = 600_000;
export function boundSnapshot(value: any) {
  const state = { ...value, messages: [...value.messages] };
  while (Buffer.byteLength(JSON.stringify(state)) > MAX_SNAPSHOT_BYTES && state.messages.length) {
    state.messages.shift();
  }
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot metadata exceeds byte limit');
  return state;
}
