import * as vscode from 'vscode';
import { DeepSeekConfig } from './config';

export interface PromptContext {
  /** Code before the cursor (optionally prefixed with neighboring-file context). */
  prefix: string;
  /** Code after the cursor. */
  suffix: string;
  languageId: string;
  filePath: string;
}

/**
 * Builds the prefix/suffix sent to DeepSeek. The current file is windowed to
 * contextLinesBefore/After around the cursor to keep requests small and fast.
 * When enabled, snippets from other open tabs are prepended ahead of the
 * current file's prefix, similar to Copilot's "neighboring tabs" context.
 */
export async function buildContext(
  document: vscode.TextDocument,
  position: vscode.Position,
  cfg: DeepSeekConfig
): Promise<PromptContext> {
  const startLine = Math.max(0, position.line - cfg.contextLinesBefore);
  const endLine = Math.min(document.lineCount - 1, position.line + cfg.contextLinesAfter);

  const prefixRange = new vscode.Range(new vscode.Position(startLine, 0), position);
  const lastLineLength = document.lineAt(endLine).text.length;
  const suffixRange = new vscode.Range(position, new vscode.Position(endLine, lastLineLength));

  let prefix = document.getText(prefixRange);
  const suffix = document.getText(suffixRange);

  if (cfg.includeOpenFiles && cfg.maxContextFiles > 0) {
    const neighborContext = collectNeighborContext(document, cfg);
    if (neighborContext) {
      prefix = neighborContext + prefix;
    }
  }

  if (cfg.includeClipboard && cfg.maxClipboardChars > 0) {
    const clipboardContext = await collectClipboardContext(cfg);
    if (clipboardContext) {
      prefix = clipboardContext + prefix;
    }
  }

  return {
    prefix,
    suffix,
    languageId: document.languageId,
    filePath: vscode.workspace.asRelativePath(document.uri, false),
  };
}

/**
 * Pulls short snippets from other currently-open text editor tabs, preferring
 * files of the same language as the active document, and packages them as
 * commented "// File: <path>" blocks ahead of the current file's own code.
 */
function collectNeighborContext(activeDocument: vscode.TextDocument, cfg: DeepSeekConfig): string {
  const activeUriStr = activeDocument.uri.toString();
  const seen = new Set<string>([activeUriStr]);

  const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);

  const candidateDocs: vscode.TextDocument[] = [];
  for (const tab of tabs) {
    const input = tab.input;
    if (!(input instanceof vscode.TabInputText)) {
      continue;
    }
    const uriStr = input.uri.toString();
    if (seen.has(uriStr)) {
      continue;
    }
    seen.add(uriStr);

    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uriStr);
    if (doc && !doc.isClosed) {
      candidateDocs.push(doc);
    }
  }

  // Prefer files written in the same language as the file being edited.
  candidateDocs.sort((a, b) => {
    const aMatches = a.languageId === activeDocument.languageId ? 0 : 1;
    const bMatches = b.languageId === activeDocument.languageId ? 0 : 1;
    return aMatches - bMatches;
  });

  const snippets: string[] = [];
  for (const doc of candidateDocs) {
    if (snippets.length >= cfg.maxContextFiles) {
      break;
    }
    let text = doc.getText();
    if (!text.trim()) {
      continue;
    }
    if (text.length > cfg.maxContextCharsPerFile) {
      text = text.slice(0, cfg.maxContextCharsPerFile);
    }
    const relPath = vscode.workspace.asRelativePath(doc.uri, false);
    snippets.push(`// File: ${relPath}\n${text}`);
  }

  if (snippets.length === 0) {
    return '';
  }

  const activePath = vscode.workspace.asRelativePath(activeDocument.uri, false);
  return snippets.join('\n\n') + `\n\n// File: ${activePath}\n`;
}

/**
 * Reads the system clipboard and wraps it as a commented context block.
 * Only text content is included; binary or non-text clipboard data is ignored.
 */
async function collectClipboardContext(cfg: DeepSeekConfig): Promise<string> {
  try {
    const text = await vscode.env.clipboard.readText();
    if (!text || !text.trim()) {
      return '';
    }
    const clipped = text.length > cfg.maxClipboardChars
      ? text.slice(0, cfg.maxClipboardChars) + '\n// [clipboard truncated]'
      : text;
    return `// Clipboard:\n${clipped}\n\n`;
  } catch {
    // Clipboard may be empty, inaccessible, or contain non-text data.
    return '';
  }
}
