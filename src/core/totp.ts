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

// Constant-time string comparison to avoid leaking timing information about how
// many leading digits of the code matched. Both operands here are fixed-length
// 6-digit strings, so an equal-length compare is safe.
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

export interface TotpDetail {
  valid: boolean;
  // The time-step counter the code matched (only set when valid). Callers use this
  // to enforce single-use: a code that already succeeded for its counter must not
  // be accepted again within its ±1-step validity window.
  counter?: number;
}

/**
 * Verifies a TOTP code and, when valid, reports which time-step counter matched so
 * the caller can prevent replay. Comparison is constant-time.
 */
export function verifyTotpDetailed(token: string, secret: string): TotpDetail {
  try {
    const cleanToken = token.trim();
    if (!/^\d{6}$/.test(cleanToken)) {
      return { valid: false };
    }

    const epoch = Math.floor(Date.now() / 1000);
    const counter = Math.floor(epoch / 30);

    // Validate with clock drift (+/- 1 step)
    for (let i = -1; i <= 1; i++) {
      if (timingSafeEqualStr(generateHotp(secret, counter + i), cleanToken)) {
        return { valid: true, counter: counter + i };
      }
    }
    return { valid: false };
  } catch {
    return { valid: false };
  }
}

export function verifyTotp(token: string, secret: string): boolean {
  return verifyTotpDetailed(token, secret).valid;
}

/**
 * Generates the TOTP code for the current 30-second time-step. Used by the test
 * suite to exercise the guard, and available for tooling that needs to display the
 * current code.
 */
export function generateTotp(secret: string): string {
  const counter = Math.floor(Math.floor(Date.now() / 1000) / 30);
  return generateHotp(secret, counter);
}
