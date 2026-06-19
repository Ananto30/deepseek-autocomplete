import { DeepSeekConfig } from './config';
import { PromptContext } from './contextBuilder';

/**
 * Thin client around two DeepSeek REST endpoints:
 *
 *  - FIM ("fim" mode): POST {baseUrl}/beta/completions with { prompt, suffix }.
 *    This is DeepSeek's Fill-In-the-Middle beta endpoint, purpose-built for
 *    editor-style code completion. No chat wrapping, no "thinking" overhead.
 *
 *  - Chat ("chat" mode): POST {baseUrl}/chat/completions with a system/user
 *    message pair instructing the model to act as a completion engine.
 *    Useful as a fallback if FIM isn't available for some account/model.
 *
 * DeepSeek's V4 models default to "thinking mode" on for chat completions,
 * which is too slow/expensive for inline autocomplete, so chat-mode requests
 * always explicitly send "thinking": { "type": "disabled" } unless the user
 * opts in via the enableThinking setting.
 */
export class DeepSeekClient {
  constructor(private readonly apiKey: string, private readonly cfg: DeepSeekConfig) {}

  async complete(ctx: PromptContext, signal: AbortSignal): Promise<string> {
    if (this.cfg.completionMode === 'chat') {
      return this.completeChat(ctx, signal);
    }
    return this.completeFim(ctx, signal);
  }

  private async completeFim(ctx: PromptContext, signal: AbortSignal): Promise<string> {
    const url = joinUrl(this.cfg.baseUrl, '/beta/completions');
    const body = {
      model: this.cfg.model,
      prompt: ctx.prefix,
      suffix: ctx.suffix,
      max_tokens: this.cfg.maxTokens,
      temperature: this.cfg.temperature,
      stream: false,
    };
    const data = await this.post(url, body, signal);
    const text = data?.choices?.[0]?.text;
    return typeof text === 'string' ? text : '';
  }

  private async completeChat(ctx: PromptContext, signal: AbortSignal): Promise<string> {
    const url = joinUrl(this.cfg.baseUrl, '/chat/completions');

    const systemPrompt =
      'You are a low-latency code completion engine embedded in a code editor, ' +
      'equivalent to GitHub Copilot. You will be shown the code immediately BEFORE ' +
      'the cursor and the code immediately AFTER the cursor. Respond with ONLY the ' +
      'text that should be inserted at the cursor so that BEFORE + your completion + ' +
      'AFTER reads as correct, idiomatic code. Never repeat BEFORE or AFTER. Never use ' +
      'markdown code fences. Never add explanations, comments about your reasoning, or ' +
      `surrounding prose - output raw code only. File: ${ctx.filePath} (language: ${ctx.languageId}).`;

    const userPrompt = `BEFORE:\n${ctx.prefix}\n\nAFTER:\n${ctx.suffix}\n\nINSERT:`;

    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: this.cfg.maxTokens,
      temperature: this.cfg.temperature,
      stream: false,
      thinking: { type: this.cfg.enableThinking ? 'enabled' : 'disabled' },
    };

    const data = await this.post(url, body, signal);
    const raw = data?.choices?.[0]?.message?.content;
    return typeof raw === 'string' ? stripCodeFences(raw) : '';
  }

  private async post(url: string, body: unknown, signal: AbortSignal): Promise<any> {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorBody = await safeText(response);
      throw new Error(`DeepSeek API error ${response.status} ${response.statusText}: ${errorBody}`);
    }

    return response.json();
  }
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}

/** Strips a single leading/trailing ``` fence in case the model wraps its answer anyway. */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n?```$/);
  return match ? match[1] : text;
}

async function safeText(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return body.length > 500 ? body.slice(0, 500) + '\u2026' : body;
  } catch {
    return '<no response body>';
  }
}
