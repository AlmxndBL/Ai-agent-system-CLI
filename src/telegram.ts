import { Telegraf } from 'telegraf';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { verifyTotp } from './core/totp';
import { getSecret, initSecretBroker } from './core/secrets';
import { loadSession, sessionLocalStorage } from './core/session';
import { runAgent } from './core/agent';
import { setApprovalHandler } from './core/approval';
import { isKillSwitchTriggered, triggerKillSwitch, resetKillSwitch } from './core/audit';
import { getSessionTaint, clearTaint } from './core/taint';

// Initialize Secret Broker immediately to cleanse process.env
initSecretBroker();

const telegramToken = getSecret('TELEGRAM_TOKEN');
const ownerId = getSecret('OWNER_TELEGRAM_ID');
const totpSecret = getSecret('TOTP_SECRET');

if (!telegramToken || !ownerId || !totpSecret) {
  console.error('Error: TELEGRAM_TOKEN, OWNER_TELEGRAM_ID, and TOTP_SECRET must be set in your configuration.');
  process.exit(1);
}

const bot = new Telegraf(telegramToken);

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

// Global resolve handler for wait approval loops
let pendingApprovalResolve: ((value: boolean) => void) | null = null;

// Custom out-of-band Telegram TOTP approval handler
setApprovalHandler((toolName, args) => {
  return new Promise<boolean>(async (resolve) => {
    const store = sessionLocalStorage.getStore();
    if (!store || !store.telegramChatId) {
      resolve(false);
      return;
    }
    
    try {
      const taintWarning = args.tainted
        ? `⚠️ **[WARNING: TAINTED CONTEXT DETECTED]**\nReasons:\n${args.reasons.map((r: string) => `- ${r}`).join('\n')}\n`
        : '';
        
      await bot.telegram.sendMessage(
        store.telegramChatId,
        `⚠️ **[Approval Required]**\n` +
        taintWarning +
        `**Action**: \`${toolName}\`\n` +
        `**Parameters**:\n` +
        `\`\`\`json\n${JSON.stringify(args, null, 2).substring(0, 1500)}\n\`\`\`\n` +
        `🔓 Enter the 6-digit TOTP code from your Authenticator app within 60 seconds to authorize:`
      );
      
      pendingApprovalResolve = resolve;
      
      // Auto timeout after 60s
      setTimeout(() => {
        if (pendingApprovalResolve === resolve) {
          bot.telegram.sendMessage(store.telegramChatId!, '⏳ **Approval request timed out.** Action denied.').catch(() => {});
          pendingApprovalResolve = null;
          resolve(false);
        }
      }, 60000);
    } catch (err: any) {
      console.error('Error in Telegram approval handler:', err);
      resolve(false);
    }
  });
});

// Middleware to enforce owner-only check
bot.use(async (ctx, next) => {
  if (ctx.from?.id.toString() !== ownerId) {
    console.log(`Unauthorized access attempt by Discord ID: ${ctx.from?.id}`);
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
  
  if (verifyTotp(code, totpSecret)) {
    await resetKillSwitch(`telegram-${ctx.chat.id}`);
    await ctx.reply('🔓 **Kill switch has been successfully reset.** Mutating actions enabled.');
  } else {
    await ctx.reply('❌ **Invalid TOTP verification code.** Panic state remains active.');
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

// 2. Normal Message Processing Loop
bot.on('text', async (ctx) => {
  const content = ctx.message.text.trim();
  
  // Skip commands since they are handled separately
  if (content.startsWith('/')) return;
  
  // Check if we are waiting for TOTP verification code
  if (pendingApprovalResolve && /^\d{6}$/.test(content)) {
    const code = content;
    const resolve = pendingApprovalResolve;
    pendingApprovalResolve = null;
    
    if (verifyTotp(code, totpSecret)) {
      await ctx.reply('✅ **TOTP code verified.** Action approved.');
      resolve(true);
    } else {
      await ctx.reply('❌ **Invalid TOTP code.** Action denied.');
      resolve(false);
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
