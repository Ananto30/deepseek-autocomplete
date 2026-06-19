import * as vscode from 'vscode';

/** Small status bar item showing whether DeepSeek Autocomplete is ready, loading, disabled, or needs setup. */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.setReady();
    this.item.show();
  }

  setReady(): void {
    this.item.text = '$(sparkle) DeepSeek';
    this.item.tooltip = 'DeepSeek Autocomplete is active. Click to toggle on/off.';
    this.item.command = 'deepseekAutocomplete.toggle';
    this.item.backgroundColor = undefined;
  }

  setLoading(): void {
    this.item.text = '$(sync~spin) DeepSeek';
    this.item.tooltip = 'Requesting a suggestion from DeepSeek\u2026';
  }

  setDisabled(): void {
    this.item.text = '$(circle-slash) DeepSeek';
    this.item.tooltip = 'DeepSeek Autocomplete is disabled. Click to enable.';
    this.item.command = 'deepseekAutocomplete.toggle';
    this.item.backgroundColor = undefined;
  }

  setNeedsApiKey(): void {
    this.item.text = '$(key) DeepSeek';
    this.item.tooltip = 'No DeepSeek API key set. Click to add one.';
    this.item.command = 'deepseekAutocomplete.setApiKey';
    this.item.backgroundColor = undefined;
  }

  setError(message?: string): void {
    this.item.text = '$(warning) DeepSeek';
    this.item.tooltip = message
      ? `Last DeepSeek request failed: ${message}`
      : 'Last DeepSeek request failed. Check the Output panel / Developer Tools console for details.';
    this.item.command = 'deepseekAutocomplete.toggle';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  dispose(): void {
    this.item.dispose();
  }
}
