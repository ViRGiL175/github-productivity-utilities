import { GeminiApiClient, geminiGenerateText, LocalContextFileReader } from '../automations/gemini-generate-text/GeminiGenerateText.ts';
import { logger, required } from './environment.ts';

export async function run(core: { setOutput(name: string, value: string): void }): Promise<void> {
  const text = await geminiGenerateText({
    promptText: required('PROMPT_TEXT'),
    inputText: process.env.INPUT_TEXT ?? '',
    contextFiles: process.env.CONTEXT_FILES ?? '',
    model: required('MODEL'),
  }, new GeminiApiClient(required('GEMINI_API_KEY')), new LocalContextFileReader(), logger);
  core.setOutput('text', text);
}
