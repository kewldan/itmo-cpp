import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('kewldan.itmo-cpp-labkit');
  assert.ok(extension, 'расширение не найдено');
  await extension.activate();
  const lang = process.env.LABKIT_LANG === 'ru' ? 'ru' : 'en';
  await vscode.workspace
    .getConfiguration('labkit')
    .update('language', lang, vscode.ConfigurationTarget.Global);

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    'labkit.setupEnvironment',
    'labkit.generateMakefile',
    'labkit.check',
    'labkit.timeReport',
    'labkit.installGitHooks',
  ]) {
    assert.ok(commands.includes(command), `нет команды ${command}`);
  }

  const workspace = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspace, 'нет папки рабочей области');
  const folder = workspace.uri.fsPath;
  const uri = vscode.Uri.file(path.join(folder, 'lab1', 'src', 'solution.cc'));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    'vscode.executeCodeLensProvider',
    uri,
  );
  const titles = lenses.map((l) => l.command?.title ?? '');
  console.log('CodeLens:', titles);
  const ru = lang === 'ru';
  assert.ok(
    titles.some((t) => t.includes(ru ? 'сложность 1' : 'complexity 1')),
  );

  // Карточка при наведении на имя функции.
  const fn = doc.getText().indexOf('Add(');
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    uri,
    doc.positionAt(fn + 1),
  );
  const card = hovers
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === 'string' ? c : c.value))
    .join('\n');
  console.log('Hover:', card);
  assert.ok(
    card.includes(ru ? 'Цикломатическая сложность' : 'Cyclomatic complexity'),
  );
  await vscode.commands.executeCommand(
    'labkit.toggleComplexityDetails',
    uri.toString(),
    2,
  );

  // Даём диагностике отработать на «плохом» файле.
  const bad = await vscode.workspace.openTextDocument({
    language: 'cpp',
    content: `int F(int a) {\n${'if (a == 1) a++;\n'.repeat(12)}return a;\n}\n`,
  });
  await vscode.window.showTextDocument(bad);
  // Панель условия.
  await vscode.commands.executeCommand('labkit.task.focus');
  await vscode.window.showTextDocument(doc);
  const api = extension.exports as {taskView: {html?: string}};
  for (let i = 0; i < 50 && !api.taskView.html?.includes('<h1'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(api.taskView.html?.includes('<h1'), 'условие не отрисовалось');
  if (process.env.LABKIT_DUMP_HTML) {
    require('node:fs').writeFileSync(
      process.env.LABKIT_DUMP_HTML,
      api.taskView.html,
    );
  }
  console.log('OK: команды, CodeLens и панель условия работают');
}
