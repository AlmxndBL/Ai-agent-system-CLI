import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tool } from 'ai';
import { z } from 'zod';
import * as os from 'os';
import { validatePath, assertNoSymlinkEscape } from './index';
import { requestApproval } from '../core/approval';
import { sessionLocalStorage } from '../core/session';
import { logAudit, isKillSwitchTriggered } from '../core/audit';
import { getSessionTaint } from '../core/taint';
import { redactSecrets, getSafeChildEnv } from '../core/secrets';

const execFilePromise = promisify(execFile);

// Resolve Windows binary extensions where necessary
function resolveBinary(binary: string): string {
  if (os.platform() === 'win32') {
    if (binary === 'npm') return 'npm.cmd';
    if (binary === 'tsc') return 'tsc.cmd';
    if (binary === 'npx') return 'npx.cmd';
  }
  return binary;
}

// Parse simple shell commands with space or quoted arguments
export function parseShellCommand(cmd: string): { binary: string; args: string[] } {
  const args: string[] = [];
  let current = '';
  let inDoubleQuote = false;
  let inSingleQuote = false;
  
  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i];
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    } else if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === ' ' && !inDoubleQuote && !inSingleQuote) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current) {
    args.push(current);
  }
  
  if (args.length === 0) {
    throw new Error('Command is empty');
  }
  
  return {
    binary: args[0],
    args: args.slice(1)
  };
}

// Validate command arguments strictly
export function validateAndNormalizeCommand(binary: string, args: string[]): { binary: string; args: string[] } {
  const normBinary = binary.toLowerCase();
  
  if (normBinary === 'npm') {
    const action = args[0];
    const subAction = args[1];
    
    const isBuild = action === 'run' && subAction === 'build';
    const isTest = action === 'test' || (action === 'run' && subAction === 'test');
    
    if (!isBuild && !isTest) {
      throw new Error(`npm execution rejected. Only 'npm run build' and 'npm test' are allowed.`);
    }
    
    const cleanArgs = [...args];
    if (!cleanArgs.includes('--ignore-scripts')) {
      cleanArgs.push('--ignore-scripts');
    }
    return { binary: resolveBinary('npm'), args: cleanArgs };
  }
  
  if (normBinary === 'tsc') {
    return { binary: resolveBinary('tsc'), args };
  }
  
  if (normBinary === 'git') {
    const action = args[0];
    const allowedGitActions = ['status', 'diff', 'log', 'add', 'commit'];
    if (!allowedGitActions.includes(action)) {
      throw new Error(`git command rejected. Only status, diff, log, add, and commit are allowed.`);
    }
    return { binary: 'git', args };
  }
  
  if (normBinary === 'node') {
    const scriptPath = args[0];
    if (!scriptPath || !scriptPath.startsWith('dist/')) {
      throw new Error(`node execution rejected. Only running compiled scripts under dist/ is allowed.`);
    }
    return { binary: 'node', args };
  }
  
  throw new Error(`Command '${binary}' is not allowed. Executable must be npm, tsc, git, or node.`);
}

export const writeFileTool = tool({
  description: 'Write a new file or overwrite an existing file inside the workspace root (requires approval).',
  inputSchema: z.object({
    path: z.string().describe('Relative path to write the file to.'),
    content: z.string().describe('The content of the file.')
  }),
  execute: async ({ path: userPath, content }) => {
    const sessionId = sessionLocalStorage.getStore()?.sessionId || 'default';
    try {
      if (await isKillSwitchTriggered()) {
        return 'Error: Action blocked by kill switch.';
      }
      
      // Early containment check so an obviously out-of-scope path is rejected before
      // we bother the user with an approval prompt; the authoritative check is the
      // re-validation done after approval, immediately before the write.
      await validatePath(userPath);
      const taint = getSessionTaint(sessionId);
      
      // Request User Approval
      const approved = await requestApproval('write_file', {
        path: userPath,
        tainted: taint.isTainted,
        reasons: taint.reasons,
        contentPreview: content.substring(0, 100)
      });
      
      await logAudit(sessionId, 'write_file_approval', { path: userPath, approved, tainted: taint.isTainted });
      
      if (!approved) {
        return 'Error: Action denied by user.';
      }

      // Re-validate AFTER approval to close the TOCTOU window (the approval wait can
      // last minutes) and reject any path component that is now a symlink, so a
      // swapped-in symlink can't redirect the write outside the workspace (§T5).
      const safeTarget = await validatePath(userPath);
      await assertNoSymlinkEscape(path.dirname(safeTarget));
      await fs.mkdir(path.dirname(safeTarget), { recursive: true });
      await assertNoSymlinkEscape(safeTarget);
      await fs.writeFile(safeTarget, content, 'utf8');

      await logAudit(sessionId, 'write_file_success', { path: userPath, size: content.length });
      return `Successfully wrote file: ${userPath}`;
    } catch (err: any) {
      const redactedMsg = redactSecrets(err.message);
      await logAudit(sessionId, 'write_file_error', { path: userPath, error: redactedMsg });
      return `Error writing file: ${redactedMsg}`;
    }
  }
});

export const editFileTool = tool({
  description: 'Search and replace a specific block of text in a workspace file (requires approval).',
  inputSchema: z.object({
    path: z.string().describe('Relative path of the file to edit.'),
    old: z.string().describe('The precise block of lines to replace. Must match exactly.'),
    new: z.string().describe('The replacement block of lines.')
  }),
  execute: async ({ path: userPath, old, new: newContent }) => {
    const sessionId = sessionLocalStorage.getStore()?.sessionId || 'default';
    try {
      if (await isKillSwitchTriggered()) {
        return 'Error: Action blocked by kill switch.';
      }
      
      // Early containment check so an obviously out-of-scope path is rejected before
      // we bother the user with an approval prompt; the authoritative check is the
      // re-validation done after approval, immediately before the write.
      await validatePath(userPath);
      const taint = getSessionTaint(sessionId);
      
      // Request User Approval
      const approved = await requestApproval('edit_file', {
        path: userPath,
        tainted: taint.isTainted,
        reasons: taint.reasons,
        oldPreview: old.substring(0, 100),
        newPreview: newContent.substring(0, 100)
      });
      
      await logAudit(sessionId, 'edit_file_approval', { path: userPath, approved, tainted: taint.isTainted });
      
      if (!approved) {
        return 'Error: Action denied by user.';
      }

      // Re-validate AFTER approval and reject symlinked components before touching
      // the file, closing the TOCTOU window opened by the approval wait (§T5).
      const safeTarget = await validatePath(userPath);
      await assertNoSymlinkEscape(safeTarget);
      const content = await fs.readFile(safeTarget, 'utf8');

      const occurrences = content.split(old).length - 1;
      if (occurrences === 0) {
        return `Error: Could not find the precise 'old' block inside the file. Match must be exact (including whitespace).`;
      }
      if (occurrences > 1) {
        return `Error: Found multiple occurrences (${occurrences}) of the 'old' block. Make your 'old' block more specific to target a single location.`;
      }

      const updated = content.replace(old, newContent);
      await assertNoSymlinkEscape(safeTarget);
      await fs.writeFile(safeTarget, updated, 'utf8');

      await logAudit(sessionId, 'edit_file_success', { path: userPath });
      return `Successfully edited file: ${userPath}`;
    } catch (err: any) {
      const redactedMsg = redactSecrets(err.message);
      await logAudit(sessionId, 'edit_file_error', { path: userPath, error: redactedMsg });
      return `Error editing file: ${redactedMsg}`;
    }
  }
});

export const runBashTool = tool({
  description: 'Execute a command in the workspace directory (requires approval and allowlist validation).',
  inputSchema: z.object({
    cmd: z.string().describe('The command to run.')
  }),
  execute: async ({ cmd }) => {
    const sessionId = sessionLocalStorage.getStore()?.sessionId || 'default';
    try {
      if (await isKillSwitchTriggered()) {
        return 'Error: Action blocked by kill switch.';
      }
      
      // Parse cmd into binary and argv structure to prevent shell execution vulnerabilities
      const parsed = parseShellCommand(cmd);
      
      // Validate structure strictly
      const validated = validateAndNormalizeCommand(parsed.binary, parsed.args);
      
      const taint = getSessionTaint(sessionId);
      
      // Request User Approval
      const approved = await requestApproval('run_bash', {
        cmd,
        binary: validated.binary,
        args: validated.args,
        tainted: taint.isTainted,
        reasons: taint.reasons
      });
      
      await logAudit(sessionId, 'run_bash_approval', { cmd, approved, tainted: taint.isTainted });
      
      if (!approved) {
        return 'Error: Action denied by user.';
      }
      
      // Run as exact process, without launching a host shell processor (defense-in-depth).
      // §9.5: hand the child an env with all known secret keys stripped, not raw process.env.
      const { stdout, stderr } = await execFilePromise(validated.binary, validated.args, {
        cwd: process.cwd(),
        env: getSafeChildEnv()
      });
      
      const result = [
        stdout ? `Stdout:\n${stdout}` : '',
        stderr ? `Stderr:\n${stderr}` : ''
      ].filter(Boolean).join('\n');
      
      const redactedResult = redactSecrets(result);
      
      await logAudit(sessionId, 'run_bash_success', { cmd, outputLength: redactedResult.length });
      
      return redactedResult || 'Command executed successfully with no output.';
    } catch (err: any) {
      const redactedMsg = redactSecrets(err.message);
      await logAudit(sessionId, 'run_bash_error', { cmd, error: redactedMsg });
      return `Error executing command: ${redactedMsg}`;
    }
  }
});
