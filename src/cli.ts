import * as path from 'path';
import * as crypto from 'crypto';
import * as readline from 'readline';
import * as dotenv from 'dotenv';
import { loadSession } from './core/session';
import { runAgent } from './core/agent';
import { setApprovalHandler } from './core/approval';
import { initSecretBroker, getSecret } from './core/secrets';

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
  
  // Verify API Key based on active provider
  const provider = process.env.MODEL_PROVIDER || 'deepseek';
  if (provider === 'deepseek') {
    if (!getSecret('DEEPSEEK_API_KEY')) {
      console.error('Error: DEEPSEEK_API_KEY is not set in environment or .env file.');
      process.exit(1);
    }
  } else {
    if (!getSecret('GEMINI_API_KEY') && !getSecret('GOOGLE_GENERATION_API_KEY') && !getSecret('GOOGLE_GENERATIVE_AI_API_KEY')) {
      console.error('Error: GEMINI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY is not set in environment or .env file.');
      process.exit(1);
    }
  }
  
  console.log('====================================================');
  console.log(`🤖 AI Agent CLI (Phase 2 - Knowledge Graph)`);
  console.log(`CWD:     ${cwd}`);
  console.log(`Session: ${sessionId}`);
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
        const reply = await runAgent(session, trimmed, {
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
        
        console.log(`\nAgent > ${reply}`);
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
