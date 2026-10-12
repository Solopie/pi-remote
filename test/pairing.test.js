import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { Text } from '@earendil-works/pi-tui';
import jsQR from 'jsqr';
import { randomToken } from '../src/crypto.js';
import { pairingMessage, renderPairingQR } from '../src/pairing.js';

function pairingLink(origin = 'https://relay-host.example-tailnet.ts.net') {
  return `${origin}/#room=${randomToken()}&key=${randomToken()}`;
}

function qrLines(text) {
  return text.split('\n').filter(line => line.includes('\x1b[0;38;5;16;48;5;231m')).map(stripVTControlCharacters);
}

// Rasterize the terminal half-blocks, then decode with an independent QR reader.
// This verifies row order, polarity, padding, and the exact secret fragment.
function decode(lines) {
  const scale = 6, columns = lines[0].length;
  assert.ok(lines.every(line => line.length === columns));
  const width = columns * scale, height = lines.length * 2 * scale;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let row = 0; row < lines.length; row++) {
    for (let column = 0; column < columns; column++) {
      const cell = lines[row][column];
      for (let half = 0; half < 2; half++) {
        const dark = cell === '█' || cell === (half === 0 ? '▀' : '▄');
        if (!dark) continue;
        for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
          const offset = (((row * 2 + half) * scale + y) * width + column * scale + x) * 4;
          data[offset] = data[offset + 1] = data[offset + 2] = 0;
        }
      }
    }
  }
  return jsQR(data, width, height, { inversionAttempts: 'dontInvert' })?.data;
}

test('terminal QR decodes to the complete pairing URL, including room and encryption key', () => {
  for (const origin of ['https://relay.example', 'https://relay-host.example-tailnet.ts.net',
    'https://relay.example:8443', 'http://localhost:8787', 'http://[::1]:8787',
    `https://${'a'.repeat(63)}.${'b'.repeat(63)}.example`]) {
    const link = pairingLink(origin), qr = renderPairingQR(link), lines = qrLines(qr.text);
    assert.equal(decode(lines), link);
    assert.equal(qr.width, lines[0].length); assert.equal(qr.height, lines.length);
    assert.equal(qr.height, Math.ceil(qr.width / 2));
    assert.ok(qr.width % 2 === 1);
  }
});

test('QR has an explicit white four-module quiet zone and resets colors on every line', () => {
  const qr = renderPairingQR(pairingLink()), lines = qrLines(qr.text);
  assert.ok(lines.slice(0, 2).every(line => /^ +$/.test(line)));
  assert.ok(lines.slice(-2).every(line => /^ +$/.test(line)));
  assert.ok(lines.every(line => line.startsWith('    ') && line.endsWith('    ')));
  assert.ok(qr.text.split('\n').every(line => line.startsWith('\x1b[0;38;5;16;48;5;231m') && line.endsWith('\x1b[0m')));
});

test('pairing notification contains a scannable QR plus a copyable link and private-access warning', () => {
  const link = pairingLink(), message = pairingMessage(link, 80);
  assert.match(message, /grants control; keep private/); assert.match(message, /phone's camera/);
  assert.equal(decode(qrLines(message)), link); assert.equal(message.split('\n').at(-1), link);
  assert.equal(pairingMessage(link, 80), message);
  assert.equal(decode(qrLines(pairingMessage(link))), link);
});

test('QR survives Pi notification padding, ANSI themes, and minimum-width text rendering', () => {
  const link = pairingLink(), qr = renderPairingQR(link);
  for (const columns of [qr.width + 2, 80, 120]) {
    for (const color of ['\x1b[2m', '\x1b[38;2;180;180;180m', '\x1b[38;2;40;40;40m']) {
      const message = pairingMessage(link, columns);
      const rendered = new Text(`${color}${message}\x1b[0m`, 1, 0).render(columns);
      const lines = qrLines(rendered.join('\n'));
      assert.equal(lines.length, qr.height); assert.equal(decode(lines), link);
      assert.ok(rendered.every(line => stripVTControlCharacters(line).length <= columns));
    }
  }
});

test('narrow terminals use the text link rather than wrapping and corrupting the QR', () => {
  const link = pairingLink(), { width } = renderPairingQR(link);
  for (const columns of [1, 40, width + 1]) {
    const message = pairingMessage(link, columns);
    assert.match(message, new RegExp(`at least ${width + 2} columns`));
    assert.deepEqual(qrLines(message), []); assert.equal(message.split('\n').at(-1), link);
  }
  assert.equal(decode(qrLines(pairingMessage(link, width + 2))), link);
});

test('QR encoding failure falls back safely without hiding the link or leaking encoder errors', () => {
  const link = pairingLink(`https://${'a'.repeat(4000)}.example`);
  assert.throws(() => renderPairingQR(link));
  const message = pairingMessage(link, 80);
  assert.match(message, /QR code unavailable/); assert.deepEqual(qrLines(message), []);
  assert.equal(message.split('\n').at(-1), link);
  assert.equal(message.split(link)[0].includes('amount of data'), false);
});
