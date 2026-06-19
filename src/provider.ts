import * as vscode from 'vscode';
import { DeepSeekClient } from './deepseekClient';
import { buildContext } from './contextBuilder';
import { getApiKey, getConfig } from './config';
import { StatusBar } from './statusBar';

/**
 * The actual ghost-text provider. VS Code calls provideInlineCompletionItems
 * on (roughly) every keystroke/cursor move; this is the same extension point
 * GitHub Copilot's editor integration is built on (vscode.languages.
 * registerInlineCompletionItemProvider), so the suggestions render with the
 * same inline "Tab to accept" ghost text UX.
 */
export class DeepSeekInlineProvider implements vscode.InlineCompletionItemProvider {
  // Tiny one-entry cache so moving the cursor back and forth over the same
  // spot, or a request that resolves after the same prefix is re-requested,
  // doesn't trigger a duplicate API call.
  private lastCacheKey: string | undefined;
  private lastCacheValue: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext, private readonly statusBar: StatusBar) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    inlineContext: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const cfg = getConfig();

    if (!cfg.enabled) {
      return undefined;
    }
    if (cfg.disabledLanguages.includes(document.languageId)) {
      return undefined;
    }

    const apiKey = await getApiKey(this.context);
    if (!apiKey) {
      // The status bar already advertises "needs API key"; stay quiet here
      // so we don't pop up a message on every keystroke.
      return undefined;
    }

    // Debounce automatic (typing-triggered) requests so we don't fire one
    // API call per keystroke. Manually invoked requests (Alt+\) skip this.
    if (inlineContext.triggerKind === vscode.InlineCompletionTriggerKind.Automatic && cfg.debounceMs > 0) {
      await sleep(cfg.debounceMs);
      if (token.isCancellationRequested) {
        return undefined;
      }
    }

    const promptCtx = buildContext(document, position, cfg);

    // Cache key: enough of the trailing prefix + leading suffix to be a
    // reasonable fingerprint of "the same edit point", without hashing the
    // entire (possibly large) context on every keystroke.
    const cacheKey = `${cfg.model}|${cfg.completionMode}|${promptCtx.prefix.slice(-800)}|${promptCtx.suffix.slice(0, 200)}`;
    if (this.lastCacheKey === cacheKey && this.lastCacheValue !== undefined) {
      return this.toItems(this.lastCacheValue, position);
    }

    const controller = new AbortController();
    const disposable = token.onCancellationRequested(() => controller.abort());
    const timeoutHandle = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);

    this.statusBar.setLoading();
    try {
      const client = new DeepSeekClient(apiKey, cfg);
      const completion = await client.complete(promptCtx, controller.signal);

      if (token.isCancellationRequested) {
        return undefined;
      }

      const cleaned = this.postProcess(completion, document, position);
      this.lastCacheKey = cacheKey;
      this.lastCacheValue = cleaned;
      this.statusBar.setReady();

      if (!cleaned) {
        return undefined;
      }
      return this.toItems(cleaned, position);
    } catch (err) {
      if (controller.signal.aborted && !cfg.disabledLanguages.includes(document.languageId)) {
        // Either we timed out or the user kept typing \u2014 either way, not a
        // real error worth surfacing.
        this.statusBar.setReady();
        return undefined;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error('[DeepSeek Autocomplete] request failed:', message);
      this.statusBar.setError(message);
      return undefined;
    } finally {
      clearTimeout(timeoutHandle);
      disposable.dispose();
    }
  }

  /**
   * Trims an obvious case where the model echoes back text that's already
   * sitting right after the cursor (a common FIM/completion failure mode).
   */
  private postProcess(text: string, document: vscode.TextDocument, position: vscode.Position): string {
    if (!text) {
      return '';
    }
    const restOfLine = document.lineAt(position.line).text.slice(position.character);
    if (restOfLine.trim().length > 0 && text.endsWith(restOfLine)) {
      return text.slice(0, text.length - restOfLine.length);
    }
    return text;
  }

  private toItems(text: string, position: vscode.Position): vscode.InlineCompletionItem[] {
    const range = new vscode.Range(position, position);
    return [new vscode.InlineCompletionItem(text, range)];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
