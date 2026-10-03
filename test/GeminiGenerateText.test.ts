import { describe, expect, it, vi } from 'vitest';
import {
  geminiGenerateText,
  buildEffectiveInput,
  GeminiApiClient,
  type ContextFileReader,
  type TextGenerator,
} from '../src/automations/gemini-generate-text/GeminiGenerateText.js';
import type { Logger } from '../src/runtime/Logger.js';

function createDependencies(responses: string[] = ['Generated text']) {
  const generator: TextGenerator = {
    generate: vi.fn().mockImplementation(async () => responses.shift() ?? ''),
  };
  const files: ContextFileReader = { read: vi.fn().mockResolvedValue('File context') };
  const logger: Logger = { info: vi.fn(), warning: vi.fn() };
  return { generator, files, logger };
}

const input = { promptText: 'Instruction', inputText: 'Input', contextFiles: '', model: 'preferred' };

describe('GeminiGenerateText', () => {
  it('combines input and file context using the existing contract', () => {
    expect(buildEffectiveInput('Prompt', 'Input', 'Context')).toBe('Input\n\nContext');
    expect(buildEffectiveInput('Prompt', '', 'Context')).toBe('Context');
    expect(buildEffectiveInput('Prompt', '', '')).toBe('Prompt');
  });

  it('returns the requested model response', async () => {
    const dependencies = createDependencies();
    const text = await geminiGenerateText(input, dependencies.generator, dependencies.files, dependencies.logger);

    expect(text).toBe('Generated text');
    expect(dependencies.generator.generate).toHaveBeenCalledWith({
      model: 'preferred',
      systemInstruction: 'Instruction',
      text: 'Input',
    });
  });

  it('rotates to a fallback model after an empty response', async () => {
    const dependencies = createDependencies(['', 'Fallback text']);
    const text = await geminiGenerateText(input, dependencies.generator, dependencies.files, dependencies.logger);

    expect(text).toBe('Fallback text');
    expect(dependencies.generator.generate).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'gemini-3.5-flash-lite' }));
  });

  it('fails explicitly when every model returns an empty response', async () => {
    const dependencies = createDependencies(['', '']);
    await expect(
      geminiGenerateText(input, dependencies.generator, dependencies.files, dependencies.logger),
    ).rejects.toThrow('did not return text');
  });

  it('retries the same model after the delay supplied with HTTP 429', async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: {
        message: 'rate limited',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.25s' }],
      } }), { status: 429, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Ready' }] } }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    const wait = vi.fn().mockResolvedValue(undefined);
    const client = new GeminiApiClient('secret', fetchImplementation, wait);

    await expect(client.generate({ model: 'gemini-3.5-flash', systemInstruction: 'Do it', text: 'Input' })).resolves.toBe('Ready');
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(250);
  });

  it('does not retry a permanent client error', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'bad request' } }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    }));
    const wait = vi.fn().mockResolvedValue(undefined);
    const client = new GeminiApiClient('secret', fetchImplementation, wait);

    await expect(client.generate({ model: 'gemini-3.5-flash', systemInstruction: 'Do it', text: 'Input' }))
      .rejects.toThrow('HTTP 400');
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('loads configured context files before generating', async () => {
    const dependencies = createDependencies();
    await geminiGenerateText({
      ...input,
      contextFiles: 'one.md\n two.md ',
    }, dependencies.generator, dependencies.files, dependencies.logger);

    expect(dependencies.files.read).toHaveBeenCalledWith(['one.md', 'two.md']);
    expect(dependencies.generator.generate).toHaveBeenCalledWith(expect.objectContaining({ text: 'Input\n\nFile context' }));
  });
});
