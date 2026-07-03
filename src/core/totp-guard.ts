import { verifyTotpDetailed } from './totp';

/**
 * TOTP hardening layer (§9.3 / threat T2 — Telegram/Discord account breach).
 *
 * The raw verifyTotp() only checks that a 6-digit code is currently valid. That
 * leaves two gaps against an attacker who has seized the messaging account:
 *   1. Replay — a valid code stays valid for its ±1 time-step window (~90s), so a
 *      code observed/typed once can be resent to approve a second action.
 *   2. Brute force — with no attempt limit, codes can be guessed at line speed.
 *
 * This guard closes both: a code is single-use per time-step counter (replay), and
 * repeated failures for a scope trigger an escalating lockout (brute force). State
 * is in-process (like taint/session locks); it resets on restart, which is
 * acceptable because a restart also drops all pending approvals.
 */

// After this many consecutive invalid codes for a scope, lock that scope out.
const MAX_FAILURES = 5;
// Base lockout once the failure threshold is hit; doubles on each subsequent lock.
const BASE_LOCKOUT_MS = 60_000; // 1 minute
const MAX_LOCKOUT_MS = 15 * 60_000; // cap at 15 minutes

interface AttemptState {
  failures: number;
  lockedUntil: number;
  lockouts: number; // how many times this scope has been locked (for backoff)
}

// Per-scope (per chat/channel) failure + lockout tracking.
const attempts = new Map<string, AttemptState>();
// Globally consumed time-step counters — a TOTP code is single-use across the whole
// system within its window, so this is intentionally NOT keyed by scope.
const usedCounters = new Set<number>();

export type TotpFailureReason = 'locked' | 'replay' | 'invalid';

export interface GuardedTotpResult {
  ok: boolean;
  reason?: TotpFailureReason;
  retryAfterMs?: number;
}

function getState(scope: string): AttemptState {
  let st = attempts.get(scope);
  if (!st) {
    st = { failures: 0, lockedUntil: 0, lockouts: 0 };
    attempts.set(scope, st);
  }
  return st;
}

// Drop counters older than the drift window so the replay set can't grow forever.
function pruneUsedCounters(now: number): void {
  const currentCounter = Math.floor(now / 1000 / 30);
  for (const c of usedCounters) {
    if (c < currentCounter - 1) {
      usedCounters.delete(c);
    }
  }
}

/**
 * Verify a TOTP code for a scope with replay + brute-force protection.
 * `scope` should identify the approving channel (e.g. `telegram-<chatId>`).
 */
export function verifyTotpGuarded(
  scope: string,
  token: string,
  secret: string,
  now: number = Date.now()
): GuardedTotpResult {
  const st = getState(scope);

  if (st.lockedUntil > now) {
    return { ok: false, reason: 'locked', retryAfterMs: st.lockedUntil - now };
  }

  const detail = verifyTotpDetailed(token, secret);

  if (!detail.valid) {
    st.failures += 1;
    if (st.failures >= MAX_FAILURES) {
      const lockMs = Math.min(BASE_LOCKOUT_MS * Math.pow(2, st.lockouts), MAX_LOCKOUT_MS);
      st.lockedUntil = now + lockMs;
      st.lockouts += 1;
      st.failures = 0;
      return { ok: false, reason: 'locked', retryAfterMs: lockMs };
    }
    return { ok: false, reason: 'invalid' };
  }

  // Valid code — enforce single-use per time-step (replay defense).
  if (detail.counter !== undefined && usedCounters.has(detail.counter)) {
    return { ok: false, reason: 'replay' };
  }
  if (detail.counter !== undefined) {
    usedCounters.add(detail.counter);
  }

  // Success resets the failure/lockout state for this scope.
  st.failures = 0;
  st.lockedUntil = 0;
  st.lockouts = 0;
  pruneUsedCounters(now);
  return { ok: true };
}

// Test hook: clears all in-memory guard state.
export function _resetTotpGuard(): void {
  attempts.clear();
  usedCounters.clear();
}
