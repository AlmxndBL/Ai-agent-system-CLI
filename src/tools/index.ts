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

// realpath the nearest ancestor that actually exists — used to validate the
// destination of a not-yet-created file (e.g. write_file), so a symlinked
// parent directory cannot smuggle the write outside the workspace root.
async function realpathNearestAncestor(p: string): Promise<string> {
  let current = path.resolve(p);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fs.realpath(current);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        const parent = path.dirname(current);
        if (parent === current) return current; // reached filesystem root
        current = parent;
        continue;
      }
      throw err;
    }
  }
}

// Helper to validate and restrict paths to current working directory (CWD)
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
      // Path does not exist yet — verify the nearest existing ancestor stays
      // inside the root, so a symlinked parent dir can't escape on write.
      const realParent = await realpathNearestAncestor(path.dirname(resolved));
      if (!isInsideRoot(cwd, realParent)) {
        throw new Error(`Access denied: parent of '${userPath}' resolves outside workspace root`);
      }
      return resolved;
    }
    throw err;
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
