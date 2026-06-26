import { spawn, ChildProcess, exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { isKillSwitchTriggered } from './core/audit';
import { assertLowPrivilege } from './core/hardening';

const HEARTBEAT_PATH = path.join(os.homedir(), '.agent', 'heartbeat');
const MAX_CRASH_COUNT = 10;
const HEALTH_CHECK_INTERVAL = 10000; // Check every 10 seconds
const HUNG_THRESHOLD = 30000; // Consider hung if no heartbeat for 30 seconds
const STARTUP_TIMEOUT = 90000; // Allow 90 seconds for TypeScript/tsx compilation on first startup

let child: ChildProcess | null = null;
let consecutiveCrashes = 0;
let lastRestartTime = Date.now();

function killProcessTree(proc: ChildProcess) {
  if (!proc.pid) return;
  if (os.platform() === 'win32') {
    // Kill the entire process tree (/T) forcefully (/F) on Windows
    exec(`taskkill /pid ${proc.pid} /T /F`, (err) => {
      if (err) {
        // Suppress warning if process is already dead
      }
    });
  } else {
    proc.kill('SIGKILL');
  }
}

async function cleanHeartbeat() {
  try {
    await fs.unlink(HEARTBEAT_PATH);
  } catch {}
}

function getBackoffDelay(): number {
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, max 60s
  const delay = Math.pow(2, consecutiveCrashes) * 1000;
  return Math.min(delay, 60000);
}

async function startDaemon() {
  if (await isKillSwitchTriggered()) {
    console.error('🚨 [Supervisor] Kill switch is active. Cannot start daemon. Disarm system first.');
    process.exit(1);
  }

  if (consecutiveCrashes >= MAX_CRASH_COUNT) {
    console.error(`🚨 [Supervisor] Max consecutive crashes (${MAX_CRASH_COUNT}) reached. Shutting down daemon permanently for safety.`);
    process.exit(1);
  }

  // Clear previous heartbeat before starting
  await cleanHeartbeat();

  console.log(`🚀 [Supervisor] Spawning Telegram daemon (Attempt ${consecutiveCrashes + 1})...`);
  lastRestartTime = Date.now();

  // Decide source-mode (tsx) vs compiled-mode (node) by what actually sits next to
  // THIS file — not by whether the tsx binary happens to be installed. In compiled
  // mode __dirname is dist/ and only telegram.js exists, so we must use node even
  // though tsx (a devDependency) is usually still present in node_modules.
  const tsScript = path.join(__dirname, 'telegram.ts');
  const jsScript = path.join(__dirname, 'telegram.js');
  const hasTsSource = await fs.access(tsScript).then(() => true).catch(() => false);

  const command = hasTsSource ? 'npx' : 'node';
  const args = hasTsSource ? ['tsx', tsScript] : [jsScript];

  // Only npx needs the .cmd shim on Windows; `node` is node.exe (node.cmd doesn't exist).
  const resolvedCommand = os.platform() === 'win32' && command === 'npx' ? 'npx.cmd' : command;

  child = spawn(resolvedCommand, args, {
    stdio: 'inherit',
    cwd: process.cwd(),
    shell: os.platform() === 'win32' // Necessary on Windows to resolve npx.cmd/node correctly in spawn
  });

  child.on('exit', (code, signal) => {
    child = null;
    const runtime = Date.now() - lastRestartTime;
    
    console.log(`⚠️ [Supervisor] Daemon exited with code ${code} and signal ${signal}`);
    
    // Reset crash count if the process ran stably for more than 5 minutes
    if (runtime > 300000) {
      consecutiveCrashes = 0;
    } else {
      consecutiveCrashes++;
    }
    
    const delay = getBackoffDelay();
    console.log(`🔄 [Supervisor] Restarting daemon in ${delay / 1000}s...`);
    setTimeout(startDaemon, delay);
  });
}

// Watchdog timer loop to check daemon health
async function watchdogLoop() {
  try {
    // 1. Check Kill Switch
    if (await isKillSwitchTriggered()) {
      if (child) {
        console.warn('🚨 [Supervisor] Kill switch detected! Terminating daemon...');
        child.kill('SIGKILL');
      }
      return;
    }

    // 2. Check Heartbeat
    if (child) {
      try {
        const stat = await fs.stat(HEARTBEAT_PATH);
        const lastHeartbeat = stat.mtimeMs;
        const timeSinceHeartbeat = Date.now() - lastHeartbeat;
        
        if (timeSinceHeartbeat > HUNG_THRESHOLD) {
          console.warn(`🚨 [Supervisor] Daemon hung detected! No heartbeat for ${timeSinceHeartbeat / 1000}s. Killing process...`);
          killProcessTree(child);
        }
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          // Heartbeat file not created yet, check if process is starting
          const startupTime = Date.now() - lastRestartTime;
          if (startupTime > STARTUP_TIMEOUT) {
            console.warn(`🚨 [Supervisor] Daemon failed to initialize heartbeat. Killing process...`);
            killProcessTree(child);
          }
        }
      }
    }
  } catch (err: any) {
    console.error('[Supervisor] Error in watchdog loop:', err);
  } finally {
    setTimeout(watchdogLoop, HEALTH_CHECK_INTERVAL);
  }
}

// Refuse/warn if the supervisor is running with elevated privileges (§9.5)
assertLowPrivilege();

// Start supervisor daemon
startDaemon().then(() => {
  setTimeout(watchdogLoop, HEALTH_CHECK_INTERVAL);
});

// Handle graceful termination of supervisor
process.on('SIGTERM', () => {
  console.log('[Supervisor] Shutting down. Terminating child process...');
  if (child) {
    killProcessTree(child);
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Supervisor] Interrupted. Terminating child process...');
  if (child) {
    killProcessTree(child);
  }
  process.exit(0);
});
