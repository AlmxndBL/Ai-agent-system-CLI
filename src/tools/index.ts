import * as fs from 'fs/promises';
import * as path from 'path';
import { tool } from 'ai';
import { z } from 'zod';
import { rememberTool, recallTool } from './obsidian';
import { writeFileTool, editFileTool, runBashTool } from './mutate';
import { scanAndTaint } from '../core/taint';
import { sessionLocalStorage } from '../core/session';
import { logAudit, isKillSwitchTriggered } from '../core/audit';
import { redactSecrets } from '../core/secrets';

// True iff `child` is `parent` itself or lives strictly inside it.
// Uses path.relative so a sibling sharing a string prefix (e.g. "<cwd>-backup")
// can never pass — `startsWith` alone is exploitable here.
export function isInsideRoot(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Walk up from a path until we hit a component that actually exists, realpath THAT
// (resolving any symlinks in the existing portion), and report the not-yet-existing
// trailing segments separately. Used to canonicalize the destination of a
// not-yet-created file so a symlinked ancestor cannot smuggle a write out of root.
async function resolveExistingAncestor(p: string): Promise<{ realBase: string; tail: string[] }> {
  let current = path.resolve(p);
  const tail: string[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const real = await fs.realpath(current);
      return { realBase: real, tail: tail.reverse() };
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        const parent = path.dirname(current);
        if (parent === current) {
          return { realBase: current, tail: tail.reverse() }; // reached filesystem root
        }
        tail.push(path.basename(current));
        current = parent;
        continue;
      }
      throw err;
    }
  }
}

// Helper to validate and restrict paths to current working directory (CWD).
// Returns a CANONICAL absolute path: for existing targets the realpath; for
// not-yet-existing targets, the not-yet-existing tail re-anchored onto the realpath
// of its nearest existing ancestor (never a bare lexical path). This guarantees the
// returned path has no unresolved symlinked ancestor at check time.
export async function validatePath(userPath: string): Promise<string> {
  const cwd = path.resolve(process.cwd());
  const resolved = path.resolve(cwd, userPath);

  // Lexical containment (catches ../ and sibling-prefix escapes)
  if (!isInsideRoot(cwd, resolved)) {
    throw new Error(`Access denied: path '${userPath}' is outside workspace root`);
  }

  try {
    // Resolve symlinks on the real target, then re-verify containment (TOCTOU-aware: realpath after resolve)
    const real = await fs.realpath(resolved);
    if (!isInsideRoot(cwd, real)) {
      throw new Error(`Access denied: path resolves outside workspace root`);
    }
    return real;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      // Path does not exist yet. Anchor the not-yet-existing tail onto the REAL
      // (symlink-resolved) path of its nearest existing ancestor, and verify both
      // that ancestor and the final canonical path stay inside the root.
      const { realBase, tail } = await resolveExistingAncestor(path.dirname(resolved));
      if (!isInsideRoot(cwd, realBase)) {
        throw new Error(`Access denied: parent of '${userPath}' resolves outside workspace root`);
      }
      const leaf = path.basename(resolved);
      const canonical = path.join(realBase, ...tail, leaf);
      if (!isInsideRoot(cwd, canonical)) {
        throw new Error(`Access denied: path '${userPath}' is outside workspace root`);
      }
      return canonical;
    }
    throw err;
  }
}

// Symlink-safe guard called immediately BEFORE a mutating write (§T5). validatePath
// resolves symlinks at check time, but the write happens later (after a human
// approval), leaving a TOCTOU window in which a path component could be swapped for
// a symlink pointing outside the workspace. This walks every component from the
// workspace root down to `target` and rejects if any existing one is a symlink, so
// a component swapped in during the approval wait is caught right before the write.
export async function assertNoSymlinkEscape(target: string): Promise<void> {
  const cwd = path.resolve(process.cwd());
  const abs = path.resolve(target);
  const rel = path.relative(cwd, abs);
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
    throw new Error('Access denied: path is outside workspace root');
  }
  const segments = rel.split(path.sep).filter(Boolean);
  let current = cwd;
  for (const seg of segments) {
    current = path.join(current, seg);
    try {
      const st = await fs.lstat(current);
      if (st.isSymbolicLink()) {
        throw new Error(`Access denied: '${seg}' is a symlink — refusing to follow it out of the workspace`);
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        // Nothing exists from here down, so there is no symlink left to follow.
        return;
      }
      throw err;
    }
  }
}

// Helper to get files recursively
async function getFilesRecursively(dir: string): Promise<string[]> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(dirents.map(async (dirent) => {
    const res = path.resolve(dir, dirent.name);
    // Skip ignorable folders
    if (
      dirent.name === 'node_modules' || 
      dirent.name === '.git' || 
      dirent.name === 'dist' || 
      dirent.name === '.agent'
    ) {
      return [];
    }
    return dirent.isDirectory() ? getFilesRecursively(res) : res;
  }));
  return Array.prototype.concat(...files);
}

// Convert a simple glob pattern to RegExp
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = '^' + escaped
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.') + '$';
  return new RegExp(regexStr, 'i');
}

export const readFileTool = tool({
  description: 'Read the contents of a text file inside the workspace root.',
  inputSchema: z.object({
    path: z.string().describe('Relative path to the file to read.')
  }),
  execute: async ({ path: userPath }) => {
    try {
      if (await isKillSwitchTriggered()) {
        return 'Error: Action blocked by kill switch.';
      }
      
      const sessionId = sessionLocalStorage.getStore()?.sessionId || 'default';
      const target = await validatePath(userPath);
      const content = await fs.readFile(target, 'utf8');
      
      // Safety cap: truncate if file is too large (> 32KB)
      const MAX_SIZE = 32 * 1024;
      let finalContent = content;
      if (content.length > MAX_SIZE) {
        finalContent = content.substring(0, MAX_SIZE) + '\n\n[...truncated due to size limit]';
      }
      
      // Scan and taint if necessary
      scanAndTaint(sessionId, userPath, finalContent);
      
      // Redact any secrets
      const redacted = redactSecrets(finalContent);
      
      await logAudit(sessionId, 'read_file', { path: userPath, size: content.length, redacted: redacted.length !== content.length });
      
      return redacted;
    } catch (err: any) {
      return `Error reading file: ${err.message}`;
    }
  }
});

export const globTool = tool({
  description: 'Find files within the workspace matching a glob pattern (e.g. **/*.ts, src/core/*.ts).',
  inputSchema: z.object({
    pattern: z.string().describe('Glob pattern to match files.')
  }),
  execute: async ({ pattern }) => {
    try {
      if (await isKillSwitchTriggered()) {
        return 'Error: Action blocked by kill switch.';
      }
      
      const sessionId = sessionLocalStorage.getStore()?.sessionId || 'default';
      const cwd = path.resolve(process.cwd());
      const allFiles = await getFilesRecursively(cwd);
      const regex = globToRegex(pattern);
      
      const matched = allFiles
        .map(file => path.relative(cwd, file).replace(/\\/g, '/'))
        .filter(relPath => regex.test(relPath));
        
      await logAudit(sessionId, 'glob', { pattern, matchedCount: matched.length });
      
      return matched.length > 0 ? matched.join('\n') : 'No matching files found.';
    } catch (err: any) {
      return `Error in glob: ${err.message}`;
    }
  }
});

export const grepTool = tool({
  description: 'Search for a string pattern across files in a path (ripgrep-like search).',
  inputSchema: z.object({
    query: z.string().describe('Text pattern to search for.'),
    path: z.string().optional().describe('Relative directory path to scope search within. Defaults to workspace root.')
  }),
  execute: async ({ query, path: searchPath = '.' }) => {
    try {
      if (await isKillSwitchTriggered()) {
        return 'Error: Action blocked by kill switch.';
      }
      
      const sessionId = sessionLocalStorage.getStore()?.sessionId || 'default';
      const targetDir = await validatePath(searchPath);
      const files = await getFilesRecursively(targetDir);
      const matches: string[] = [];
      const MAX_MATCHES = 50;
      
      for (const file of files) {
        if (matches.length >= MAX_MATCHES) break;
        
        try {
          const content = await fs.readFile(file, 'utf8');
          const lines = content.split(/\r?\n/);
          
          lines.forEach((line, idx) => {
            if (matches.length >= MAX_MATCHES) return;
            if (line.includes(query)) {
              const relPath = path.relative(process.cwd(), file).replace(/\\/g, '/');
              matches.push(`${relPath}:${idx + 1}: ${line.trim()}`);
            }
          });
        } catch {
          // Skip binary files or unreadable files
        }
      }
      
      const resultText = matches.join('\n');
      scanAndTaint(sessionId, `grep:${query}`, resultText);
      const redacted = redactSecrets(resultText);
      
      await logAudit(sessionId, 'grep', { query, path: searchPath, matchesCount: matches.length });
      
      if (matches.length === 0) {
        return `No matches found for '${query}'.`;
      }
      
      let outputText = redacted;
      if (matches.length >= MAX_MATCHES) {
        outputText += `\n[Showing first ${MAX_MATCHES} matches. Result capped to prevent token overflow]`;
      }
      
      return outputText;
    } catch (err: any) {
      return `Error in grep: ${err.message}`;
    }
  }
});

// Catalog of tools for Phase 1, 2 & 3
export const tools = {
  read_file: readFileTool,
  glob: globTool,
  grep: grepTool,
  remember: rememberTool,
  recall: recallTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  run_bash: runBashTool
};
