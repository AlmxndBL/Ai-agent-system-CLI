export interface TaintState {
  isTainted: boolean;
  reasons: string[];
}

// A simple in-memory tracker for session taints (or we can save it in the session object)
const sessionTaints = new Map<string, TaintState>();

export function getSessionTaint(sessionId: string): TaintState {
  if (!sessionTaints.has(sessionId)) {
    sessionTaints.set(sessionId, { isTainted: false, reasons: [] });
  }
  return sessionTaints.get(sessionId)!;
}

export function taintSession(sessionId: string, reason: string): void {
  const state = getSessionTaint(sessionId);
  state.isTainted = true;
  if (!state.reasons.includes(reason)) {
    state.reasons.push(reason);
  }
}

export function clearTaint(sessionId: string): void {
  sessionTaints.set(sessionId, { isTainted: false, reasons: [] });
}

/**
 * Scans a string (e.g., tool output, external content) for potential prompt injection patterns
 * and taints the session if anything suspicious is found.
 */
export function scanAndTaint(sessionId: string, source: string, content: string): boolean {
  if (!content) return false;
  
  const lowercase = content.toLowerCase();
  const suspiciousPatterns = [
    'ignore previous instructions',
    'ignore the instructions above',
    'system prompt',
    'override',
    'forget your instructions',
    'you are now',
    'new role',
    'prompt injection',
    'dan mode'
  ];
  
  for (const pattern of suspiciousPatterns) {
    if (lowercase.includes(pattern)) {
      taintSession(sessionId, `Suspicious pattern "${pattern}" detected in source: ${source}`);
      return true;
    }
  }
  
  return false;
}
