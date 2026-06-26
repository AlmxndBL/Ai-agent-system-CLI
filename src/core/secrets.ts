import * as dotenv from 'dotenv';

// Load env variables initially to grab secrets
dotenv.config();

const SENSITIVE_KEYS = [
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GOOGLE_GENERATION_API_KEY',
  'DISCORD_TOKEN',
  'TOTP_SECRET',
  'OWNER_DISCORD_ID',
  'TELEGRAM_TOKEN',
  'OWNER_TELEGRAM_ID'
];

const secretStore = new Map<string, string>();

/**
 * Initializes the Secret Broker:
 * 1. Copies sensitive keys from process.env to an internal secure memory map.
 * 2. Deletes them from process.env to prevent arbitrary code execution / tool call exposure.
 */
export function initSecretBroker(): void {
  for (const key of SENSITIVE_KEYS) {
    const val = process.env[key];
    if (val) {
      secretStore.set(key, val);
      delete process.env[key];
    }
  }
}

/**
 * Gets a secret value from the secure store.
 */
export function getSecret(key: string): string {
  return secretStore.get(key) || '';
}

/**
 * Redacts any sensitive values stored in the broker from a text string.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let redacted = text;
  
  for (const [key, val] of secretStore.entries()) {
    if (!val || val.length < 6) continue; // Skip short secrets to avoid false positives
    
    // Escape regex characters just in case
    const escaped = val.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    const regex = new RegExp(escaped, 'g');
    redacted = redacted.replace(regex, `[REDACTED_${key}]`);
  }
  
  return redacted;
}
