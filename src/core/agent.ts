import * as fs from 'fs/promises';
import * as path from 'path';
import { generateText, ModelMessage, stepCountIs } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { tools } from '../tools';
import { Session, saveSession, acquireSessionLock, sessionLocalStorage } from './session';
import { getVaultPath, getVaultFiles } from '../tools/obsidian';
import { getSecret } from './secrets';
import { compactMessages } from './compaction';
import { isKillSwitchTriggered } from './audit';

// Create instantiated SDK providers with secure credentials from Secret Broker
const getDeepSeekModel = (modelName: string) => {
  const apiKey = getSecret('DEEPSEEK_API_KEY');
  return createDeepSeek({ apiKey })(modelName);
};

const getGoogleModel = (modelName: string) => {
  // Try GEMINI_API_KEY first, fallback to GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_GENERATION_API_KEY
  const apiKey = getSecret('GEMINI_API_KEY') || 
                 getSecret('GOOGLE_GENERATIVE_AI_API_KEY') || 
                 getSecret('GOOGLE_GENERATION_API_KEY');
  return createGoogleGenerativeAI({ apiKey })(modelName);
};

const BASE_SYSTEM_PROMPT = `You are a powerful local-first AI coding agent.
You assist the user in writing, viewing, and maintaining code inside their workspace.
You have access to filesystem tools. Always use them to verify details before making assumptions.
Keep your explanations direct and telegraphic. Do not yap.`;

async function getProjectMemory(): Promise<string> {
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
    memory += `Project Memory Context:\n${content}\n\n`;
  } catch {
    // File not found, ignore
  }
  
  // 3. Read README.md if it exists
  try {
    const readmePath = path.join(cwd, 'README.md');
    const content = await fs.readFile(readmePath, 'utf8');
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
      const projectMemory = await getProjectMemory();
      const vaultSummary = await getVaultSummary();
      const systemPrompt = `${BASE_SYSTEM_PROMPT}\n\n${projectMemory}\n\n${vaultSummary}`;
      
      // 2. Add new user message to session
      const updatedMessages: ModelMessage[] = [
        ...session.messages,
        { role: 'user', content: userMessage }
      ];
      
      const provider = process.env.MODEL_PROVIDER || 'deepseek';
      let model;
      if (provider === 'deepseek') {
        const modelName = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
        model = getDeepSeekModel(modelName);
      } else {
        const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
        model = getGoogleModel(modelName);
      }
      
      // 3. Call generateText (Vercel AI SDK handles tool loop automatically)
      const result = await generateText({
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
      
      // 4. Save new history back to session
      let finalMessages = [
        ...updatedMessages,
        ...result.response.messages
      ];
      
      // Perform token window compaction if necessary
      const maxTokens = parseInt(process.env.MAX_SESSION_TOKENS || '25000', 10);
      finalMessages = await compactMessages(finalMessages, maxTokens, async (pruneText) => {
        const summarizeModel = provider === 'deepseek'
          ? getDeepSeekModel(process.env.DEEPSEEK_MODEL || 'deepseek-chat')
          : getGoogleModel(process.env.GEMINI_MODEL || 'gemini-2.5-flash');
          
        const summaryRes = await generateText({
          model: summarizeModel,
          prompt: `Briefly summarize the following developer conversation history to preserve memory. Keep key decisions, constraints, and instructions. Respond with the raw summary only:\n\n${pruneText}`
        });
        return summaryRes.text;
      });
      
      session.messages = finalMessages;
      await saveSession(session);
      
      return result.text;
    });
  } finally {
    releaseLock();
  }
}
