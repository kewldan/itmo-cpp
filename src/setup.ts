import {execFile} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import {FindCiConfig} from './cmake';
import {T, UiLang} from './i18n';
import {ComplexityLimits, CurrentLab, LlvmTool, MakeLab} from './lab';
import * as templates from './templates';

const kClangdExtension = 'llvm-vs-code-extensions.vscode-clangd';

type Overwrite = 'ask' | 'all' | 'none';

class FileWriter {
  written: string[] = [];
  skipped: string[] = [];
  private mode_: Overwrite;

  constructor(mode: Overwrite) {
    this.mode_ = mode;
  }

  async Write(file: string, content: string): Promise<void> {
    if (fs.existsSync(file)) {
      if (fs.readFileSync(file, 'utf8') === content) return;
      if (!(await this.MayOverwrite(file))) {
        this.skipped.push(file);
        return;
      }
    }
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, content);
    this.written.push(file);
  }

  private async MayOverwrite(file: string): Promise<boolean> {
    if (this.mode_ !== 'ask') return this.mode_ === 'all';
    const yes = T('Yes');
    const yes_all = T('Yes to all');
    const no = T('No');
    const no_all = T('No to all');
    const answer = await vscode.window.showWarningMessage(
      T('{0} already exists. Overwrite?', path.basename(file)),
      {modal: true},
      yes,
      yes_all,
      no,
      no_all,
    );
    if (answer === yes_all) this.mode_ = 'all';
    if (answer === no_all || answer === undefined) this.mode_ = 'none';
    return answer === yes || answer === yes_all;
  }
}

function TidyConfig(root: string): string | undefined {
  const c = vscode.workspace.getConfiguration('labkit.clangTidy');
  const profile = c.get<string>('profile', 'auto');
  if (profile === 'auto' || profile === 'ci') {
    // Ровно тот конфиг, которым CI курса выставляет баллы за codestyle.
    const ci = FindCiConfig(root)?.tidyConfig;
    if (ci) return `# clang-tidy config from .github/workflows (CI).\n${ci}`;
    if (profile === 'ci') {
      void vscode.window.showErrorMessage(
        T(
          'The clang-tidy profile is "ci", but .github/workflows has no ' +
            'tidy-config.',
        ),
      );
      return undefined;
    }
    return templates.ClangTidy('basic', ComplexityLimits());
  }
  if (profile !== 'custom') {
    return templates.ClangTidy(
      profile as templates.TidyProfile,
      ComplexityLimits(),
    );
  }
  const custom = c.get<string>('customConfig', '');
  if (!custom || !fs.existsSync(custom)) {
    void vscode.window.showErrorMessage(
      T(
        'The clang-tidy profile is "custom", but ' +
          'labkit.clangTidy.customConfig does not point to a file.',
      ),
    );
    return undefined;
  }
  return fs.readFileSync(custom, 'utf8');
}

async function ApplyEditorSettings(folder: vscode.WorkspaceFolder) {
  const target = vscode.ConfigurationTarget.WorkspaceFolder;
  const has_clangd = vscode.extensions.getExtension(kClangdExtension);
  const cpp = vscode.workspace.getConfiguration('', {
    uri: folder.uri,
    languageId: 'cpp',
  });
  const for_cpp: Array<[string, unknown]> = [
    ['editor.formatOnSave', true],
    ['editor.tabSize', 2],
    ['editor.insertSpaces', true],
    ['editor.rulers', [80]],
  ];
  if (has_clangd) {
    for_cpp.push(['editor.defaultFormatter', kClangdExtension]);
  }
  for (const [key, value] of for_cpp) {
    await cpp.update(key, value, target, true);
  }

  const all = vscode.workspace.getConfiguration('', folder.uri);
  const general: Array<[string, unknown]> = [
    ['files.insertFinalNewline', true],
    ['files.trimTrailingWhitespace', true],
    [
      'clangd.arguments',
      [
        '--clang-tidy',
        '--header-insertion=never',
        '--completion-style=detailed',
        '--fallback-style=Google',
      ],
    ],
  ];
  const clangd = LlvmTool('clangd');
  if (path.isAbsolute(clangd)) general.push(['clangd.path', clangd]);
  if (has_clangd) {
    // cpptools и clangd вместе дают двойные подсказки и ошибки.
    general.push(['C_Cpp.intelliSenseEngine', 'disabled']);
  } else {
    general.push(['C_Cpp.clang_format_style', 'file']);
    general.push(['C_Cpp.codeAnalysis.clangTidy.enabled', true]);
    general.push(['C_Cpp.codeAnalysis.clangTidy.useBuildPath', false]);
  }
  for (const [key, value] of general) {
    await all.update(key, value, target);
  }
}

export async function SetupEnvironment(
  folder?: vscode.WorkspaceFolder,
  mode: Overwrite = 'ask',
): Promise<void> {
  folder ??= await PickFolder();
  if (!folder) return;
  const root = folder.uri.fsPath;
  const tidy = TidyConfig(root);
  if (tidy === undefined) return;

  const writer = new FileWriter(mode);
  await writer.Write(path.join(root, '.clang-format'), templates.kClangFormat);
  await writer.Write(path.join(root, '.clang-tidy'), tidy);
  await writer.Write(path.join(root, '.editorconfig'), templates.kEditorConfig);
  if (!fs.existsSync(path.join(root, '.gitignore'))) {
    await writer.Write(path.join(root, '.gitignore'), templates.kGitIgnore);
  }
  const recommendations = path.join(root, '.vscode', 'extensions.json');
  if (!fs.existsSync(recommendations)) {
    await writer.Write(
      recommendations,
      `${JSON.stringify(
        {
          recommendations: [kClangdExtension, 'kewldan.itmo-cpp-labkit'],
        },
        null,
        2,
      )}\n`,
    );
  }
  // Послабления clang-tidy под макросы GoogleTest в каждой папке tests/.
  const test_files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, '**/tests/*.{cc,cpp}'),
    '**/{build,node_modules,.*}/**',
  );
  const test_dirs = new Set(test_files.map((uri) => path.dirname(uri.fsPath)));
  for (const dir of test_dirs) {
    const file = path.join(dir, '.clang-tidy');
    if (!fs.existsSync(file)) {
      await writer.Write(file, templates.kTestsClangTidy);
    }
  }
  ExcludeLabkitFromGit(root);
  await ApplyEditorSettings(folder);

  const message = T(
    'Environment is set up: {0} files written, {1} ' +
      'skipped, editor settings updated.',
    writer.written.length,
    writer.skipped.length,
  );
  if (!vscode.extensions.getExtension(kClangdExtension)) {
    const install = T('Install clangd');
    const answer = await vscode.window.showInformationMessage(
      `${message} ${T(
        'The clangd extension is needed to see ' +
          'clang-tidy warnings right in the editor.',
      )}`,
      install,
    );
    if (answer === install) {
      await vscode.commands.executeCommand(
        'workbench.extensions.installExtension',
        kClangdExtension,
      );
    }
  } else {
    void vscode.window.showInformationMessage(message);
  }
}

// .labkit/ с учётом времени не должен попадать в коммиты, но .gitignore
// чужого репозитория трогать не хочется: пишем в локальный .git/info/exclude.
export function ExcludeLabkitFromGit(root: string): void {
  const git = path.join(root, '.git');
  if (!fs.existsSync(git) || !fs.statSync(git).isDirectory()) return;
  const exclude = path.join(git, 'info', 'exclude');
  const current = fs.existsSync(exclude)
    ? fs.readFileSync(exclude, 'utf8')
    : '';
  if (current.split('\n').includes('.labkit/')) return;
  fs.mkdirSync(path.dirname(exclude), {recursive: true});
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(exclude, `${separator}.labkit/\n`);
}

async function PickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showErrorMessage(T('Open a lab folder first.'));
    return undefined;
  }
  if (folders.length === 1) return folders[0];
  return vscode.window.showWorkspaceFolderPick();
}

// Пишет compile_flags.txt через make flags, чтобы clangd видел GoogleTest.
function GenerateCompileFlags(lab_root: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('make', ['-s', 'flags'], {cwd: lab_root}, () => resolve());
  });
}

export async function GenerateMakefile(target?: vscode.Uri): Promise<void> {
  let root: string;
  let folder: vscode.WorkspaceFolder | undefined;
  if (target) {
    root = target.fsPath;
    folder = vscode.workspace.getWorkspaceFolder(target);
  } else {
    const lab = CurrentLab();
    if (!lab) return;
    root = lab.root;
    folder = lab.workspaceFolder;
  }
  if (!folder) return;
  const name = MakeLab(root, folder).name.replace(/[^A-Za-z0-9_-]/g, '_');
  const src_dir = fs.existsSync(path.join(root, 'src')) ? 'src' : '.';
  const writer = new FileWriter('ask');
  await writer.Write(
    path.join(root, 'Makefile'),
    templates.Makefile({lab: name, srcDir: src_dir, lang: UiLang()}),
  );
  if (writer.written.length === 0) return;
  await GenerateCompileFlags(root);
  const doc = await vscode.workspace.openTextDocument(
    path.join(root, 'Makefile'),
  );
  await vscode.window.showTextDocument(doc);
}
