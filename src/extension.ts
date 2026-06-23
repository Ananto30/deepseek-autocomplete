import * as vscode from 'vscode';
import { EXT_ID, clearApiKey, getApiKey, getConfig, setApiKey } from './config';
import { EditTracker } from './editTracker';
import { DeepSeekInlineProvider } from './provider';
import { StatusBar } from './statusBar';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const statusBar = new StatusBar();
  context.subscriptions.push(statusBar);

  const editTracker = new EditTracker();
  context.subscriptions.push(editTracker);

  const provider = new DeepSeekInlineProvider(context, statusBar, editTracker);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider)
  );

  async function refreshStatusBar(): Promise<void> {
    const key = await getApiKey(context);
    if (!key) {
      statusBar.setNeedsApiKey();
      return;
    }
    const cfg = getConfig();
    if (!cfg.enabled) {
      statusBar.setDisabled();
      return;
    }
    statusBar.setReady();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekAutocomplete.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: 'DeepSeek API Key',
        prompt: 'Paste your DeepSeek API key (created at platform.deepseek.com).',
        password: true,
        ignoreFocusOut: true,
        validateInput: value => (value && value.trim().length > 0 ? undefined : 'API key cannot be empty.'),
      });
      if (!key) {
        return;
      }
      await setApiKey(context, key.trim());
      vscode.window.showInformationMessage('DeepSeek API key saved.');
      await refreshStatusBar();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekAutocomplete.clearApiKey', async () => {
      await clearApiKey(context);
      vscode.window.showInformationMessage('DeepSeek API key removed.');
      await refreshStatusBar();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekAutocomplete.toggle', async () => {
      const key = await getApiKey(context);
      if (!key) {
        const choice = await vscode.window.showWarningMessage(
          'No DeepSeek API key is set yet.',
          'Set API Key'
        );
        if (choice === 'Set API Key') {
          await vscode.commands.executeCommand('deepseekAutocomplete.setApiKey');
        }
        return;
      }
      const cfg = vscode.workspace.getConfiguration(EXT_ID);
      const current = cfg.get<boolean>('enabled', true);
      await cfg.update('enabled', !current, vscode.ConfigurationTarget.Global);
      await refreshStatusBar();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekAutocomplete.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(EXT_ID)) {
        void refreshStatusBar();
      }
    })
  );

  await refreshStatusBar();
}

export function deactivate(): void {
  // Nothing to clean up explicitly - everything is registered via
  // context.subscriptions and disposed automatically by VS Code.
}
