import * as vscode from 'vscode';
import { getApiKey, getConfig } from './config';
import { buildContext } from './contextBuilder';
import { DeepSeekClient } from './deepseekClient';
import type { EditTracker } from './editTracker';
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

  constructor(private readonly context: vscode.ExtensionContext, private readonly statusBar: StatusBar, private readonly editTracker: EditTracker) { }

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

    // Only provide suggestions in actual editor files (file:// or untitled:),
    // not in extension UIs like chat windows, output panels, webviews, etc.
    if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
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

    const promptCtx = await buildContext(document, position, cfg, this.editTracker);

    // Cache key: enough of the trailing prefix + leading suffix to be a
    // reasonable fingerprint of "the same edit point", without hashing the
    // entire (possibly large) context on every keystroke.
    const cacheKey = `${cfg.model}|${cfg.completionMode}|${promptCtx.prefix.slice(-800)}|${promptCtx.suffix.slice(0, 200)}`;
    if (this.lastCacheKey === cacheKey && this.lastCacheValue !== undefined) {
      return this.toItems(this.lastCacheValue, position, promptCtx.replaceRange);
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

      const cleaned = this.postProcess(completion, document, position, promptCtx.replaceRange);
      this.lastCacheKey = cacheKey;
      this.lastCacheValue = cleaned;
      this.statusBar.setReady();

      if (!cleaned) {
        return undefined;
      }
      return this.toItems(cleaned, position, promptCtx.replaceRange);
    } catch (err) {
      if (controller.signal.aborted && !cfg.disabledLanguages.includes(document.languageId)) {
        // Either we timed out or the user kept typing - either way, not a
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
   *
   * In rename-replacement mode (replaceRange is set) the completion should
   */
  private postProcess(text: string, document: vscode.TextDocument, position: vscode.Position, replaceRange?: vscode.Range): string {
    if (!text) {
      return '';
    }
    if (replaceRange) {
      // Take only the leading identifier token — prevents "getUser(param)" when
      // "(param)" is already in the suffix after the replaced word.
      const match = text.match(/^([A-Za-z_$][A-Za-z0-9_$]*)/);
      return match ? match[1] : text.split(/[\s(,;)]/)[0] ?? text;
    }
    const restOfLine = document.lineAt(position.line).text.slice(position.character);
    if (restOfLine.trim().length > 0 && text.endsWith(restOfLine)) {
      return text.slice(0, text.length - restOfLine.length);
    }
    return text;
  }

  private toItems(text: string, position: vscode.Position, replaceRange?: vscode.Range): vscode.InlineCompletionItem[] {
    const range = replaceRange ?? new vscode.Range(position, position);
    return [new vscode.InlineCompletionItem(text, range)];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
