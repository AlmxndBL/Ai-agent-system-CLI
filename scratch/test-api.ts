import * as dotenv from 'dotenv';
import { generateText } from 'ai';
import { initSecretBroker } from '../src/core/secrets';
import { getModel, getModelId, checkProviderReady, PROVIDERS } from '../src/core/providers';
import type { ProviderName } from '../src/core/providers';

// Dev connectivity smoke test — verifies each configured provider can be reached.
// Providers without credentials are skipped (Hermes/Ollama needs none but must be running).
dotenv.config();
initSecretBroker();

async function testProvider(p: ProviderName) {
  const notReady = checkProviderReady(p);
  if (notReady) {
    console.log(`⏭️  ${p}: skipped — ${notReady}`);
    return;
  }
  console.log(`Testing ${p} (${getModelId(p)})...`);
  try {
    const res = await generateText({
      model: getModel(p),
      prompt: 'Respond with the single word "Success" if you read this.',
    });
    console.log(`✅ ${p}: "${res.text.trim()}"`);
  } catch (err: any) {
    console.error(`❌ ${p} failed: ${err.message}`);
  }
}

async function runTests() {
  console.log('--- API Connectivity Tests (all providers) ---\n');
  for (const p of PROVIDERS) {
    await testProvider(p);
    console.log('----------------------------------------');
  }
  console.log('--- Tests Finished ---');
}

runTests();
