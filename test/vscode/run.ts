import * as path from 'node:path';
import {runTests} from '@vscode/test-electron';

// Smoke-тест в настоящем VS Code: bun run test:vscode <папка с лабами>.
async function Main(): Promise<void> {
  const root = path.resolve(__dirname, '../../..');
  const workspace = process.argv[2];
  if (!workspace) throw new Error('Укажите папку рабочей области');
  await runTests({
    vscodeExecutablePath:
      process.env.VSCODE_PATH ??
      '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'suite.js'),
    launchArgs: [workspace, '--disable-extensions'],
    extensionTestsEnv: {LABKIT_LANG: process.env.LABKIT_LANG ?? 'en'},
  });
}

Main().catch((error) => {
  console.error(error);
  process.exit(1);
});
