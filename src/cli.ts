import * as path from 'path';
import * as crypto from 'crypto';
import * as readline from 'readline';
import * as dotenv from 'dotenv';
import { loadSession } from './core/session';
import { runAgent } from './core/agent';
import { setApprovalHandler } from './core/approval';
import { initSecretBroker } from './core/secrets';
import { getProviderName, getModelId, checkProviderReady } from './core/providers';

// Load environment variables
dotenv.config();
// Initialize Secret Broker immediately to isolate keys from process.env
initSecretBroker();

// Create safe session ID based on process.cwd()
function getSessionIdForCwd(): string {
  const cwd = process.cwd();
  const hash = crypto.createHash('md5').update(cwd).digest('hex').substring(0, 8);
  const folderName = path.basename(cwd) || 'root';
  return `cli-${folderName}-${hash}`;
}

async function startRepl() {
  const sessionId = getSessionIdForCwd();
  const cwd = process.cwd();
  
  // Verify credentials for the active provider (Hermes/Ollama needs none)
  const provider = getProviderName();
  const credErr = checkProviderReady(provider);
  if (credErr) {
    console.error(`Error: provider '${provider}' is not ready — ${credErr} (set it in your .env file).`);
    process.exit(1);
  }

  console.log('====================================================');
  console.log(`🤖 AI Agent CLI (Phase 2 - Knowledge Graph)`);
  console.log(`CWD:      ${cwd}`);
  console.log(`Session:  ${sessionId}`);
  console.log(`Provider: ${provider} (${getModelId(provider)})`);
  console.log('====================================================\n');
  
  // Load session
  const session = await loadSession(sessionId, cwd);
  console.log(`Session loaded (${session.messages.length} messages in history).\n`);
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  // Register console-based approval handler
  setApprovalHandler((toolName, args) => {
    return new Promise((resolve) => {
      console.log(`\n⚠️  [Approval Required]`);
      console.log(`Action: ${toolName}`);
      console.log(`Params: ${JSON.stringify(args, null, 2)}`);
      
      rl.question('Approve this action? (y/N) > ', (answer) => {
        const clean = answer.trim().toLowerCase();
        if (clean === 'y' || clean === 'yes') {
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  });
  
  const askQuestion = () => {
    rl.question('\nYou > ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        askQuestion();
        return;
      }
      
      if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
        console.log('Goodbye!');
        rl.close();
        process.exit(0);
      }
      
      console.log('\nThinking...');

      try {
        let started = false;
        const reply = await runAgent(session, trimmed, {
          onTextDelta(delta) {
            // Print the prompt prefix lazily so tool-call logs don't split the line
            if (!started) {
              process.stdout.write('\nAgent > ');
              started = true;
            }
            process.stdout.write(delta);
          },
          onStepFinish({ toolCalls, toolResults }) {
            // Log tool calls
            toolCalls.forEach((call: any) => {
              console.log(`🔧 [Tool Call] ${call.toolName}(${JSON.stringify(call.input)})`);
            });
            // Log tool results
            toolResults.forEach((res: any) => {
              const summary = typeof res.output === 'string'
                ? res.output.substring(0, 100).replace(/\r?\n/g, ' ')
                : JSON.stringify(res.output);
              const truncated = summary.length > 100 ? '...' : '';
              console.log(`📊 [Tool Result] ${res.toolName} -> ${summary.substring(0, 100)}${truncated}`);
            });
          }
        });

        if (started) {
          process.stdout.write('\n');
        } else if (reply) {
          // Model produced no streamed text (e.g. tool-only turn) — show the final text
          console.log(`\nAgent > ${reply}`);
        }
      } catch (err: any) {
        console.error(`\n❌ Error: ${err.message}`);
      }
      
      askQuestion();
    });
  };
  
  askQuestion();
}

startRepl().catch(err => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
