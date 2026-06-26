import * as fs from 'fs/promises';
import * as path from 'path';
import { generateText, streamText, ModelMessage, stepCountIs } from 'ai';
import { tools } from '../tools';
import { Session, saveSession, acquireSessionLock, sessionLocalStorage } from './session';
import { getVaultPath, getVaultFiles } from '../tools/obsidian';
import { compactMessages } from './compaction';
import { isKillSwitchTriggered } from './audit';
import { scanAndTaint } from './taint';
import { getModel, getProviderName, getContextWindow } from './providers';

const BASE_SYSTEM_PROMPT = `You are a powerful local-first AI coding agent.
You assist the user in writing, viewing, and maintaining code inside their workspace.
You have access to filesystem tools. Always use them to verify details before making assumptions.
Keep your explanations direct and telegraphic. Do not yap.`;

async function getProjectMemory(sessionId: string): Promise<string> {
  const cwd = process.cwd();
  let memory = `Workspace CWD: ${cwd}\n\n`;
  
  // 1. Scan directory structure
  try {
    const files = await fs.readdir(cwd, { withFileTypes: true });
    const list = files
      .filter(f => !['node_modules', '.git', 'dist', '.agent'].includes(f.name))
      .map(f => ` - ${f.name}${f.isDirectory() ? '/' : ''}`)
      .join('\n');
    memory += `Workspace Layout:\n${list}\n\n`;
  } catch {
    // Ignore directory scan errors
  }
  
  // 2. Read project-memory.md if it exists
  try {
    const pmPath = path.join(cwd, 'project-memory.md');
    const content = await fs.readFile(pmPath, 'utf8');
    // Injected into the system prompt => external DATA, not trusted instructions (§9.4)
    scanAndTaint(sessionId, 'project-memory.md', content);
    memory += `Project Memory Context:\n${content}\n\n`;
  } catch {
    // File not found, ignore
  }

  // 3. Read README.md if it exists
  try {
    const readmePath = path.join(cwd, 'README.md');
    const content = await fs.readFile(readmePath, 'utf8');
    // README is workspace-controlled data; scan before it reaches the model (§9.4)
    scanAndTaint(sessionId, 'README.md', content);
    memory += `README Context:\n${content.substring(0, 1000)}\n\n`;
  } catch {
    // File not found, ignore
  }
  
  return memory;
}

async function getVaultSummary(): Promise<string> {
  try {
    const vaultPath = await getVaultPath();
    const files = await getVaultFiles(vaultPath);
    if (files.length === 0) {
      return 'Obsidian Memory Vault is currently empty.\n\n';
    }
    const list = files
      .map(file => {
        const rel = path.relative(vaultPath, file).replace(/\\/g, '/');
        const cleanName = rel.replace(/\.md$/, '');
        return ` - [[${cleanName}]]`;
      })
      .join('\n');
    return `Obsidian Memory Vault (Knowledge Graph):\n${list}\n\n`;
  } catch {
    return 'Obsidian Memory Vault is not readable.\n\n';
  }
}

export interface AgentOptions {
  onStepFinish?: (event: {
    toolCalls: any[];
    toolResults: any[];
  }) => void;
  // Receives text deltas live as the model streams (e.g. terminal REPL).
  // When omitted, the stream is fully buffered and only the final text is returned.
  onTextDelta?: (delta: string) => void;
}

export async function runAgent(
  session: Session,
  userMessage: string,
  options: AgentOptions = {}
): Promise<string> {
  if (await isKillSwitchTriggered()) {
    throw new Error('Agent execution blocked: Kill switch is active. Run incident mitigation before disarming.');
  }

  const releaseLock = await acquireSessionLock(session.id);
  
  try {
    return await sessionLocalStorage.run({ sessionId: session.id }, async () => {
      // 1. Build system prompt
      const projectMemory = await getProjectMemory(session.id);
      const vaultSummary = await getVaultSummary();
      const systemPrompt = `${BASE_SYSTEM_PROMPT}\n\n${projectMemory}\n\n${vaultSummary}`;
      
      // 2. Add new user message to session
      const updatedMessages: ModelMessage[] = [
        ...session.messages,
        { role: 'user', content: userMessage }
      ];
      
      const provider = getProviderName();
      const model = getModel(provider);
      
      // 3. Call streamText (Vercel AI SDK handles the multi-step tool loop automatically)
      const result = streamText({
        model,
        system: systemPrompt,
        messages: updatedMessages,
        tools,
        stopWhen: stepCountIs(10), // Hard step cap to prevent runaway loops
        onStepFinish({ toolCalls, toolResults }) {
          if (options.onStepFinish && (toolCalls.length > 0 || toolResults.length > 0)) {
            options.onStepFinish({ toolCalls, toolResults });
          }
        }
      });

      // Drain the stream: forward deltas live when a sink is provided (terminal REPL),
      // otherwise consume it to drive the tool loop to completion (chat channels buffer
      // the final reply to respect Discord/Telegram rate limits).
      if (options.onTextDelta) {
        for await (const delta of result.textStream) {
          options.onTextDelta(delta);
        }
      } else {
        await result.consumeStream();
      }

      const finalText = await result.text;
      const response = await result.response;

      // 4. Save new history back to session
      let finalMessages = [
        ...updatedMessages,
        ...response.messages
      ];
      
      // Perform token-window compaction if necessary, using THIS model's context
      // window (§6.4) — compactMessages triggers at ~75% of this value.
      const maxTokens = getContextWindow(provider);
      finalMessages = await compactMessages(finalMessages, maxTokens, async (pruneText) => {
        const summaryRes = await generateText({
          model: getModel(provider),
          prompt: `Briefly summarize the following developer conversation history to preserve memory. Keep key decisions, constraints, and instructions. Respond with the raw summary only:\n\n${pruneText}`
        });
        return summaryRes.text;
      });
      
      session.messages = finalMessages;
      await saveSession(session);

      return finalText;
    });
  } finally {
    releaseLock();
  }
}
