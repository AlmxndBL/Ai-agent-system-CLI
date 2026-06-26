import { execFileSync } from 'child_process';
import * as os from 'os';

export interface PrivilegeStatus {
  privileged: boolean;
  detail: string;
}

/**
 * Best-effort detection of whether this process runs with elevated/admin/root
 * privileges. The design (§9.5) requires the daemon to run as a dedicated
 * low-privilege user so an RCE cannot reach ~/.ssh, browser profiles, keychains,
 * or system files. This never throws — detection failure is reported as "unknown".
 */
export function detectPrivilege(): PrivilegeStatus {
  if (os.platform() === 'win32') {
    try {
      // Pin to the absolute System32 path so a shadowing `whoami` earlier in PATH
      // (e.g. Git Bash / MSYS coreutils) can't break detection and fail it open.
      const winDir = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
      const whoamiPath = `${winDir}\\System32\\whoami.exe`;
      // The High Mandatory Level SID (S-1-16-12288) is only present in the token
      // of an elevated ("Run as administrator") process.
      const out = execFileSync(whoamiPath, ['/groups'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      if (out.includes('S-1-16-12288')) {
        return { privileged: true, detail: 'Windows process is running elevated (High Mandatory Level).' };
      }
      return { privileged: false, detail: 'Windows process is not elevated.' };
    } catch {
      return { privileged: false, detail: 'Could not determine Windows elevation (assuming not elevated).' };
    }
  }

  // POSIX: uid 0 is root.
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (uid === 0) {
    return { privileged: true, detail: 'Process is running as root (uid 0).' };
  }
  return { privileged: false, detail: `Process running as uid ${uid}.` };
}

/**
 * Warn when the daemon is running privileged. If REQUIRE_LOWPRIV=true is set in
 * the environment, hard-fail instead — use that on the real always-on deployment
 * so the listener cannot be exposed from a privileged account by accident.
 */
export function assertLowPrivilege(): void {
  const status = detectPrivilege();
  if (status.privileged) {
    const msg =
      `⚠️  [Hardening] ${status.detail}\n` +
      `   The design (§9.5) requires running as a DEDICATED LOW-PRIVILEGE user so an RCE\n` +
      `   cannot reach ~/.ssh, browser profiles, keychains, or system files.\n` +
      `   See SETUP-HARDENING.md to configure a restricted user / container before exposing the listener.`;
    if (process.env.REQUIRE_LOWPRIV === 'true') {
      throw new Error(msg + '\n   REQUIRE_LOWPRIV=true is set → refusing to start.');
    }
    console.warn(msg);
  } else {
    console.log(`🔒 [Hardening] Privilege check OK — ${status.detail}`);
  }
}
