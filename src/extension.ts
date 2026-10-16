import * as vscode from 'vscode';

import {RegisterComplexity} from './complexity/provider';
import {InstallGitHooks, RemoveGitHooks} from './hooks';
import {InitI18n} from './i18n';
import {CurrentLab, FindLab, HasBuildSystem} from './lab';
import {LabMenu} from './menu';
import {EnsureSupported} from './platform';
import {GenerateMakefile, SetupEnvironment} from './setup';
import {kTaskViewId, TaskViewProvider} from './task_view';
import {ActionCommand, Check, Doctor, RunAction} from './tasks';
import {GtestController} from './tests';
import {TimeTracker} from './time_tracker';

// Кнопки в заголовке редактора видны, только если файл в лабе со сборкой.
// Без активного редактора берём папку рабочей области: при активации от
// открытия .cpp редактор может ещё не считаться активным.
function UpdateContext(): void {
  const editor = vscode.window.activeTextEditor;
  const lab =
    editor?.document.uri.scheme === 'file'
      ? (FindLab(editor.document.uri.fsPath) ?? CurrentLab())
      : CurrentLab();
  void vscode.commands.executeCommand(
    'setContext',
    'labkit.inLab',
    !!lab && HasBuildSystem(lab),
  );
}

export function activate(context: vscode.ExtensionContext) {
  InitI18n(context.extensionPath);
  // На Windows без WSL сразу подсказываем открыть папку в WSL.
  EnsureSupported();
  const output = vscode.window.createOutputChannel('Lab Kit');
  const tracker = new TimeTracker();
  context.subscriptions.push(new LabMenu());
  const tests = new GtestController();
  void tests.DiscoverAll();
  RegisterComplexity(context);
  const task_view = new TaskViewProvider();
  context.subscriptions.push(
    task_view,
    vscode.window.registerWebviewViewProvider(kTaskViewId, task_view),
  );

  type Callback = Parameters<typeof vscode.commands.registerCommand>[1];
  const Register = (command: string, callback: Callback) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(command, callback),
    );
  Register('labkit.setupEnvironment', () => SetupEnvironment());
  Register('labkit.generateMakefile', (uri?: vscode.Uri) =>
    GenerateMakefile(uri),
  );
  Register('labkit.build', ActionCommand('build'));
  Register('labkit.run', ActionCommand('run'));
  Register('labkit.test', ActionCommand('test'));
  Register('labkit.format', ActionCommand('fmt'));
  Register('labkit.check', () => Check());
  Register('labkit.timeReport', () => tracker.Report());
  Register('labkit.toggleTimer', () => tracker.TogglePause());
  Register('labkit.doctor', () => Doctor(output));
  Register('labkit.installGitHooks', () => InstallGitHooks());
  Register('labkit.removeGitHooks', () => RemoveGitHooks());
  Register('labkit.task.refresh', () => task_view.Render(CurrentLab()));
  Register('labkit.task.openSource', () => task_view.OpenSource());
  Register('labkit.task.reset', () => task_view.ResetChecklist());
  Register('labkit.task.pickFile', () => task_view.PickFile());

  context.subscriptions.push(
    output,
    tracker,
    tests,
    vscode.window.onDidChangeActiveTextEditor(UpdateContext),
    vscode.window.onDidChangeVisibleTextEditors(UpdateContext),
    vscode.workspace.onDidChangeWorkspaceFolders(UpdateContext),
  );
  UpdateContext();
  setTimeout(UpdateContext, 1000);
  // API для smoke-теста.
  return {taskView: task_view, tests, runAction: RunAction};
}

export function deactivate(): void {}
