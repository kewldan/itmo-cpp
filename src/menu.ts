import * as vscode from 'vscode';

import {T} from './i18n';
import {CurrentLab} from './lab';

interface MenuItem extends vscode.QuickPickItem {
  command?: string;
}

// Кнопка «Lab Kit» в строке состояния: все действия в одном меню, чтобы их
// не путать с кнопками CMake Tools и Makefile Tools.
export class LabMenu implements vscode.Disposable {
  private readonly status_ = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    101,
  );
  private readonly disposables_: vscode.Disposable[] = [];

  constructor() {
    this.status_.command = 'labkit.menu';
    this.disposables_.push(
      this.status_,
      vscode.commands.registerCommand('labkit.menu', () => this.Show()),
      vscode.window.onDidChangeActiveTextEditor(() => this.Render()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('labkit.language')) this.Render();
      }),
    );
    this.Render();
  }

  dispose(): void {
    this.disposables_.forEach((d) => {
      d.dispose();
    });
  }

  private Render(): void {
    if (!CurrentLab()) {
      this.status_.hide();
      return;
    }
    this.status_.text = '$(beaker) Lab Kit';
    this.status_.tooltip = T('Lab Kit: build, run, tests, pre-submit check');
    this.status_.show();
  }

  private async Show(): Promise<void> {
    const lab = CurrentLab();
    const Item = (
      icon: string,
      label: string,
      command: string,
      detail?: string,
    ): MenuItem => ({label: `$(${icon}) ${label}`, detail, command});
    const Separator = (label: string): MenuItem => ({
      label,
      kind: vscode.QuickPickItemKind.Separator,
    });
    const items: MenuItem[] = [
      Separator(lab?.name ?? 'Lab Kit'),
      Item('tools', T('Build'), 'labkit.build'),
      Item('play', T('Build and run'), 'labkit.run'),
      Item(
        'beaker',
        T('Run tests'),
        'labkit.test',
        T('Single tests: the Testing view on the left'),
      ),
      Item(
        'checklist',
        T('Pre-submit check'),
        'labkit.check',
        T('Formatting, build, clang-tidy as in CI, tests'),
      ),
      Item('pulse', T('Complexity report'), 'labkit.complexityReport'),
      Item('symbol-namespace', T('Format the lab'), 'labkit.format'),
      Separator(T('Setup')),
      Item('settings-gear', T('Set up environment'), 'labkit.setupEnvironment'),
      Item('git-commit', T('Install git hooks'), 'labkit.installGitHooks'),
      Item('heart', T('Check tools'), 'labkit.doctor'),
      Item('clock', T('Time report'), 'labkit.timeReport'),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: T('Lab Kit actions'),
      matchOnDetail: true,
    });
    if (picked?.command) {
      await vscode.commands.executeCommand(picked.command);
    }
  }
}
