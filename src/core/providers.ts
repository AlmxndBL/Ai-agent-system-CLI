import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { getSecret } from './secrets';

// Provider abstraction (design §8): one loop drives every model. Provider keys are
// pulled from the Secret Broker (§9.5) so they never live in the agent/bash env.
export type ProviderName = 'claude' | 'gemini' | 'deepseek' | 'hermes';

export const PROVIDERS: ProviderName[] = ['claude', 'gemini', 'deepseek', 'hermes'];

// Default model id per provider — override via env. Verify the latest ids at deploy
// time; model versions move fast (§8 note).
const DEFAULT_MODEL_IDS: Record<ProviderName, string> = {
  claude: 'claude-sonnet-4-6',
  gemini: 'gemini-2.5-flash',
  deepseek: 'deepseek-chat',
  hermes: 'hermes4',
};

const MODEL_ENV_KEY: Record<ProviderName, string> = {
  claude: 'CLAUDE_MODEL',
  gemini: 'GEMINI_MODEL',
  deepseek: 'DEEPSEEK_MODEL',
  hermes: 'HERMES_MODEL',
};

// Approx context window (tokens) per provider. Used to size the compaction threshold
// per-model (§6.4): a single constant overflows local models and wastes Gemini's window.
const CONTEXT_WINDOW: Record<ProviderName, number> = {
  claude: 200_000,
  gemini: 1_000_000,
  deepseek: 64_000,
  hermes: 8_192, // local Ollama — conservative
};

export function getProviderName(): ProviderName {
  const raw = (process.env.MODEL_PROVIDER || 'deepseek').toLowerCase();
  if (raw === 'claude' || raw === 'anthropic') return 'claude';
  if (raw === 'gemini' || raw === 'google') return 'gemini';
  if (raw === 'hermes' || raw === 'ollama') return 'hermes';
  return 'deepseek';
}

export function getModelId(provider: ProviderName): string {
  return process.env[MODEL_ENV_KEY[provider]] || DEFAULT_MODEL_IDS[provider];
}

/**
 * Build a LanguageModel for the given provider, pulling credentials from the broker.
 */
export function getModel(provider: ProviderName = getProviderName(), modelId?: string): LanguageModel {
  const id = modelId || getModelId(provider);

  switch (provider) {
    case 'claude': {
      const apiKey = getSecret('ANTHROPIC_API_KEY') || getSecret('CLAUDE_API_KEY');
      return createAnthropic({ apiKey })(id);
    }
    case 'gemini': {
      const apiKey =
        getSecret('GEMINI_API_KEY') ||
        getSecret('GOOGLE_GENERATIVE_AI_API_KEY') ||
        getSecret('GOOGLE_GENERATION_API_KEY');
      return createGoogleGenerativeAI({ apiKey })(id);
    }
    case 'hermes': {
      // Local Ollama via its OpenAI-compatible endpoint — privacy/offline goal (§1.2).
      const baseURL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
      return createOpenAICompatible({ name: 'ollama', baseURL, apiKey: 'ollama' })(id);
    }
    case 'deepseek':
    default: {
      const apiKey = getSecret('DEEPSEEK_API_KEY');
      return createDeepSeek({ apiKey })(id);
    }
  }
}

/**
 * Full context window for a provider (or the MAX_SESSION_TOKENS override). The
 * compaction routine triggers at ~75% of this value (§6.4).
 */
export function getContextWindow(provider: ProviderName = getProviderName()): number {
  const base = CONTEXT_WINDOW[provider];
  const override = process.env.MAX_SESSION_TOKENS;
  if (override) {
    const n = parseInt(override, 10);
    if (!Number.isNaN(n) && n > 0) {
      // Treat the override as a CAP that can only tighten the window, never exceed it.
      // A single global value (e.g. 25k) must not overflow a small local model like
      // Hermes/Ollama (~8k) — exactly the failure §6.4 warns about.
      return Math.min(n, base);
    }
  }
  return base;
}

/**
 * Returns null if the provider has the credentials it needs, otherwise a message
 * describing what's missing. Hermes (local Ollama) needs no key.
 */
export function checkProviderReady(provider: ProviderName): string | null {
  switch (provider) {
    case 'claude':
      return getSecret('ANTHROPIC_API_KEY') || getSecret('CLAUDE_API_KEY')
        ? null
        : 'ANTHROPIC_API_KEY is not set';
    case 'gemini':
      return getSecret('GEMINI_API_KEY') ||
        getSecret('GOOGLE_GENERATIVE_AI_API_KEY') ||
        getSecret('GOOGLE_GENERATION_API_KEY')
        ? null
        : 'GEMINI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY is not set';
    case 'hermes':
      return null; // local, no API key required
    case 'deepseek':
    default:
      return getSecret('DEEPSEEK_API_KEY') ? null : 'DEEPSEEK_API_KEY is not set';
  }
}

export function parseProviderName(raw: string): ProviderName | null {
  const v = raw.trim().toLowerCase();
  if (v === 'claude' || v === 'anthropic') return 'claude';
  if (v === 'gemini' || v === 'google') return 'gemini';
  if (v === 'deepseek') return 'deepseek';
  if (v === 'hermes' || v === 'ollama' || v === 'local') return 'hermes';
  return null;
}

/**
 * Executes a callback with the primary provider, falling back to other configured
 * and ready providers in case of failure.
 */
export async function runWithProviderFallback<T>(
  onTry: (provider: ProviderName, model: LanguageModel) => Promise<T>,
  onWarning?: (provider: ProviderName, error: Error) => void
): Promise<{ result: T; providerUsed: ProviderName }> {
  const primaryProvider = getProviderName();
  
  // Build fallback list: primary first, then others that are ready
  const fallbacks: ProviderName[] = [primaryProvider];
  PROVIDERS.forEach(p => {
    if (p !== primaryProvider && checkProviderReady(p) === null) {
      fallbacks.push(p);
    }
  });
  
  let lastError: any;
  for (const provider of fallbacks) {
    try {
      const model = getModel(provider);
      const res = await onTry(provider, model);
      return { result: res, providerUsed: provider };
    } catch (err: any) {
      if (onWarning) {
        onWarning(provider, err);
      } else {
        console.warn(`⚠️ Provider '${provider}' failed: ${err.message}. Trying next fallback...`);
      }
      lastError = err;
    }
  }
  
  throw new Error(`All configured providers failed. Last error: ${lastError?.message}`);
}
