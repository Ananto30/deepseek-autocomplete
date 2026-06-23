import * as vscode from 'vscode';

export interface EditRecord {
    /** 0-based line number where the change started. */
    lineNumber: number;
    /** Text that was replaced (first 120 chars). */
    oldText: string;
    /** Text that replaced it (first 120 chars). */
    newText: string;
}

const MAX_HISTORY = 8;
const MAX_AGE_MS = 60_000;       // forget edits older than 1 minute
const MAX_TEXT_LEN = 120;
const MAX_SHADOW_BYTES = 500_000; // stop tracking documents larger than 500 KB

export class EditTracker implements vscode.Disposable {
    private readonly shadow = new Map<string, string>(); // uri → pre-change text snapshot
    private readonly history = new Map<string, Array<EditRecord & { ts: number }>>();
    private readonly subs: vscode.Disposable[] = [];

    constructor() {
        // Seed shadows for documents already open when the tracker is created.
        for (const doc of vscode.workspace.textDocuments) {
            this.initShadow(doc);
        }
        this.subs.push(
            vscode.workspace.onDidOpenTextDocument(doc => this.initShadow(doc)),
            vscode.workspace.onDidCloseTextDocument(doc => {
                const k = doc.uri.toString();
                this.shadow.delete(k);
                this.history.delete(k);
            }),
            vscode.workspace.onDidChangeTextDocument(e => this.handleChange(e))
        );
    }

    private initShadow(doc: vscode.TextDocument): void {
        if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') {
            return;
        }
        const text = doc.getText();
        if (text.length <= MAX_SHADOW_BYTES) {
            this.shadow.set(doc.uri.toString(), text);
        }
    }

    private handleChange(event: vscode.TextDocumentChangeEvent): void {
        const k = event.document.uri.toString();
        let shadow = this.shadow.get(k);

        if (shadow === undefined) {
            // Not yet shadowed — seed from current state (this change is already applied).
            this.initShadow(event.document);
            return;
        }

        const recs = this.history.get(k) ?? [];
        const now = Date.now();

        // Sort changes descending by offset so we apply them back-to-front.
        // This keeps every rangeOffset valid against the same pre-change shadow
        // regardless of how many simultaneous changes there are (e.g. rename-all).
        const sorted = [...event.contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset);

        for (const ch of sorted) {
            if (ch.rangeLength === 0 && ch.text === '') {
                continue;
            }

            // Extract the old text from our pre-change snapshot.
            const oldRaw = shadow.slice(ch.rangeOffset, ch.rangeOffset + ch.rangeLength);

            // Only record changes that carry meaningful (non-whitespace) content.
            if (oldRaw.trim() || ch.text.trim()) {
                recs.push({
                    lineNumber: ch.range.start.line,
                    oldText: oldRaw.slice(0, MAX_TEXT_LEN),
                    newText: ch.text.slice(0, MAX_TEXT_LEN),
                    ts: now,
                });
            }

            // Patch the shadow to reflect this change.
            shadow =
                shadow.slice(0, ch.rangeOffset) +
                ch.text +
                shadow.slice(ch.rangeOffset + ch.rangeLength);
        }

        if (shadow.length <= MAX_SHADOW_BYTES) {
            this.shadow.set(k, shadow);
        } else {
            // File grew too large to shadow efficiently — stop tracking it.
            this.shadow.delete(k);
        }

        // Prune: keep only the most recent MAX_HISTORY entries within the time window.
        const cutoff = now - MAX_AGE_MS;
        const pruned = recs.filter(r => r.ts >= cutoff).slice(-MAX_HISTORY);
        if (pruned.length > 0) {
            this.history.set(k, pruned);
        } else {
            this.history.delete(k);
        }
    }

    /** Returns up to MAX_HISTORY recent edit records for the given document URI. */
    getRecentEdits(uri: vscode.Uri): EditRecord[] {
        const cutoff = Date.now() - MAX_AGE_MS;
        return (this.history.get(uri.toString()) ?? [])
            .filter(r => r.ts >= cutoff)
            .map(({ lineNumber, oldText, newText }) => ({ lineNumber, oldText, newText }));
    }

    dispose(): void {
        for (const s of this.subs) {
            s.dispose();
        }
        this.shadow.clear();
        this.history.clear();
    }
}
