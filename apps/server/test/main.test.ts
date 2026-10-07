import { afterEach, describe, expect, it, vi } from 'vitest';
import { providerFrom, translatorFrom } from '../src/index';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('choosing a provider', () => {
  it('uses the one asked for, else whichever key is set, Anthropic first', () => {
    expect(providerFrom({ TEXTSCRIPT_PROVIDER: 'gemini', ANTHROPIC_API_KEY: 'a' })).toBe('gemini');
    expect(providerFrom({ ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g' })).toBe('anthropic');
    expect(providerFrom({ GEMINI_API_KEY: 'g' })).toBe('gemini');
    expect(providerFrom({ GOOGLE_API_KEY: 'g', TEXTSCRIPT_PROVIDER: '' })).toBe('gemini');
    expect(providerFrom({ TEXTSCRIPT_PROVIDER: 'ollama' })).toBe('ollama');
    expect(() => providerFrom({})).toThrow(
      'Set ANTHROPIC_API_KEY or GEMINI_API_KEY, or TEXTSCRIPT_PROVIDER=ollama',
    );
    expect(() => providerFrom({ TEXTSCRIPT_PROVIDER: 'openai' })).toThrow(
      'TEXTSCRIPT_PROVIDER must be anthropic, gemini or ollama, not "openai"',
    );
  });

  it('builds the translator for that provider, with model and effort', () => {
    expect(
      translatorFrom({ GEMINI_API_KEY: 'g', TEXTSCRIPT_EFFORT: 'low', TEXTSCRIPT_VERIFY: 'on' })
        .name,
    ).toBe('gemini:gemini-3.5-flash:low');
    expect(translatorFrom({ TEXTSCRIPT_PROVIDER: 'ollama' }).name).toBe('ollama:qwen3:8b');
    expect(
      translatorFrom({
        TEXTSCRIPT_PROVIDER: 'ollama',
        TEXTSCRIPT_MODEL: 'gpt-oss:20b',
        TEXTSCRIPT_THINK: 'low',
        TEXTSCRIPT_CONTEXT_LENGTH: '32768',
        TEXTSCRIPT_VERIFY: 'on',
        OLLAMA_HOST: 'http://gpu-box:11434',
      }).name,
    ).toBe('ollama:gpt-oss:20b:think-low');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test');
    expect(
      translatorFrom({
        ANTHROPIC_API_KEY: 'test',
        TEXTSCRIPT_MODEL: 'claude-sonnet-5-5',
        TEXTSCRIPT_VERIFY: 'on',
      }).name,
    ).toBe('claude:claude-sonnet-5-5:medium');
    expect(translatorFrom({ ANTHROPIC_API_KEY: 'test', TEXTSCRIPT_EFFORT: 'huge' }).name).toBe(
      'claude:claude-opus-5-5:medium',
    );
  });
});
