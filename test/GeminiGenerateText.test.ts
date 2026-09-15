import { describe, expect, it, vi } from 'vitest';
import {
  GeminiGenerateText,
  buildEffectiveInput,
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
    const text = await new GeminiGenerateText(
      dependencies.generator,
      dependencies.files,
      dependencies.logger,
    ).run(input);

    expect(text).toBe('Generated text');
    expect(dependencies.generator.generate).toHaveBeenCalledWith({
      model: 'preferred',
      systemInstruction: 'Instruction',
      text: 'Input',
    });
  });

  it('rotates to a fallback model after an empty response', async () => {
    const dependencies = createDependencies(['', 'Fallback text']);
    const text = await new GeminiGenerateText(
      dependencies.generator,
      dependencies.files,
      dependencies.logger,
    ).run(input);

    expect(text).toBe('Fallback text');
    expect(dependencies.generator.generate).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'gemini-2.5-flash' }));
  });

  it('fails explicitly when every model returns an empty response', async () => {
    const dependencies = createDependencies(['', '', '']);
    await expect(
      new GeminiGenerateText(dependencies.generator, dependencies.files, dependencies.logger).run(input),
    ).rejects.toThrow('did not return text');
  });

  it('loads configured context files before generating', async () => {
    const dependencies = createDependencies();
    await new GeminiGenerateText(dependencies.generator, dependencies.files, dependencies.logger).run({
      ...input,
      contextFiles: 'one.md\n two.md ',
    });

    expect(dependencies.files.read).toHaveBeenCalledWith(['one.md', 'two.md']);
    expect(dependencies.generator.generate).toHaveBeenCalledWith(expect.objectContaining({ text: 'Input\n\nFile context' }));
  });
});
