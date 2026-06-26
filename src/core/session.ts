import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ModelMessage } from 'ai';
import { AsyncLocalStorage } from 'async_hooks';

export const sessionLocalStorage = new AsyncLocalStorage<{ sessionId: string; discordChannelId?: string; telegramChatId?: number }>();

export interface Session {
  id: string;
  cwd: string;
  createdAt: string;
  messages: ModelMessage[];
}

const DEFAULT_SESSION_DIR = path.join(os.homedir(), '.agent', 'sessions');

export function getSessionDir(): string {
  if (process.env.SESSION_STORAGE_PATH) {
    return path.resolve(process.env.SESSION_STORAGE_PATH);
  }
  return DEFAULT_SESSION_DIR;
}

async function ensureSessionDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export function getSessionPath(sessionId: string): string {
  // Replace unsafe chars for filename
  const safeId = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  return path.join(getSessionDir(), `${safeId}.json`);
}

export async function loadSession(sessionId: string, cwd: string): Promise<Session> {
  const sessionPath = getSessionPath(sessionId);
  try {
    const data = await fs.readFile(sessionPath, 'utf8');
    return JSON.parse(data) as Session;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      // Return new session if not found
      return {
        id: sessionId,
        cwd,
        createdAt: new Date().toISOString(),
        messages: []
      };
    }
    throw err;
  }
}

export async function saveSession(session: Session): Promise<void> {
  const dir = getSessionDir();
  await ensureSessionDir(dir);
  
  const sessionPath = getSessionPath(session.id);
  const tempPath = `${sessionPath}.tmp`;
  
  const content = JSON.stringify(session, null, 2);
  
  // Atomic write: write to temp file then rename
  await fs.writeFile(tempPath, content, 'utf8');
  await fs.rename(tempPath, sessionPath);
}

// Memory-based concurrency locks per session
const locks = new Map<string, Promise<void>>();

export async function acquireSessionLock(sessionId: string): Promise<() => void> {
  let release: () => void = () => {};
  const nextLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  
  const currentLock = locks.get(sessionId) || Promise.resolve();
  locks.set(sessionId, nextLock);
  
  await currentLock;
  
  return () => {
    release();
    if (locks.get(sessionId) === nextLock) {
      locks.delete(sessionId);
    }
  };
}
