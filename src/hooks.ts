import {execFile} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import {T, UiLang} from './i18n';
import {CmakeBuildDir, CurrentLab, LlvmTool} from './lab';
import {EnsureSupported} from './platform';
import * as templates from './templates';

function Git(args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', args, {cwd}, (error, stdout) =>
      resolve(error ? undefined : stdout.trim()),
    );
  });
}

// Папка хуков с учётом core.hooksPath.
async function HooksDir(): Promise<
  {dir: string; build_dir: string} | undefined
> {
  if (!EnsureSupported()) return undefined;
  const lab = CurrentLab();
  if (!lab) return undefined;
  const dir = await Git(['rev-parse', '--git-path', 'hooks'], lab.root);
  if (!dir) {
    void vscode.window.showErrorMessage(
      T('{0} is not a git repository.', lab.name),
    );
    return undefined;
  }
  return {
    dir: path.resolve(lab.root, dir),
    build_dir: path.relative(lab.root, CmakeBuildDir(lab)) || 'build',
  };
}

function IsOurs(file: string): boolean {
  return (
    fs.existsSync(file) &&
    fs.readFileSync(file, 'utf8').includes(templates.kHookMarker)
  );
}

function WriteHook(dir: string, name: string, content: string): void {
  const file = path.join(dir, name);
  // Чужой хук не затираем: он переезжает в .local и вызывается из нашего.
  if (fs.existsSync(file) && !IsOurs(file)) {
    fs.renameSync(file, `${file}.local`);
  }
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(file, content, {mode: 0o755});
}

export async function InstallGitHooks(): Promise<void> {
  const hooks = await HooksDir();
  if (!hooks) return;
  const dir = hooks.dir;
  const config = vscode.workspace.getConfiguration('labkit.gitHooks');
  const pre_commit = config.get<templates.PreCommitStep[]>('preCommit', [
    'format',
    'tidy',
  ]);
  const pre_push = config.get<templates.PrePushStep[]>('prePush', ['test']);
  const tools = {
    clangFormat: LlvmTool('clang-format'),
    clangTidy: LlvmTool('clang-tidy'),
  };
  const installed: string[] = [];
  if (pre_commit.length > 0) {
    WriteHook(
      dir,
      'pre-commit',
      templates.PreCommitHook(pre_commit, tools, UiLang()),
    );
    installed.push(`pre-commit (${pre_commit.join(', ')})`);
  }
  if (pre_push.length > 0) {
    WriteHook(
      dir,
      'pre-push',
      templates.PrePushHook(pre_push, tools, UiLang(), hooks.build_dir),
    );
    installed.push(`pre-push (${pre_push.join(', ')})`);
  }
  void vscode.window.showInformationMessage(
    installed.length
      ? T('Git hooks installed: {0}.', installed.join('; '))
      : T('No checks are selected in the labkit.gitHooks settings.'),
  );
}

export async function RemoveGitHooks(): Promise<void> {
  const dir = (await HooksDir())?.dir;
  if (!dir) return;
  let removed = 0;
  for (const name of ['pre-commit', 'pre-push']) {
    const file = path.join(dir, name);
    if (!IsOurs(file)) continue;
    fs.rmSync(file);
    removed++;
    if (fs.existsSync(`${file}.local`)) fs.renameSync(`${file}.local`, file);
  }
  void vscode.window.showInformationMessage(
    removed
      ? T('Lab Kit git hooks removed, previous hooks restored.')
      : T('There are no Lab Kit hooks here.'),
  );
}
