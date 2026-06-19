import * as vscode from 'vscode';

export const EXT_ID = 'deepseekAutocomplete';

const SECRET_KEY = 'deepseekAutocomplete.apiKey';

export type CompletionMode = 'fim' | 'chat';

export interface DeepSeekConfig {
  enabled: boolean;
  model: string;
  baseUrl: string;
  completionMode: CompletionMode;
  enableThinking: boolean;
  maxTokens: number;
  temperature: number;
  debounceMs: number;
  requestTimeoutMs: number;
  contextLinesBefore: number;
  contextLinesAfter: number;
  includeOpenFiles: boolean;
  maxContextFiles: number;
  maxContextCharsPerFile: number;
  includeClipboard: boolean;
  maxClipboardChars: number;
  disabledLanguages: string[];
}

/** Reads the current settings under the deepseekAutocomplete.* namespace. */
export function getConfig(): DeepSeekConfig {
  const cfg = vscode.workspace.getConfiguration(EXT_ID);
  return {
    enabled: cfg.get<boolean>('enabled', true),
    model: cfg.get<string>('model', 'deepseek-v4-flash'),
    baseUrl: cfg.get<string>('baseUrl', 'https://api.deepseek.com'),
    completionMode: cfg.get<CompletionMode>('completionMode', 'fim'),
    enableThinking: cfg.get<boolean>('enableThinking', false),
    maxTokens: cfg.get<number>('maxTokens', 256),
    temperature: cfg.get<number>('temperature', 0.2),
    debounceMs: cfg.get<number>('debounceMs', 300),
    requestTimeoutMs: cfg.get<number>('requestTimeoutMs', 8000),
    contextLinesBefore: cfg.get<number>('contextLinesBefore', 100),
    contextLinesAfter: cfg.get<number>('contextLinesAfter', 50),
    includeOpenFiles: cfg.get<boolean>('includeOpenFiles', true),
    maxContextFiles: cfg.get<number>('maxContextFiles', 3),
    maxContextCharsPerFile: cfg.get<number>('maxContextCharsPerFile', 1500),
    includeClipboard: cfg.get<boolean>('includeClipboard', true),
    maxClipboardChars: cfg.get<number>('maxClipboardChars', 2000),
    disabledLanguages: cfg.get<string[]>('disabledLanguages', []),
  };
}

/**
 * Resolves the API key. Checks the DEEPSEEK_API_KEY environment variable first
 * (handy for local development), then falls back to VS Code's encrypted
 * SecretStorage, which is where the "DeepSeek: Set API Key" command saves it.
 * The key is intentionally never stored in settings.json.
 */
export async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const fromEnv = process.env.DEEPSEEK_API_KEY;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.trim();
  }
  return context.secrets.get(SECRET_KEY);
}

export async function setApiKey(context: vscode.ExtensionContext, key: string): Promise<void> {
  await context.secrets.store(SECRET_KEY, key);
}

export async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_KEY);
}
