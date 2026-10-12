export const MAX_PROMPT = 16000;
export function validCommand(command) {
  return command && typeof command.id === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(command.id)
    && (command.action === 'interrupt' || (command.action === 'prompt' && typeof command.text === 'string'
      && command.text.trim().length > 0 && command.text.length <= MAX_PROMPT));
}
// Never send thinking, images, raw tool arguments, or arbitrary message metadata.
export function publicMessage(message) {
  const role = message?.role;
  if (!['user', 'assistant', 'toolResult'].includes(role)) return null;
  const content = message.content;
  const text = typeof content === 'string' ? content : (Array.isArray(content) ? content.map(part => {
    if (part.type === 'text') return part.text;
    if (part.type === 'toolCall') return `[Tool: ${part.name}]`;
    return '';
  }).filter(Boolean).join('\n') : '');
  if (!text) return null;
  return { role, text: text.slice(0, 4000), timestamp: message.timestamp, tool: message.toolName };
}

// Budget the UTF-8 JSON before encryption. AES-GCM adds 16 bytes and base64
// expands it by 4/3; 600KB leaves ample room below the 1MB transport limit.
export const MAX_SNAPSHOT_BYTES = 600_000;
export function boundSnapshot(value) {
  const state = { ...value, messages: [...value.messages] };
  while (Buffer.byteLength(JSON.stringify(state)) > MAX_SNAPSHOT_BYTES && state.messages.length) {
    state.messages.shift();
  }
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot metadata exceeds byte limit');
  return state;
}
