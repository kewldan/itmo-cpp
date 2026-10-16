import {execFile} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  type CmakeAction,
  CmakeScript,
  type CmakeScriptOptions,
  type CmakeTarget,
  FindCiConfig,
  ReadExecutables,
} from './cmake';
import {T, UiLang} from './i18n';
import {
  CmakeBuildDir,
  CurrentLab,
  DetectBuildSystem,
  type Lab,
  LlvmTool,
} from './lab';
import {DetectPlatform, EnsureSupported, InstallHint} from './platform';

export type Action = 'build' | 'run' | 'test' | 'fmt' | 'check';

const kMakeTargets: Record<Action, string> = {
  build: 'all',
  run: 'run',
  test: 'test',
  fmt: 'fmt',
  check: 'check',
};

// Настройки скриптов CMake. Если в CI курса есть tidy-config, check
// проверяет именно им.
export function CmakeOptions(lab: Lab): CmakeScriptOptions {
  const build_dir = CmakeBuildDir(lab);
  let tidy_config_file: string | undefined;
  const ci = FindCiConfig(lab.root);
  if (ci?.tidyConfig) {
    tidy_config_file = path.join(build_dir, 'labkit-ci-tidy.yaml');
    fs.mkdirSync(build_dir, {recursive: true});
    fs.writeFileSync(tidy_config_file, ci.tidyConfig);
  }
  return {
    buildDir: path.relative(lab.root, build_dir) || '.',
    configureArgs: vscode.workspace
      .getConfiguration('labkit.cmake')
      .get<string[]>('configureArgs', []),
    clangFormat: LlvmTool('clang-format'),
    clangTidy: LlvmTool('clang-tidy'),
    tidyConfigFile: tidy_config_file,
    lang: UiLang(),
  };
}

// Запускает действие как задачу VS Code: ошибки компилятора, clang-format
// и clang-tidy попадают в «Проблемы».
async function ExecuteTask(
  lab: Lab,
  action: Action,
  execution: vscode.ShellExecution | vscode.ProcessExecution,
): Promise<boolean> {
  const task = new vscode.Task(
    {type: 'labkit', target: action},
    lab.workspaceFolder,
    `${lab.name}: ${action}`,
    'labkit',
    execution,
    ['$labkit-cpp'],
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    focus: action === 'run',
    clear: true,
    panel: vscode.TaskPanelKind.Dedicated,
  };
  const running = await vscode.tasks.executeTask(task);
  return new Promise((resolve) => {
    const listener = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution !== running) return;
      listener.dispose();
      resolve(e.exitCode === 0);
    });
  });
}

// Скрипт кладётся в папку сборки и запускается одной короткой командой —
// иначе VS Code печатает в терминал весь текст скрипта.
function CmakeExecution(
  lab: Lab,
  action: Action,
  options: CmakeScriptOptions,
): vscode.ProcessExecution {
  const dir = path.join(CmakeBuildDir(lab), '.labkit');
  fs.mkdirSync(dir, {recursive: true});
  const script = path.join(dir, `${action}.sh`);
  fs.writeFileSync(script, CmakeScript(action as CmakeAction, options));
  return new vscode.ProcessExecution(
    'bash',
    [path.relative(lab.root, script)],
    {cwd: lab.root},
  );
}

function IsTestTarget(target: CmakeTarget): boolean {
  return /^tests?(\/|$)/.test(target.sourceDir) || /tests?$/i.test(target.name);
}

// Что запускать по кнопке «Запустить»: исполняемые цели без тестов.
async function PickRunTarget(lab: Lab): Promise<CmakeTarget | undefined> {
  const Targets = () =>
    ReadExecutables(CmakeBuildDir(lab)).filter((t) => !IsTestTarget(t));
  let targets = Targets();
  if (targets.length === 0) {
    // File API отвечает только после настройки CMake.
    if (
      !(await ExecuteTask(
        lab,
        'build',
        CmakeExecution(lab, 'build', CmakeOptions(lab)),
      ))
    ) {
      return undefined;
    }
    targets = Targets();
  }
  if (targets.length === 0) {
    void vscode.window.showErrorMessage(
      T('CMake has no executable targets to run in {0}.', lab.name),
    );
    return undefined;
  }
  if (targets.length === 1) return targets[0];
  targets.sort(
    (a, b) => Number(b.sourceDir === 'bin') - Number(a.sourceDir === 'bin'),
  );
  const picked = await vscode.window.showQuickPick(
    targets.map((target) => ({
      label: target.name,
      description: target.sourceDir,
      target,
    })),
    {placeHolder: T('Which program to run?')},
  );
  return picked?.target;
}

export async function RunAction(
  action: Action,
  lab = CurrentLab(),
): Promise<boolean> {
  if (!EnsureSupported()) return false;
  if (!lab) {
    void vscode.window.showErrorMessage(T('Open a file of the lab.'));
    return false;
  }
  const system = DetectBuildSystem(lab);
  if (system === 'none') {
    const create = T('Generate Makefile');
    const answer = await vscode.window.showErrorMessage(
      T('{0} has neither a Makefile nor a CMakeLists.txt.', lab.name),
      create,
    );
    if (answer === create) {
      await vscode.commands.executeCommand('labkit.generateMakefile');
    }
    return false;
  }
  await vscode.workspace.saveAll(false);
  if (system === 'cmake') {
    const options = CmakeOptions(lab);
    if (action === 'run') {
      options.runTarget = await PickRunTarget(lab);
      if (!options.runTarget) return false;
    }
    return ExecuteTask(lab, action, CmakeExecution(lab, action, options));
  }
  const args = [
    kMakeTargets[action],
    `CLANG_TIDY=${LlvmTool('clang-tidy')}`,
    `CLANG_FORMAT=${LlvmTool('clang-format')}`,
  ];
  return ExecuteTask(
    lab,
    action,
    new vscode.ShellExecution('make', args, {cwd: lab.root}),
  );
}

export async function Check(lab = CurrentLab()): Promise<void> {
  if (!lab) return;
  await vscode.commands.executeCommand('labkit.complexityReport');
  const ok = await RunAction('check', lab);
  if (ok) {
    void vscode.window.showInformationMessage(
      T(
        '{0}: formatting, clang-tidy and tests are fine. Check the ' +
          'complexity report and you are ready to submit.',
        lab.name,
      ),
    );
  } else {
    void vscode.window.showWarningMessage(
      T(
        '{0}: the check failed, see the Problems tab and the ' + 'terminal.',
        lab.name,
      ),
    );
  }
}

function Exec(
  command: string,
  args: string[],
  cwd?: string,
): Promise<{ok: boolean; out: string}> {
  return new Promise((resolve) => {
    execFile(command, args, {cwd, timeout: 10000}, (error, stdout, stderr) => {
      resolve({ok: !error, out: `${stdout}${stderr}`.trim()});
    });
  });
}

function Version(out: string): number | undefined {
  const match = /version (\d+)/.exec(out);
  return match ? Number(match[1]) : undefined;
}

export async function Doctor(output: vscode.OutputChannel): Promise<void> {
  output.clear();
  output.show(true);
  const platform = DetectPlatform();
  const min = vscode.workspace
    .getConfiguration('labkit')
    .get<number>('minLlvmVersion', 18);
  const problems: string[] = [];
  const Line = (ok: boolean, text: string) =>
    output.appendLine(`${ok ? '✔' : '✘'} ${text}`);
  const kNames: Record<typeof platform, string> = {
    macos: 'macOS',
    wsl: 'WSL',
    linux: 'Linux',
    windows: 'Windows',
  };

  output.appendLine(
    `${T('ITMO C++ Lab Kit — tool check ({0})', kNames[platform])}\n`,
  );
  if (!EnsureSupported()) {
    output.appendLine(T('Native Windows is not supported, use WSL.'));
    return;
  }
  const missing = T('not found');
  for (const tool of ['clang-format', 'clang-tidy', 'clangd']) {
    const binary = LlvmTool(tool);
    const {ok, out} = await Exec(binary, ['--version']);
    const version = Version(out);
    const fresh = version !== undefined && version >= min;
    Line(
      ok && fresh,
      `${tool}: ${
        ok ? T('{0}, version {1}', binary, String(version)) : missing
      }`,
    );
    if (!ok) problems.push(T('no {0}', tool));
    else if (!fresh) problems.push(T('{0} is older than {1}', tool, min));
  }
  for (const tool of ['clang++', 'make', 'git']) {
    const {ok, out} = await Exec(tool, ['--version']);
    Line(ok, `${tool}: ${ok ? out.split('\n')[0] : missing}`);
    if (!ok) problems.push(T('no {0}', tool));
  }
  const lab = CurrentLab();
  const cmake = await Exec('cmake', ['--version']);
  const needs_cmake = lab !== undefined && DetectBuildSystem(lab) === 'cmake';
  Line(
    cmake.ok || !needs_cmake,
    `cmake: ${cmake.ok ? cmake.out.split('\n')[0] : missing}`,
  );
  if (!cmake.ok && needs_cmake) problems.push(T('no {0}', 'cmake'));
  // Версия clang-tidy в CI курса: проверки разных версий расходятся.
  const ci_version = lab ? FindCiConfig(lab.root)?.tidyVersion : undefined;
  if (ci_version !== undefined) {
    const local = Version(
      (await Exec(LlvmTool('clang-tidy'), ['--version'])).out,
    );
    const same = local === ci_version;
    Line(
      same,
      T(
        'CI uses clang-tidy {0}, local is {1}',
        ci_version,
        String(local ?? '—'),
      ),
    );
    if (local !== undefined && local < ci_version) {
      problems.push(T('clang-tidy is older than in CI'));
    }
  }
  const gtest = await Exec('pkg-config', ['--modversion', 'gtest']);
  Line(gtest.ok, `GoogleTest: ${gtest.ok ? gtest.out : missing}`);
  if (!gtest.ok) problems.push(T('no {0}', 'GoogleTest'));
  const clangd_ext = vscode.extensions.getExtension(
    'llvm-vs-code-extensions.vscode-clangd',
  );
  Line(
    !!clangd_ext,
    T('clangd extension: {0}', clangd_ext ? T('installed') : missing),
  );
  if (!clangd_ext) problems.push(T('no clangd extension'));

  output.appendLine('');
  if (problems.length === 0) {
    output.appendLine(T('Everything is in place.'));
    void vscode.window.showInformationMessage(
      T('Lab Kit: all tools are in place.'),
    );
    return;
  }
  output.appendLine(T('How to install:'));
  output.appendLine(`  ${InstallHint(platform)}`);
  void vscode.window.showWarningMessage(
    T('Lab Kit: {0}. See the output panel for details.', problems.join(', ')),
  );
}

export function ActionCommand(action: Action): () => Promise<void> {
  return async () => {
    await RunAction(action);
  };
}
