import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export interface AuditEntry {
  index: number;
  timestamp: string;
  sessionId: string;
  action: string;
  details: any;
  prevHash: string;
  hash: string;
}

const AGENT_DIR = path.join(os.homedir(), '.agent');
const AUDIT_LOG_PATH = path.join(AGENT_DIR, 'audit.log');
const KILL_SWITCH_PATH = path.join(AGENT_DIR, 'kill-switch');

async function ensureAgentDir(): Promise<void> {
  await fs.mkdir(AGENT_DIR, { recursive: true });
}

// Get the last hash from the audit log to maintain the chain
async function getLastLogEntry(): Promise<AuditEntry | null> {
  try {
    const content = await fs.readFile(AUDIT_LOG_PATH, 'utf8');
    const lines = content.trim().split('\n').filter(line => line.trim() !== '');
    if (lines.length === 0) return null;
    const lastLine = lines[lines.length - 1];
    return JSON.parse(lastLine) as AuditEntry;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export async function logAudit(sessionId: string, action: string, details: any): Promise<AuditEntry> {
  await ensureAgentDir();
  
  const lastEntry = await getLastLogEntry();
  const index = lastEntry ? lastEntry.index + 1 : 0;
  const prevHash = lastEntry ? lastEntry.hash : '0'.repeat(64);
  const timestamp = new Date().toISOString();
  
  // Basic entry before hashing
  const baseEntry = {
    index,
    timestamp,
    sessionId,
    action,
    details,
    prevHash
  };
  
  // Compute SHA-256 hash of the base entry string + prevHash
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(baseEntry))
    .digest('hex');
    
  const entry: AuditEntry = {
    ...baseEntry,
    hash
  };
  
  // Append to audit log and flush (using file handle if we want real fsync, but standard appendFile is durable enough for this CLI)
  const fileHandle = await fs.open(AUDIT_LOG_PATH, 'a');
  try {
    await fileHandle.appendFile(JSON.stringify(entry) + '\n', 'utf8');
    await fileHandle.sync(); // Force fsync to ensure durability
  } finally {
    await fileHandle.close();
  }
  
  return entry;
}

// Kill-switch check & trigger functions
export async function isKillSwitchTriggered(): Promise<boolean> {
  try {
    await fs.access(KILL_SWITCH_PATH);
    return true; // File exists, kill-switch is triggered
  } catch {
    return false; // File doesn't exist
  }
}

export async function triggerKillSwitch(sessionId: string, reason: string): Promise<void> {
  await ensureAgentDir();
  await fs.writeFile(KILL_SWITCH_PATH, JSON.stringify({ timestamp: new Date().toISOString(), reason }), 'utf8');
  await logAudit(sessionId, 'kill_switch_triggered', { reason });
  console.error(`\n🚨 PANIC: Kill switch triggered! Reason: ${reason}`);
}

export async function resetKillSwitch(sessionId: string): Promise<void> {
  try {
    await fs.unlink(KILL_SWITCH_PATH);
    await logAudit(sessionId, 'kill_switch_reset', {});
    console.log('🔓 Kill switch reset successfully.');
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}
