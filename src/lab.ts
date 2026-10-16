import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import type {Limits} from './templates';

export interface LabConfig {
  name?: string;
  deadline?: string; // YYYY-MM-DD
}

export interface Lab {
  root: string;
  name: string;
  config: LabConfig;
  workspaceFolder: vscode.WorkspaceFolder;
}

// Папки сборки: CMake кладёт туда свои Makefile, но лабой они не являются.
function IsBuildDir(name: string): boolean {
  return /^(build|out|_deps|cmake-build-.*|\.cache|node_modules)$/.test(name);
}

// Корень лабы: ближайшая папка с .labkit.json, иначе корень git-репозитория
// (каждая лаба — свой репозиторий), иначе ближайшая папка с Makefile вне
// папок сборки, иначе папка рабочей области.
export function FindLab(file: string): Lab | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
  if (!folder) return undefined;
  const top = folder.uri.fsPath;
  let dir = path.dirname(file);
  // Файлы из build/ относим к лабе, внутри которой лежит build/.
  const relative = path.relative(top, dir).split(path.sep);
  const build = relative.findIndex(IsBuildDir);
  if (build >= 0) dir = path.join(top, ...relative.slice(0, build));

  let with_makefile: string | undefined;
  while (dir.startsWith(top)) {
    if (
      fs.existsSync(path.join(dir, '.labkit.json')) ||
      fs.existsSync(path.join(dir, '.git'))
    ) {
      return MakeLab(dir, folder);
    }
    if (!with_makefile && fs.existsSync(path.join(dir, 'Makefile'))) {
      with_makefile = dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return MakeLab(with_makefile ?? top, folder);
}

export function MakeLab(root: string, folder: vscode.WorkspaceFolder): Lab {
  let config: LabConfig = {};
  try {
    config = JSON.parse(
      fs.readFileSync(path.join(root, '.labkit.json'), 'utf8'),
    ) as LabConfig;
  } catch {
    // Конфига нет или он битый — живём с именем папки.
  }
  return {
    root,
    name: config.name ?? path.basename(root),
    config,
    workspaceFolder: folder,
  };
}

// Лаба активного редактора, иначе первой папки рабочей области.
export function CurrentLab(): Lab | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.uri.scheme === 'file') {
    const lab = FindLab(editor.document.uri.fsPath);
    if (lab) return lab;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? MakeLab(folder.uri.fsPath, folder) : undefined;
}

// labkit — наш Makefile, cmake — CMakeLists.txt (Makefile рядом обычно лишь
// обёртка над cmake), make — чужой Makefile.
export type BuildSystem = 'labkit' | 'cmake' | 'make' | 'none';

export function DetectBuildSystem(lab: Lab): BuildSystem {
  const makefile = path.join(lab.root, 'Makefile');
  const has_makefile = fs.existsSync(makefile);
  if (
    has_makefile &&
    fs.readFileSync(makefile, 'utf8').includes('ITMO C++ Lab Kit')
  ) {
    return 'labkit';
  }
  if (fs.existsSync(path.join(lab.root, 'CMakeLists.txt'))) return 'cmake';
  return has_makefile ? 'make' : 'none';
}

export function HasBuildSystem(lab: Lab): boolean {
  return DetectBuildSystem(lab) !== 'none';
}

export function CmakeBuildDir(lab: Lab): string {
  const dir = vscode.workspace
    .getConfiguration('labkit.cmake')
    .get<string>('buildDir', 'build');
  return path.resolve(lab.root, dir || 'build');
}

// Тесты — папки tests/ и test/ и файлы *_test(s).*: их обычно даёт
// преподаватель. Путь — относительно корня лабы.
export function IsTestPath(relative: string): boolean {
  return (
    /(^|[\\/])tests?[\\/]/.test(relative) ||
    /_tests?\.[A-Za-z]+$/.test(relative)
  );
}

export function ComplexityLimits(): Limits {
  const c = vscode.workspace.getConfiguration('labkit.complexity');
  return {
    maxCyclomatic: c.get('maxCyclomatic', 10),
    maxCognitive: c.get('maxCognitive', 15),
    maxLines: c.get('maxLines', 40),
    maxParams: c.get('maxParams', 5),
    maxNesting: c.get('maxNesting', 4),
  };
}

function LlvmCandidates(): string[] {
  const configured = vscode.workspace
    .getConfiguration('labkit')
    .get<string>('llvmBinDir');
  const dirs = configured ? [configured] : [];
  dirs.push('/opt/homebrew/opt/llvm/bin', '/usr/local/opt/llvm/bin');
  try {
    // /usr/lib/llvm-18, /usr/lib/llvm-19, … — новые первыми.
    const versions = fs
      .readdirSync('/usr/lib')
      .filter((d) => /^llvm-\d+$/.test(d))
      .sort((a, b) => Number(b.slice(5)) - Number(a.slice(5)));
    dirs.push(...versions.map((d) => `/usr/lib/${d}/bin`));
  } catch {
    // Не Linux.
  }
  return dirs;
}

// Ubuntu кладёт версионные бинарники: /usr/bin/clang-tidy-18.
function VersionedInPath(name: string): string | undefined {
  let best: {file: string; version: number} | undefined;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const match = new RegExp(`^${name.replace(/\+/g, '\\+')}-(\\d+)$`).exec(
        entry,
      );
      if (match && (!best || Number(match[1]) > best.version)) {
        best = {file: path.join(dir, entry), version: Number(match[1])};
      }
    }
  }
  return best?.file;
}

function InPath(name: string): boolean {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .some((dir) => fs.existsSync(path.join(dir, name)));
}

// Полный путь к инструменту LLVM или просто имя, чтобы искать в PATH.
export function LlvmTool(name: string): string {
  for (const dir of LlvmCandidates()) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  if (InPath(name)) return name;
  return VersionedInPath(name) ?? name;
}
