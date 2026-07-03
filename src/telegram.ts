import { Telegraf } from 'telegraf';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { verifyTotpGuarded, GuardedTotpResult } from './core/totp-guard';
import { getSecret, initSecretBroker } from './core/secrets';
import { loadSession, sessionLocalStorage } from './core/session';
import { runAgent } from './core/agent';
import { setApprovalHandler } from './core/approval';
import { isKillSwitchTriggered, triggerKillSwitch, resetKillSwitch, verifyAuditChain, logAudit } from './core/audit';
import { getSessionTaint, clearTaint } from './core/taint';
import { assertLowPrivilege } from './core/hardening';
import { getProviderName, getModelId, parseProviderName, checkProviderReady, PROVIDERS } from './core/providers';

// Initialize Secret Broker immediately to cleanse process.env
initSecretBroker();
// Refuse/warn if the daemon is running with elevated privileges (§9.5)
assertLowPrivilege();

const telegramToken = getSecret('TELEGRAM_TOKEN');
const ownerId = getSecret('OWNER_TELEGRAM_ID');
const totpSecret = getSecret('TOTP_SECRET');

if (!telegramToken || !ownerId || !totpSecret) {
  console.error('Error: TELEGRAM_TOKEN, OWNER_TELEGRAM_ID, and TOTP_SECRET must be set in your configuration.');
  process.exit(1);
}

const bot = new Telegraf(telegramToken);

// Human-readable reply for a rejected TOTP attempt (distinguishes lockout / replay
// / plain-invalid so a locked-out owner understands why their correct code failed).
function totpDenyReply(res: GuardedTotpResult): string {
  if (res.reason === 'locked') {
    const secs = Math.ceil((res.retryAfterMs || 0) / 1000);
    return `⛔ **Too many invalid codes.** Temporarily locked — try again in ~${secs}s.`;
  }
  if (res.reason === 'replay') {
    return '❌ **That code was already used.** Wait for your Authenticator to show a new one.';
  }
  return '❌ **Invalid TOTP code.** Action denied.';
}

// Helper to chunk long replies for Telegram's limits (Telegram limit is 4096)
function chunkResponse(text: string, maxLimit = 3500): string[] {
  const chunks: string[] = [];
  let currentChunk = '';
  
  const lines = text.split('\n');
  for (const line of lines) {
    if (currentChunk.length + line.length + 1 > maxLimit) {
      chunks.push(currentChunk);
      currentChunk = line;
    } else {
      currentChunk = currentChunk ? `${currentChunk}\n${line}` : line;
    }
  }
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  return chunks;
}

// Pending out-of-band approvals, keyed by chat id. Keying per chat (instead of a
// single global) means concurrent chats never clobber each other's approval, every
// promise always settles (so the per-session lock is never held forever), and a typed
// TOTP code can only ever answer the request from the SAME chat that was asked.
interface PendingApproval {
  resolve: (value: boolean) => void;
  timer: NodeJS.Timeout;
}
const pendingApprovals = new Map<number, PendingApproval>();

// Settle the pending approval for a chat exactly once (clears its timer + resolves).
// Returns false if there was nothing pending (e.g. it already timed out).
function settlePending(chatId: number, value: boolean): boolean {
  const pending = pendingApprovals.get(chatId);
  if (!pending) return false;
  pendingApprovals.delete(chatId);
  clearTimeout(pending.timer);
  pending.resolve(value);
  return true;
}

// Custom out-of-band Telegram TOTP approval handler
setApprovalHandler((toolName, args) => {
  return new Promise<boolean>(async (resolve) => {
    const store = sessionLocalStorage.getStore();
    if (!store || !store.telegramChatId) {
      resolve(false);
      return;
    }
    const chatId = store.telegramChatId;

    try {
      // Supersede any still-pending approval for this chat so its promise settles
      // (deny) and no earlier runAgent is left awaiting with the session lock held.
      settlePending(chatId, false);

      const taintWarning = args.tainted
        ? `⚠️ **[WARNING: TAINTED CONTEXT DETECTED]**\nReasons:\n${args.reasons.map((r: string) => `- ${r}`).join('\n')}\n`
        : '';

      await bot.telegram.sendMessage(
        chatId,
        `⚠️ **[Approval Required]**\n` +
        taintWarning +
        `**Action**: \`${toolName}\`\n` +
        `**Parameters**:\n` +
        `\`\`\`json\n${JSON.stringify(args, null, 2).substring(0, 1500)}\n\`\`\`\n` +
        `🔓 Enter the 6-digit TOTP code from your Authenticator app within 60 seconds to authorize:`
      );

      // Auto timeout after 60s — only fires if this exact request is still pending.
      const timer = setTimeout(() => {
        if (pendingApprovals.get(chatId)?.resolve === resolve) {
          pendingApprovals.delete(chatId);
          bot.telegram.sendMessage(chatId, '⏳ **Approval request timed out.** Action denied.').catch(() => {});
          resolve(false);
        }
      }, 60000);

      pendingApprovals.set(chatId, { resolve, timer });
    } catch (err: any) {
      pendingApprovals.delete(chatId);
      console.error('Error in Telegram approval handler:', err);
      resolve(false);
    }
  });
});

// Middleware to enforce owner-only check
bot.use(async (ctx, next) => {
  if (ctx.from?.id.toString() !== ownerId) {
    console.log(`Unauthorized access attempt by Telegram ID: ${ctx.from?.id}`);
    return; // Ignore silently
  }
  return next();
});

// Start heartbeat watchdog check
const heartbeatPath = path.join(os.homedir(), '.agent', 'heartbeat');
async function writeHeartbeat() {
  try {
    await fs.mkdir(path.dirname(heartbeatPath), { recursive: true });
    await fs.writeFile(heartbeatPath, new Date().toISOString(), 'utf8');
  } catch (err: any) {
    console.error('Failed to write watchdog heartbeat:', err.message);
  }
}

// 1. Admin Commands
bot.command('panic', async (ctx) => {
  await triggerKillSwitch(`telegram-${ctx.chat.id}`, 'Manual panic command triggered by owner via Telegram.');
  await ctx.reply('🚨 **PANIC KILL-SWITCH TRIGGERED.** All agent operations are now frozen. System disarmed.');
});

bot.command('unpanic', async (ctx) => {
  const text = ctx.message.text.trim();
  const parts = text.split(' ');
  const code = parts[1];
  
  if (!code || !/^\d{6}$/.test(code)) {
    await ctx.reply('⚠️ Usage: /unpanic <6-digit-TOTP-code>');
    return;
  }
  
  const res = verifyTotpGuarded(`telegram-${ctx.chat.id}`, code, totpSecret);
  if (res.ok) {
    await resetKillSwitch(`telegram-${ctx.chat.id}`);
    await ctx.reply('🔓 **Kill switch has been successfully reset.** Mutating actions enabled.');
  } else {
    await ctx.reply(totpDenyReply(res));
  }
});

bot.command('status', async (ctx) => {
  const isFrozen = await isKillSwitchTriggered();
  const taintState = getSessionTaint(`telegram-${ctx.chat.id}`);
  const statusMsg = [
    `📊 **Agent Daemon Status**`,
    `• **Kill Switch**: ${isFrozen ? '🚨 **ACTIVE (FROZEN)**' : '✅ Armed & Active'}`,
    `• **Session ID**: \`telegram-${ctx.chat.id}\``,
    `• **Taint State**: ${taintState.isTainted ? '⚠️ **TAINTED**' : '✅ Clean'}`,
    taintState.isTainted ? `  - Reasons:\n${taintState.reasons.map(r => `    * ${r}`).join('\n')}` : ''
  ].filter(Boolean).join('\n');
  await ctx.reply(statusMsg);
});

bot.command('clear_taint', async (ctx) => {
  clearTaint(`telegram-${ctx.chat.id}`);
  await ctx.reply('🧹 Session taint memory cleared.');
});

bot.command('verify_audit', async (ctx) => {
  const res = await verifyAuditChain();
  if (res.valid) {
    await ctx.reply(`🔒 **Audit chain intact.** ${res.entries} entr${res.entries === 1 ? 'y' : 'ies'} verified.`);
  } else {
    await ctx.reply(`🚨 **AUDIT CHAIN TAMPERED!**\n• Broken at line: \`${res.brokenAtIndex}\`\n• Reason: ${res.reason}`);
  }
});

bot.command('model', async (ctx) => {
  const arg = ctx.message.text.trim().split(/\s+/)[1];
  if (!arg) {
    const current = getProviderName();
    await ctx.reply(`🧠 **Model provider**: \`${current}\` (${getModelId(current)})\nAvailable: ${PROVIDERS.map(p => `\`${p}\``).join(', ')}\nSwitch with /model <name>.`);
    return;
  }
  const target = parseProviderName(arg);
  if (!target) {
    await ctx.reply(`❌ Unknown provider \`${arg}\`. Available: ${PROVIDERS.map(p => `\`${p}\``).join(', ')}.`);
    return;
  }
  const notReady = checkProviderReady(target);
  if (notReady) {
    await ctx.reply(`❌ Cannot switch to \`${target}\` — ${notReady}.`);
    return;
  }
  process.env.MODEL_PROVIDER = target;
  await logAudit(`telegram-${ctx.chat.id}`, 'model_switch', { provider: target });
  await ctx.reply(`✅ **Model provider switched to** \`${target}\` (${getModelId(target)}).`);
});

// 2. Normal Message Processing Loop
bot.on('text', async (ctx) => {
  const content = ctx.message.text.trim();
  
  // Skip commands since they are handled separately
  if (content.startsWith('/')) return;
  
  // If THIS chat is awaiting a TOTP approval, a 6-digit message answers that request.
  if (/^\d{6}$/.test(content) && pendingApprovals.has(ctx.chat.id)) {
    const res = verifyTotpGuarded(`telegram-${ctx.chat.id}`, content, totpSecret);
    // Settle synchronously (clears timer + resolves) before any await, to avoid a
    // race where the 60s timeout fires mid-reply and double-settles.
    const settled = settlePending(ctx.chat.id, res.ok);
    if (settled) {
      await ctx.reply(res.ok
        ? '✅ **TOTP code verified.** Action approved.'
        : totpDenyReply(res));
    }
    return;
  }
  
  const isFrozen = await isKillSwitchTriggered();
  if (isFrozen) {
    await ctx.reply('🚨 **Operations blocked.** The agent daemon is currently locked down in panic mode. Use `/unpanic <TOTP>` to unlock.');
    return;
  }
  
  const sessionId = `telegram-${ctx.chat.id}`;
  const cwd = process.cwd();
  
  try {
    await ctx.sendChatAction('typing');
    const typingInterval = setInterval(() => {
      ctx.sendChatAction('typing').catch(() => {});
    }, 5000);
    
    const session = await loadSession(sessionId, cwd);
    
    const reply = await sessionLocalStorage.run({ sessionId, telegramChatId: ctx.chat.id }, async () => {
      return await runAgent(session, content, {
        onStepFinish({ toolCalls }) {
          toolCalls.forEach(call => {
            console.log(`🔧 [Telegram/Tool Call] ${call.toolName}`);
          });
        }
      });
    });
    
    clearInterval(typingInterval);
    
    // Send response chunked safely
    const chunks = chunkResponse(reply);
    for (const chunk of chunks) {
      await ctx.reply(chunk).catch(async () => {
        // Fallback in case of raw markdown parsing errors
        await ctx.reply(chunk);
      });
    }
  } catch (err: any) {
    console.error('Error running agent via Telegram:', err);
    await ctx.reply(`❌ **Agent Execution Error**: ${err.message}`);
  }
});

// Launch bot and heartbeat writer
bot.launch().then(() => {
  console.log(`🤖 Telegram Bot Gateway is active.`);
  console.log(`Watching OWNER_TELEGRAM_ID: ${ownerId}`);
  
  // Write first heartbeat immediately, then every 5s
  writeHeartbeat();
  setInterval(writeHeartbeat, 5000);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
