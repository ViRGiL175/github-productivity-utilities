import { readFile, stat } from 'node:fs/promises';
import type { Logger } from '../../runtime/Logger.ts';

const MAX_CONTEXT_BYTES = 50_000;
const FALLBACK_MODELS = ['gemini-3.5-flash-lite'] as const;
const MAX_GENERATION_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;

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

export async function geminiGenerateText(
input: GeminiGenerateTextInput,
generator: TextGenerator,
files: ContextFileReader,
logger: Logger,
): Promise<string> {
  if (!input.promptText.trim()) {
    throw new Error('prompt_text must not be empty');
  }

  const paths = input.contextFiles.split('\n').map((path) => path.trim()).filter(Boolean);
  const context = paths.length > 0 ? await files.read(paths) : '';
  const effectiveInput = buildEffectiveInput(input.promptText, input.inputText, context);
  const models = [...new Set([input.model, ...FALLBACK_MODELS].filter(Boolean))];
  const errors: string[] = [];

  for (const model of models) {
    try {
      const text = (await generator.generate({
        model,
        systemInstruction: input.promptText,
        text: effectiveInput,
      })).trim();
      if (text) {
        return text;
      }
      errors.push(`${model}: empty response`);
      logger.warning(`Gemini model ${model} returned an empty response. Trying the next model.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${model}: ${message}`);
      logger.warning(`Gemini model ${model} failed: ${message}. Trying the next model.`);
    }
  }

  throw new Error(`Gemini did not return text after ${models.length} attempts: ${errors.join('; ')}`);
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
  error?: {
    message?: string;
    details?: Array<{ '@type'?: string; retryDelay?: string }>;
  };
}

export class GeminiApiClient implements TextGenerator {
  private readonly apiKey: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly wait: (milliseconds: number) => Promise<void>;
  constructor(
    apiKey: string,
    fetchImplementation: typeof fetch = fetch,
    wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {
    this.apiKey = apiKey;
    this.fetchImplementation = fetchImplementation;
    this.wait = wait;
  }

  async generate(request: { model: string; systemInstruction: string; text: string }): Promise<string> {
    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt += 1) {
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

      if (response.ok) {
        return (data.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join('');
      }

      const message = data.error?.message ?? 'unknown error';
      const canRetry = response.status === 429 || response.status >= 500;
      if (!canRetry || attempt === MAX_GENERATION_ATTEMPTS) {
        throw new Error(`Gemini returned HTTP ${response.status}: ${message}`);
      }
      await this.wait(resolveRetryDelayMs(response, data, attempt));
    }

    throw new Error('Gemini request exhausted its retry attempts.');
  }
}

function resolveRetryDelayMs(response: Response, data: GeminiResponse, attempt: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return capRetryDelay(seconds * 1_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return capRetryDelay(Math.max(0, date - Date.now()));
  }

  const retryInfo = data.error?.details?.find((detail) => detail.retryDelay)?.retryDelay;
  const duration = retryInfo?.match(/^([0-9]+(?:\.[0-9]+)?)s$/);
  if (duration?.[1]) return capRetryDelay(Number(duration[1]) * 1_000);
  return capRetryDelay(DEFAULT_RETRY_DELAY_MS * 2 ** (attempt - 1));
}

function capRetryDelay(milliseconds: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, Math.ceil(milliseconds)));
}

export function buildEffectiveInput(promptText: string, inputText: string, context: string): string {
  if (inputText && context) {
    return `${inputText}\n\n${context}`;
  }
  return context || inputText || promptText;
}
