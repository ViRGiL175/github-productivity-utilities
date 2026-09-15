import { readFile, stat } from 'node:fs/promises';
import type { Logger } from '../../runtime/Logger.js';

const MAX_CONTEXT_BYTES = 50_000;
const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'] as const;

export interface GeminiGenerateTextInput {
  promptText: string;
  inputText: string;
  contextFiles: string;
  model: string;
}

export interface TextGenerator {
  generate(request: { model: string; systemInstruction: string; text: string }): Promise<string>;
}

export interface ContextFileReader {
  read(paths: string[]): Promise<string>;
}

export class GeminiGenerateText {
  constructor(
    private readonly generator: TextGenerator,
    private readonly files: ContextFileReader,
    private readonly logger: Logger,
  ) {}

  async run(input: GeminiGenerateTextInput): Promise<string> {
    if (!input.promptText.trim()) {
      throw new Error('prompt_text must not be empty');
    }

    const paths = input.contextFiles.split('\n').map((path) => path.trim()).filter(Boolean);
    const context = paths.length > 0 ? await this.files.read(paths) : '';
    const effectiveInput = buildEffectiveInput(input.promptText, input.inputText, context);
    const models = [...new Set([input.model, ...FALLBACK_MODELS].filter(Boolean))];
    const errors: string[] = [];

    for (const model of models) {
      try {
        const text = (await this.generator.generate({
          model,
          systemInstruction: input.promptText,
          text: effectiveInput,
        })).trim();
        if (text) {
          return text;
        }
        errors.push(`${model}: empty response`);
        this.logger.warning(`Gemini model ${model} returned an empty response. Trying the next model.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${model}: ${message}`);
        this.logger.warning(`Gemini model ${model} failed: ${message}. Trying the next model.`);
      }
    }

    throw new Error(`Gemini did not return text after ${models.length} attempts: ${errors.join('; ')}`);
  }
}

export class LocalContextFileReader implements ContextFileReader {
  async read(paths: string[]): Promise<string> {
    let totalBytes = 0;
    const parts: string[] = [];

    for (const path of paths) {
      let metadata;
      try {
        metadata = await stat(path);
      } catch {
        throw new Error(`Context file not found: ${path}`);
      }

      totalBytes += metadata.size;
      if (totalBytes > MAX_CONTEXT_BYTES) {
        throw new Error(`Combined context files exceed ${MAX_CONTEXT_BYTES} bytes. Reduce the number or size of context_files.`);
      }
      parts.push(await readFile(path, 'utf8'));
    }

    return parts.join('\n\n');
  }
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: { message?: string };
}

export class GeminiApiClient implements TextGenerator {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async generate(request: { model: string; systemInstruction: string; text: string }): Promise<string> {
    const response = await this.fetchImplementation(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: request.text }] }],
          system_instruction: { parts: [{ text: request.systemInstruction }] },
        }),
      },
    );
    const rawBody = await response.text();
    let data: GeminiResponse;
    try {
      data = JSON.parse(rawBody) as GeminiResponse;
    } catch {
      throw new Error(`Gemini returned HTTP ${response.status} with invalid JSON.`);
    }

    if (!response.ok) {
      throw new Error(`Gemini returned HTTP ${response.status}: ${data.error?.message ?? 'unknown error'}`);
    }

    return (data.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join('');
  }
}

export function buildEffectiveInput(promptText: string, inputText: string, context: string): string {
  if (inputText && context) {
    return `${inputText}\n\n${context}`;
  }
  return context || inputText || promptText;
}
