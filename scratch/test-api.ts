import * as dotenv from 'dotenv';
import { generateText } from 'ai';
import { google } from '@ai-sdk/google';
import { deepseek } from '@ai-sdk/deepseek';
import { anthropic } from '@ai-sdk/anthropic';

dotenv.config();

// Set Google API key fallbacks
if (process.env.GEMINI_API_KEY) {
  if (!process.env.GOOGLE_GENERATION_API_KEY) process.env.GOOGLE_GENERATION_API_KEY = process.env.GEMINI_API_KEY;
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY;
}

async function testGoogle() {
  console.log('Testing Google Gemini API...');
  try {
    const response = await generateText({
      model: google('gemini-2.5-flash'),
      prompt: 'Respond with the word "Success" if you read this.',
    });
    console.log(`✅ Google Gemini Success! Response: "${response.text.trim()}"`);
  } catch (err: any) {
    console.error(`❌ Google Gemini Failed: ${err.message}`);
  }
}

async function testDeepSeek() {
  console.log('Testing DeepSeek API...');
  try {
    const response = await generateText({
      model: deepseek('deepseek-chat'),
      prompt: 'Respond with the word "Success" if you read this.',
    });
    console.log(`✅ DeepSeek Success! Response: "${response.text.trim()}"`);
  } catch (err: any) {
    console.error(`❌ DeepSeek Failed: ${err.message}`);
  }
}

async function testAnthropic() {
  console.log('Testing Anthropic Claude API...');
  try {
    const response = await generateText({
      model: anthropic('claude-3-5-sonnet-20241022'),
      prompt: 'Respond with the word "Success" if you read this.',
    });
    console.log(`✅ Anthropic Claude Success! Response: "${response.text.trim()}"`);
  } catch (err: any) {
    console.error(`❌ Anthropic Claude Failed: ${err.message}`);
  }
}

async function runTests() {
  console.log('--- Starting API Connectivity Tests ---\n');
  await testGoogle();
  console.log('\n----------------------------------------\n');
  await testDeepSeek();
  console.log('\n----------------------------------------\n');
  await testAnthropic();
  console.log('\n--- Tests Finished ---');
}

runTests();
