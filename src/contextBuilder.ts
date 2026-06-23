import * as vscode from 'vscode';
import { DeepSeekConfig } from './config';
import type { EditRecord, EditTracker } from './editTracker';

export interface PromptContext {
  /** Code before the cursor (optionally prefixed with neighboring-file context). */
  prefix: string;
  /** Code after the cursor. */
  suffix: string;
  languageId: string;
  filePath: string;
  /**
   * When the user has a recently-renamed identifier selected, this is the
   * range of that selection so the inline completion replaces the whole word
   * rather than inserting at the cursor.
   */
  replaceRange?: vscode.Range;
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
  cfg: DeepSeekConfig,
  editTracker?: EditTracker
): Promise<PromptContext> {
  // Scope-aware prefix start: prefer the enclosing function/class boundary
  // rather than an arbitrary line-count cut that may land mid-function.
  // The search is bounded by cfg.contextLinesBefore so no extra tokens are added.
  const normalStart = Math.max(0, position.line - cfg.contextLinesBefore);
  const startLine = findEnclosingScopeStart(document, position, normalStart);

  const endLine = Math.min(document.lineCount - 1, position.line + cfg.contextLinesAfter);

  const prefixRange = new vscode.Range(new vscode.Position(startLine, 0), position);
  const lastLineLength = document.lineAt(endLine).text.length;
  const suffixRange = new vscode.Range(position, new vscode.Position(endLine, lastLineLength));

  let prefix = document.getText(prefixRange);
  let suffix = document.getText(suffixRange);

  // Contextual annotations — prepended innermost-first so they sit immediately
  // before the current file code where the model can use them most directly.
  const recentEdits = editTracker?.getRecentEdits(document.uri) ?? [];
  const editCtx = buildEditHistoryContext(document, recentEdits);

  // Rename-replacement mode: when the user has selected (e.g. double-clicked)
  // an identifier that appears in the edit history as a renamed symbol, recompute
  // prefix/suffix around the selection so FIM is asked "what replaces X?" rather
  // than "what inserts before/after X?".
  let replaceRange: vscode.Range | undefined;
  if (recentEdits.length > 0) {
    const editor = vscode.window.activeTextEditor;
    const sel = editor?.selection;
    if (sel && !sel.isEmpty && editor?.document.uri.toString() === document.uri.toString()) {
      const selectedText = document.getText(sel);
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(selectedText)) {
        const renames = extractIdentifierRenames(recentEdits);
        if (renames.some(r => r.from === selectedText)) {
          replaceRange = new vscode.Range(sel.start, sel.end);
          // Recompute prefix/suffix around the selection regardless of which
          // end the cursor is at (handles both left-to-right and right-to-left
          // selection, plus double-click where cursor lands at the end).
          prefix = document.getText(new vscode.Range(new vscode.Position(startLine, 0), sel.start));
          suffix = document.getText(new vscode.Range(sel.end, new vscode.Position(endLine, document.lineAt(endLine).text.length)));
        }
      }
    }
  }
  if (editCtx) {
    prefix = editCtx + prefix;
  }

  const diagCtx = buildDiagnosticContext(document, position);
  if (diagCtx) {
    prefix = diagCtx + prefix;
  }

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
    replaceRange,
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

// ---------------------------------------------------------------------------
// Scope-aware context helpers
// ---------------------------------------------------------------------------

/**
 * Scans backward from the cursor to find the start line of the innermost
 * enclosing function, method, class, or arrow-function body. Returns that
 * line number if found within [limit, position.line], otherwise returns
 * `limit` (the normal fallback window start).
 */
function findEnclosingScopeStart(
  document: vscode.TextDocument,
  position: vscode.Position,
  limit: number
): number {
  for (let i = position.line; i >= limit; i--) {
    if (isScopeOpener(document.lineAt(i).text)) {
      return i;
    }
  }
  return limit;
}

function isScopeOpener(line: string): boolean {
  // Named or anonymous function (JS/TS/Java/C/C++/Kotlin/Swift)
  if (/\bfunction\b/.test(line)) { return true; }
  // Class declaration
  if (/(?:^|\s)class\s+\w/.test(line)) { return true; }
  // Python / Ruby: def
  if (/^\s*def\s+\w/.test(line)) { return true; }
  // Rust: fn
  if (/^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?fn\s+\w/.test(line)) { return true; }
  // Go: func
  if (/^\s*func\s+[\w(]/.test(line)) { return true; }
  // Arrow function: (...) => {
  if (/=>\s*\{/.test(line)) { return true; }
  // Method / constructor body opener: name(params) { or name(params): Type {
  // Exclude control-flow keywords so we don't stop at if/for/while/catch/else.
  if (
    /\)\s*(?::\s*[^{]+)?\s*\{/.test(line) &&
    !/^\s*(?:if|else|for|while|do|switch|try|catch|finally|return)\b/.test(line)
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Edit history context helpers
// ---------------------------------------------------------------------------

/**
 * Formats recent edit records as a comment block to be prepended to the
 * current file prefix. Also appends "still appears at" notes for any
 * identifiers that were renamed but may still have un-updated occurrences.
 */
function buildEditHistoryContext(
  document: vscode.TextDocument,
  edits: EditRecord[]
): string {
  if (edits.length === 0) {
    return '';
  }

  const lines: string[] = ['// [Recent edits in this file]'];

  for (const edit of edits) {
    const oldDisplay = edit.oldText.split('\n')[0].trim().slice(0, 60);
    const newDisplay = edit.newText.split('\n')[0].trim().slice(0, 60);
    if (oldDisplay || newDisplay) {
      lines.push(`//   Line ${edit.lineNumber + 1}: ${JSON.stringify(oldDisplay)} \u2192 ${JSON.stringify(newDisplay)}`);
    }
  }

  // Append occurrence hints for clean identifier renames.
  const renames = extractIdentifierRenames(edits);
  if (renames.length > 0) {
    const docLines = document.getText().split('\n');
    for (const { from, to } of renames) {
      const re = new RegExp(`\\b${escapeRegExp(from)}\\b`);
      const occLines: number[] = [];
      for (let i = 0; i < docLines.length; i++) {
        if (re.test(docLines[i])) {
          occLines.push(i + 1); // 1-based
        }
      }
      // Skip if nothing found or if the identifier is too common (> 30 hits).
      if (occLines.length > 0 && occLines.length <= 30) {
        const listed = occLines.slice(0, 10).join(', ');
        const extra = occLines.length > 10 ? ` (+${occLines.length - 10} more)` : '';
        lines.push(
          `//   NOTE: '${from}' still found at line${occLines.length > 1 ? 's' : ''} ` +
          `${listed}${extra} (renamed to '${to}', may need updating)`
        );
      }
    }
  }

  return lines.join('\n') + '\n\n';
}

/**
 * Extracts (old → new) identifier pairs from edit records where both the
 * deleted text and inserted text are clean word-only identifiers.
 */
function extractIdentifierRenames(edits: EditRecord[]): Array<{ from: string; to: string }> {
  const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  const seen = new Set<string>();
  const result: Array<{ from: string; to: string }> = [];
  for (const { oldText, newText } of edits) {
    const from = oldText.trim();
    const to = newText.trim();
    if (
      from.length >= 2 &&
      to.length >= 1 &&
      from !== to &&
      IDENT.test(from) &&
      IDENT.test(to) &&
      !seen.has(from)
    ) {
      seen.add(from);
      result.push({ from, to });
    }
  }
  return result.slice(0, 3); // cap at 3 renames to keep prompt concise
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Diagnostic context helper
// ---------------------------------------------------------------------------

/**
 * Returns a comment block listing errors and warnings within 15 lines of the
 * cursor. Empty string when no relevant diagnostics exist.
 */
function buildDiagnosticContext(
  document: vscode.TextDocument,
  position: vscode.Position
): string {
  const diags = vscode.languages.getDiagnostics(document.uri).filter(
    d =>
      Math.abs(d.range.start.line - position.line) <= 15 &&
      (d.severity === vscode.DiagnosticSeverity.Error ||
        d.severity === vscode.DiagnosticSeverity.Warning)
  );
  if (diags.length === 0) {
    return '';
  }
  const lines = ['// [Nearby diagnostics]'];
  for (const d of diags.slice(0, 5)) {
    const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
    const msg = d.message.split('\n')[0].slice(0, 120);
    lines.push(`//   [${sev}] Line ${d.range.start.line + 1}: ${msg}`);
  }
  return lines.join('\n') + '\n\n';
}
