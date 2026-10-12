import QRCode from 'qrcode';

const QUIET_ZONE = 4;
// Fixed 256-color black/white avoid customized basic ANSI palette colors.
const BLACK_ON_WHITE = '\x1b[0;38;5;16;48;5;231m';
const RESET = '\x1b[0m';

/** @param {string} link */
export function renderPairingQR(link) {
  // Encode the complete URL, including the private fragment, entirely locally.
  // Half-blocks pack two module rows per terminal row; preserve a four-module
  // white quiet zone and explicit colors regardless of the terminal/UI theme.
  const { modules } = QRCode.create(link, { errorCorrectionLevel: 'L' });
  const width = modules.size + 2 * QUIET_ZONE;
  const dark = (x, y) => x >= QUIET_ZONE && y >= QUIET_ZONE && x < width - QUIET_ZONE && y < width - QUIET_ZONE
    && modules.data[(y - QUIET_ZONE) * modules.size + x - QUIET_ZONE] !== 0;
  const lines = [];
  for (let y = 0; y < width; y += 2) {
    let line = BLACK_ON_WHITE;
    for (let x = 0; x < width; x++) {
      line += dark(x, y) ? (dark(x, y + 1) ? '█' : '▀') : (dark(x, y + 1) ? '▄' : ' ');
    }
    lines.push(line + RESET);
  }
  return { text: lines.join('\n'), width, height: lines.length };
}

/** @param {string} link @param {number} [columns] */
export function pairingMessage(link, columns) {
  let display;
  try {
    const qr = renderPairingQR(link);
    // Pi notifications add one column of padding on either side. Never wrap
    // the QR into an unscannable image when the terminal is too narrow.
    display = columns && columns < qr.width + 2
      ? `Widen the terminal to at least ${qr.width + 2} columns and run /remote again for a QR code.\n`
      : `Scan with your phone's camera (keep the entire QR visible):\n${qr.text}\n`;
  } catch {
    // Encoding limits must not prevent pairing; never echo QR encoder errors.
    display = 'QR code unavailable. Use the private link below instead.\n';
  }
  return `Phone pairing (grants control; keep private):\n${display}\nPrivate pairing link:\n${link}`;
}
