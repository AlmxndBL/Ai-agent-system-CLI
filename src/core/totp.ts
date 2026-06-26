import * as crypto from 'crypto';

function base32Decode(base32: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  // Remove padding and enforce uppercase
  const cleaned = base32.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const buffer: number[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const idx = alphabet.indexOf(cleaned[i]);
    if (idx === -1) {
      throw new Error(`Invalid base32 character: ${cleaned[i]}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      buffer.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(buffer);
}

function generateHotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  // Write counter as 64-bit integer
  buffer.writeUInt32BE(0, 0);
  buffer.writeUInt32BE(counter, 4);

  const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = code % 1000000;
  return otp.toString().padStart(6, '0');
}

export function verifyTotp(token: string, secret: string): boolean {
  try {
    const cleanToken = token.trim();
    if (!/^\d{6}$/.test(cleanToken)) {
      return false;
    }

    const epoch = Math.floor(Date.now() / 1000);
    const counter = Math.floor(epoch / 30);

    // Validate with clock drift (+/- 1 step)
    for (let i = -1; i <= 1; i++) {
      if (generateHotp(secret, counter + i) === cleanToken) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
