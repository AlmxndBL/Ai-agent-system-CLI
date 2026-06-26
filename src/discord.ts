import { Client, GatewayIntentBits, ChannelType, Message } from 'discord.js';
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

const discordToken = getSecret('DISCORD_TOKEN');
const ownerId = getSecret('OWNER_DISCORD_ID');
const totpSecret = getSecret('TOTP_SECRET');

if (!discordToken || !ownerId || !totpSecret) {
  console.error('Error: DISCORD_TOKEN, OWNER_DISCORD_ID, and TOTP_SECRET must be set in your configuration.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ]
});

// Helper to chunk long replies for Discord's 2000 character limit
function chunkResponse(text: string): string[] {
  const maxLimit = 1950;
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

client.once('ready', () => {
  console.log(`🤖 Discord Gateway is active. Logged in as ${client.user?.tag}`);
  console.log(`Watching OWNER_DISCORD_ID: ${ownerId}`);
  
  // Set up watchdog heartbeat file every 5 seconds
  const heartbeatPath = path.join(os.homedir(), '.agent', 'heartbeat');
  setInterval(async () => {
    try {
      await fs.mkdir(path.dirname(heartbeatPath), { recursive: true });
      await fs.writeFile(heartbeatPath, new Date().toISOString(), 'utf8');
    } catch (err: any) {
      console.error('Failed to write watchdog heartbeat:', err.message);
    }
  }, 5000);
});

// Custom out-of-band Discord TOTP approval handler
setApprovalHandler((toolName, args) => {
  return new Promise<boolean>(async (resolve) => {
    const store = sessionLocalStorage.getStore();
    if (!store || !store.discordChannelId) {
      // Fallback if not run through Discord message loop
      resolve(false);
      return;
    }
    
    try {
      const channel: any = await client.channels.fetch(store.discordChannelId);
      if (!channel || !channel.isTextBased()) {
        resolve(false);
        return;
      }
      
      const taintWarning = args.tainted
        ? `⚠️ **[WARNING: TAINTED CONTEXT DETECTED]**\nReasons:\n${args.reasons.map((r: string) => `- ${r}`).join('\n')}\n`
        : '';
        
      const promptMsg = await channel.send(
        `⚠️ **[Approval Required]**\n` +
        taintWarning +
        `**Action**: \`${toolName}\`\n` +
        `**Parameters**:\n` +
        `\`\`\`json\n${JSON.stringify(args, null, 2).substring(0, 1500)}\n\`\`\`\n` +
        `🔓 Enter the 6-digit TOTP code from your Authenticator app within 60 seconds to authorize:`
      );
      
      const filter = (m: Message) => m.author.id === ownerId && /^\d{6}$/.test(m.content.trim());
      const collector = channel.createMessageCollector({
        filter,
        time: 60000,
        max: 1
      });
      
      let verified = false;
      
      collector.on('collect', async (m: Message) => {
        const code = m.content.trim();
        if (verifyTotp(code, totpSecret)) {
          verified = true;
          await m.reply('✅ **TOTP code verified.** Action approved.');
          collector.stop('approved');
          resolve(true);
        } else {
          verified = true;
          await m.reply('❌ **Invalid TOTP code.** Action denied.');
          collector.stop('denied');
          resolve(false);
        }
      });
      
      collector.on('end', async (_collected: any, _reason: string) => {
        if (!verified) {
          await channel.send('⏳ **Approval request timed out.** Action denied.');
          resolve(false);
        }
      });
    } catch (err: any) {
      console.error('Error in Discord approval handler:', err);
      resolve(false);
    }
  });
});

client.on('messageCreate', async (msg) => {
  // Enforce access control list (owner-only check)
  if (msg.author.id !== ownerId || msg.author.bot) return;
  
  const content = msg.content.trim();
  
  // 1. Handle Admin / Security Commands
  if (content === '!panic') {
    await triggerKillSwitch(`discord-${msg.channel.id}`, 'Manual panic command triggered by owner via Discord.');
    await msg.reply('🚨 **PANIC KILL-SWITCH TRIGGERED.** All agent operations are now frozen. System disarmed.');
    return;
  }
  
  if (content.startsWith('!unpanic ')) {
    const code = content.slice(9).trim();
    if (verifyTotp(code, totpSecret)) {
      await resetKillSwitch(`discord-${msg.channel.id}`);
      await msg.reply('🔓 **Kill switch has been successfully reset.** Mutating actions enabled.');
    } else {
      await msg.reply('❌ **Invalid TOTP verification code.** Panic state remains active.');
    }
    return;
  }
  
  if (content === '!status') {
    const isFrozen = await isKillSwitchTriggered();
    const taintState = getSessionTaint(`discord-${msg.channel.id}`);
    const statusMsg = [
      `📊 **Agent Daemon Status**`,
      `• **Kill Switch**: ${isFrozen ? '🚨 **ACTIVE (FROZEN)**' : '✅ Armed & Active'}`,
      `• **Session ID**: \`discord-${msg.channel.id}\``,
      `• **Taint State**: ${taintState.isTainted ? '⚠️ **TAINTED**' : '✅ Clean'}`,
      taintState.isTainted ? `  - Reasons:\n${taintState.reasons.map(r => `    * ${r}`).join('\n')}` : ''
    ].filter(Boolean).join('\n');
    await msg.reply(statusMsg);
    return;
  }
  
  if (content === '!clear-taint') {
    clearTaint(`discord-${msg.channel.id}`);
    await msg.reply('🧹 Session taint memory cleared.');
    return;
  }
  
  // 2. Normal Agent Request Loop
  const isFrozen = await isKillSwitchTriggered();
  if (isFrozen) {
    await msg.reply('🚨 **Operations blocked.** The agent daemon is currently locked down in panic mode. Use `!unpanic <TOTP>` to unlock.');
    return;
  }
  
  // Create mapping of Discord channel -> session ID
  const sessionId = `discord-${msg.channel.id}`;
  const cwd = process.cwd();
  
  try {
    // Show typing status indicator
    await msg.channel.sendTyping();
    const typingInterval = setInterval(() => {
      msg.channel.sendTyping().catch(() => {});
    }, 5000);
    
    const session = await loadSession(sessionId, cwd);
    
    // Run the agent inside sessionLocalStorage context to preserve channel id
    const reply = await sessionLocalStorage.run({ sessionId, discordChannelId: msg.channel.id }, async () => {
      return await runAgent(session, content, {
        onStepFinish({ toolCalls, toolResults }) {
          toolCalls.forEach(call => {
            console.log(`🔧 [Discord/Tool Call] ${call.toolName}`);
          });
        }
      });
    });
    
    clearInterval(typingInterval);
    
    // Send back response chunked
    const chunks = chunkResponse(reply);
    for (const chunk of chunks) {
      await msg.channel.send(chunk);
    }
  } catch (err: any) {
    console.error('Error running agent via Discord:', err);
    await msg.reply(`❌ **Agent Execution Error**: ${err.message}`);
  }
});

client.login(discordToken).catch(err => {
  console.error('Failed to log in to Discord:', err);
  process.exit(1);
});
