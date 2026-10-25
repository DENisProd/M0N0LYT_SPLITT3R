import { getSettings } from './store.ts';

// Локальная LLM через Ollama: ответ строго JSON по схеме. Облачные API не используются.

export async function chatJson<T>(system: string, prompt: string, schema: object, signal?: AbortSignal): Promise<T> {
  const { ollamaUrl, ollamaModel, llmTimeoutMs } = await getSettings();
  const res = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(llmTimeoutMs)]) : AbortSignal.timeout(llmTimeoutMs),
    body: JSON.stringify({
      model: ollamaModel,
      stream: false,
      format: schema,
      options: { temperature: 0.2 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { message?: { content?: string } };
  return JSON.parse(body.message?.content ?? '{}') as T;
}
