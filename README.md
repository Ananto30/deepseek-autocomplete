# DeepSeek Autocomplete

Inline, ghost-text code suggestions in VS Code - powered by your own DeepSeek API key. Type, and a gray suggestion appears at the cursor; press <kbd>Tab</kbd> to accept it, just like GitHub Copilot's inline suggestions.

A quick note on "follow their repo": GitHub Copilot's actual completion engine is closed-source, so there's no repo to copy from directly. This extension is instead built on the same public VS Code extension point Copilot uses - [`vscode.languages.registerInlineCompletionItemProvider`](https://code.visualstudio.com/api/references/vscode-api#InlineCompletionItemProvider) - and follows the general pattern used by open-source alternatives like Continue, Tabby, and twinny: debounce keystrokes, grab the surrounding code, call a model, show the result as ghost text.

## Features

- Automatic inline suggestions as you type, with a short debounce so you're not firing an API call on every keystroke.
- Manual trigger too (VS Code's default <kbd>Alt</kbd>+<kbd>\\</kbd> "Trigger Inline Suggestion" command works out of the box).
- Choice of model - `deepseek-v4-flash` (fast/cheap, default) or `deepseek-v4-pro` (slower, stronger suggestions).
- Two completion strategies: DeepSeek's **FIM** (Fill-In-the-Middle) beta endpoint, purpose-built for this kind of editor autocomplete, or a **chat**-based fallback.
- Optional "neighboring tabs" context: pulls short snippets from your other open files so suggestions match your project's existing patterns, imports, and naming.
- A status bar item showing ready / loading / disabled / needs-API-key / error states; click it to toggle on/off.
- Your API key is stored in VS Code's encrypted SecretStorage, never written into `settings.json`.

## Setup

1. **Install dependencies and compile:**
   ```bash
   npm install
   npm run compile
   ```
2. **Run it:** open this folder in VS Code and press <kbd>F5</kbd>. This launches an "Extension Development Host" window with the extension active.
3. **Set your API key:** open the Command Palette (<kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>) and run **DeepSeek: Set API Key**. Get a key from [platform.deepseek.com](https://platform.deepseek.com).
4. Open any code file and start typing - suggestions should appear within a fraction of a second after you pause.

To install it permanently instead of running it from source, package it into a `.vsix` and install that:
```bash
npm install -g @vscode/vsce
vsce package
```
Then in VS Code: Extensions view \u2192 `...` menu \u2192 **Install from VSIX...** \u2192 pick the generated file.

## Settings

All settings live under `deepseekAutocomplete.*` in your VS Code settings (Command Palette \u2192 **DeepSeek: Open Settings**).

| Setting | Default | What it does |
|---|---|---|
| `enabled` | `true` | Master on/off switch for automatic suggestions. |
| `model` | `deepseek-v4-flash` | Model used for completions. Use `deepseek-v4-pro` for higher-quality (slower, pricier) suggestions. |
| `baseUrl` | `https://api.deepseek.com` | Override if you're routing through a proxy. |
| `completionMode` | `fim` | `fim` (recommended) or `chat`. See below. |
| `enableThinking` | `false` | Chat mode only. DeepSeek V4 defaults to "thinking mode" on, which is far too slow for inline autocomplete - leave this off. |
| `maxTokens` | `256` | Cap on suggestion length. |
| `temperature` | `0.2` | Lower = more predictable/conservative completions. |
| `debounceMs` | `300` | Wait time after you stop typing before calling the API. |
| `requestTimeoutMs` | `8000` | Give up on a suggestion after this long. |
| `contextLinesBefore` / `contextLinesAfter` | `100` / `50` | How much of the current file (around the cursor) to send. |
| `includeOpenFiles` | `true` | Pull extra context from your other open tabs. |
| `maxContextFiles` | `3` | Cap on how many other open files to include. |
| `maxContextCharsPerFile` | `1500` | Cap on how much of each neighboring file to include. |
| `disabledLanguages` | `[]` | Language IDs to never trigger on, e.g. `["plaintext", "markdown"]`. |

### FIM vs. chat mode

- **`fim`** sends the code before the cursor as `prompt` and the code after the cursor as `suffix` to DeepSeek's `/beta/completions` endpoint. The model fills the gap directly. No chat wrapping, no "thinking" step - this is the closest match to how Copilot-style completion actually works under the hood, and it's the fastest option.
- **`chat`** wraps the same before/after code into a system + user message and calls `/chat/completions`, instructing the model to reply with only the inserted code. Useful as a fallback if FIM ever isn't available for your account, but it's slower and more prone to the model adding stray commentary (which this extension tries to strip).

## How context is built

For every suggestion, the extension takes a window of lines around your cursor in the current file (`contextLinesBefore`/`contextLinesAfter`) and, if `includeOpenFiles` is on, prepends short snippets from your other open editor tabs - prioritizing tabs in the same language - as `// File: <path>` blocks. This gives DeepSeek a sense of your project's conventions without sending your entire codebase on every keystroke.

## Known limitations (this is intentionally simple)

- Only one suggestion is shown at a time - no cycling through alternatives (Copilot's <kbd>Alt</kbd>+<kbd>]</kbd>/<kbd>[</kbd>).
- No streaming; the full suggestion is requested and shown at once.
- Context is window + neighboring-tabs only - no embeddings-based, repo-wide retrieval.
- No telemetry/usage dashboard; you're billed directly by DeepSeek for whatever you use.

These are reasonable next steps if you want to extend it further.

## Privacy / cost note

Every suggestion request sends a window of your code (plus, optionally, snippets from other open files) to DeepSeek's API and is billed to your API key under DeepSeek's standard token pricing. Use `disabledLanguages`, `includeOpenFiles: false`, or just toggle the extension off (status bar click) for anything you don't want leaving your machine.
