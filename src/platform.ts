import * as fs from 'node:fs';
import * as vscode from 'vscode';

import {T} from './i18n';

export type Platform = 'macos' | 'wsl' | 'linux' | 'windows';

let cached: Platform | undefined;

// Где работает расширение. При Remote - WSL это сторона WSL, а не Windows.
export function DetectPlatform(): Platform {
  if (cached) return cached;
  if (process.platform === 'darwin') {
    cached = 'macos';
  } else if (process.platform === 'win32') {
    cached = 'windows';
  } else {
    let version = '';
    try {
      version = fs.readFileSync('/proc/version', 'utf8');
    } catch {
      // Не Linux с procfs.
    }
    cached =
      vscode.env.remoteName === 'wsl' || /microsoft/i.test(version)
        ? 'wsl'
        : 'linux';
  }
  return cached;
}

export function InstallHint(platform = DetectPlatform()): string {
  if (platform === 'macos') {
    return 'brew install llvm googletest pkg-config';
  }
  return (
    'sudo apt install clang clang-tidy clang-format clangd make ' +
    'libgtest-dev pkg-config'
  );
}

// Нативная Windows не поддерживается: make, санитайзеры и bash-хуки живут
// в WSL. Возвращает false и подсказывает открыть папку в WSL.
export function EnsureSupported(): boolean {
  if (DetectPlatform() !== 'windows') return true;
  const reopen = T('Reopen in WSL');
  void vscode.window
    .showWarningMessage(
      T(
        'Lab Kit works on macOS and in WSL. Open the folder in WSL ' +
          'to build, test and check labs.',
      ),
      reopen,
    )
    .then((answer) => {
      if (answer === reopen) {
        void vscode.commands.executeCommand('remote-wsl.reopenInWSL');
      }
    });
  return false;
}
