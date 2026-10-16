import {spawn} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import {CmakeScript, ParseCtestExecutables} from './cmake';
import {type DiscoveredTest, DiscoverTests, NormalizeResultName} from './gtest';
import {T} from './i18n';
import {CmakeBuildDir, DetectBuildSystem, FindLab, type Lab} from './lab';
import {CmakeOptions} from './tasks';

function IsTestFile(file: string): boolean {
  return (
    /_tests?\.(cc|cpp)$/.test(file) ||
    /[\\/]tests?[\\/][^\\/]+\.(cc|cpp)$/.test(file)
  );
}

interface TestMeta {
  lab: Lab;
  test?: DiscoveredTest;
}

interface GtestResult {
  failed: boolean;
  messages: vscode.TestMessage[];
  ms: number;
}

interface GtestJson {
  testsuites?: Array<{
    name: string;
    testsuite?: Array<{
      name: string;
      result?: string;
      time?: string;
      failures?: Array<{failure: string}>;
    }>;
  }>;
}

function Run(
  command: string,
  args: string[],
  cwd: string,
  token: vscode.CancellationToken,
  on_output: (text: string) => void,
  {stderr = true} = {},
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {cwd});
    const cancel = token.onCancellationRequested(() => child.kill());
    const Forward = (data: Buffer) => on_output(data.toString());
    child.stdout.on('data', Forward);
    if (stderr) child.stderr.on('data', Forward);
    child.on('error', (error) => {
      on_output(`${error.message}\n`);
      cancel.dispose();
      resolve(null);
    });
    child.on('close', (code) => {
      cancel.dispose();
      resolve(code);
    });
  });
}

function ParseFailure(text: string, lab: Lab): vscode.TestMessage {
  const [first, ...rest] = text.split('\n');
  const message = new vscode.TestMessage(rest.join('\n') || text);
  const match = /^(.*):(\d+)$/.exec(first);
  if (match) {
    const file = path.resolve(lab.root, match[1]);
    message.location = new vscode.Location(
      vscode.Uri.file(file),
      new vscode.Position(Number(match[2]) - 1, 0),
    );
  }
  return message;
}

function ReadResults(file: string, lab: Lab): Map<string, GtestResult> {
  const results = new Map<string, GtestResult>();
  const json = JSON.parse(fs.readFileSync(file, 'utf8')) as GtestJson;
  for (const suite of json.testsuites ?? []) {
    for (const test of suite.testsuite ?? []) {
      if (test.result === 'SKIPPED' || test.result === 'SUPPRESSED') continue;
      const key = NormalizeResultName(suite.name, test.name);
      const entry = results.get(key) ?? {failed: false, messages: [], ms: 0};
      const failures = test.failures ?? [];
      entry.failed ||= failures.length > 0;
      entry.messages.push(...failures.map((f) => ParseFailure(f.failure, lab)));
      entry.ms += parseFloat(test.time ?? '0') * 1000;
      results.set(key, entry);
    }
  }
  return results;
}

export class GtestController implements vscode.Disposable {
  private readonly controller_ = vscode.tests.createTestController(
    'labkit-gtest',
    T('Labs (GoogleTest)'),
  );
  private readonly meta_ = new WeakMap<vscode.TestItem, TestMeta>();
  private readonly disposables_: vscode.Disposable[] = [];
  // Итог последнего запуска — для smoke-теста.
  lastSummary:
    | Record<'passed' | 'failed' | 'errored' | 'skipped', number>
    | undefined;

  constructor() {
    this.controller_.resolveHandler = async (item) => {
      if (!item) await this.DiscoverAll();
    };
    this.controller_.refreshHandler = () => this.DiscoverAll();
    this.controller_.createRunProfile(
      T('Run'),
      vscode.TestRunProfileKind.Run,
      (request, token) => this.RunTests(request, token),
      true,
    );

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{cc,cpp}');
    const Reparse = (uri: vscode.Uri) => {
      if (IsTestFile(uri.fsPath) && !uri.fsPath.includes('/build/')) {
        void this.ParseFile(uri);
      }
    };
    let pending: NodeJS.Timeout | undefined;
    this.disposables_.push(
      this.controller_,
      watcher,
      watcher.onDidCreate(Reparse),
      watcher.onDidChange(Reparse),
      watcher.onDidDelete((uri) => this.RemoveFile(uri)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!IsTestFile(e.document.uri.fsPath)) return;
        clearTimeout(pending);
        pending = setTimeout(
          () => this.UpdateFile(e.document.uri, e.document.getText()),
          500,
        );
      }),
      {dispose: () => clearTimeout(pending)},
    );
  }

  dispose(): void {
    this.disposables_.forEach((d) => {
      d.dispose();
    });
  }

  async DiscoverAll(): Promise<void> {
    // Вложенные {} glob в VS Code не поддерживает, поэтому фильтруем сами.
    const files = await vscode.workspace.findFiles(
      '**/*.{cc,cpp}',
      '**/{build,_deps,node_modules,.*}/**',
    );
    await Promise.all(
      files
        .filter((uri) => IsTestFile(uri.fsPath))
        .map((uri) => this.ParseFile(uri)),
    );
  }

  private async ParseFile(uri: vscode.Uri): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      this.UpdateFile(uri, Buffer.from(bytes).toString('utf8'));
    } catch {
      this.RemoveFile(uri);
    }
  }

  private LabItem(lab: Lab): vscode.TestItem {
    const existing = this.controller_.items.get(lab.root);
    if (existing) return existing;
    const item = this.controller_.createTestItem(
      lab.root,
      lab.name,
      vscode.Uri.file(lab.root),
    );
    this.meta_.set(item, {lab});
    this.controller_.items.add(item);
    return item;
  }

  private UpdateFile(uri: vscode.Uri, text: string): void {
    const lab = FindLab(uri.fsPath);
    if (!lab) return;
    const tests = DiscoverTests(text);
    const lab_item = this.LabItem(lab);
    const id = uri.toString();
    if (tests.length === 0) {
      lab_item.children.delete(id);
      if (lab_item.children.size === 0) this.controller_.items.delete(lab.root);
      return;
    }
    const file_item =
      lab_item.children.get(id) ??
      this.controller_.createTestItem(
        id,
        path.relative(lab.root, uri.fsPath),
        uri,
      );
    this.meta_.set(file_item, {lab});
    file_item.children.replace(
      tests.map((test) => {
        const item = this.controller_.createTestItem(
          `${id}#${test.suite}.${test.name}`,
          `${test.suite}.${test.name}`,
          uri,
        );
        item.range = new vscode.Range(test.line, 0, test.line, 0);
        this.meta_.set(item, {lab, test});
        return item;
      }),
    );
    lab_item.children.add(file_item);
  }

  private RemoveFile(uri: vscode.Uri): void {
    this.controller_.items.forEach((lab_item) => {
      lab_item.children.delete(uri.toString());
      if (lab_item.children.size === 0) {
        this.controller_.items.delete(lab_item.id);
      }
    });
  }

  // Метаданные есть у каждого элемента, созданного контроллером.
  private Meta(item: vscode.TestItem): TestMeta {
    const meta = this.meta_.get(item);
    if (!meta) throw new Error(`labkit: no metadata for ${item.id}`);
    return meta;
  }

  private Test(item: vscode.TestItem): DiscoveredTest {
    const test = this.Meta(item).test;
    if (!test) throw new Error(`labkit: ${item.id} is not a test`);
    return test;
  }

  private Leaves(item: vscode.TestItem, into: vscode.TestItem[]): void {
    if (item.children.size === 0) {
      if (this.meta_.get(item)?.test) into.push(item);
      return;
    }
    item.children.forEach((child) => {
      this.Leaves(child, into);
    });
  }

  private async RunTests(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (this.controller_.items.size === 0) await this.DiscoverAll();
    const run = this.controller_.createTestRun(request);
    const summary = {passed: 0, failed: 0, errored: 0, skipped: 0};
    const excluded = new Set(request.exclude ?? []);
    const leaves: vscode.TestItem[] = [];
    if (request.include) {
      request.include.forEach((item) => {
        this.Leaves(item, leaves);
      });
    } else {
      this.controller_.items.forEach((item) => {
        this.Leaves(item, leaves);
      });
    }
    const by_lab = new Map<string, vscode.TestItem[]>();
    for (const leaf of leaves) {
      if (excluded.has(leaf)) continue;
      const root = this.Meta(leaf).lab.root;
      by_lab.set(root, [...(by_lab.get(root) ?? []), leaf]);
    }
    for (const items of by_lab.values()) {
      if (token.isCancellationRequested) break;
      const whole_lab = request.include === undefined && excluded.size === 0;
      await this.RunLab(
        this.Meta(items[0]).lab,
        items,
        whole_lab,
        run,
        token,
        summary,
      );
    }
    run.end();
    this.lastSummary = summary;
  }

  private async RunLab(
    lab: Lab,
    items: vscode.TestItem[],
    whole_lab: boolean,
    run: vscode.TestRun,
    token: vscode.CancellationToken,
    summary: Record<string, number>,
  ): Promise<void> {
    const Output = (text: string) =>
      run.appendOutput(text.replace(/\r?\n/g, '\r\n'));
    items.forEach((item) => {
      run.enqueued(item);
    });
    await vscode.workspace.saveAll(false);

    // 1. Сборка.
    let build_log = '';
    const system = DetectBuildSystem(lab);
    const cmake = system === 'cmake';
    const extra = vscode.workspace
      .getConfiguration('labkit.tests')
      .get<string[]>('buildArgs', []);
    const [command, build_args] = cmake
      ? ['bash', ['-c', CmakeScript('build', CmakeOptions(lab))]]
      : ['make', ['build-tests', ...extra]];
    Output(`▶ ${lab.name}: ${cmake ? 'cmake --build' : 'make build-tests'}\n`);
    const build_code = await Run(
      command,
      build_args,
      lab.root,
      token,
      (text) => {
        build_log += text;
        Output(text);
      },
    );
    if (build_code !== 0) {
      const message = new vscode.TestMessage(
        `${T('Tests failed to build:')}\n${build_log.slice(-4000)}`,
      );
      items.forEach((item) => {
        run.errored(item, message);
      });
      summary.errored += items.length;
      return;
    }

    // 2. Какие бинарники запускать.
    const executables = cmake
      ? await this.CtestExecutables(lab, token)
      : [path.join(lab.root, 'build', 'tests')];
    if (executables.length === 0) {
      const message = new vscode.TestMessage(
        T(
          'No test executables found: ctest knows no tests. Add ' +
            'gtest_discover_tests() to CMakeLists.txt.',
        ),
      );
      items.forEach((item) => {
        run.errored(item, message);
      });
      summary.errored += items.length;
      return;
    }

    // 3. Запуск с фильтром и отчётом в JSON.
    const filter = whole_lab
      ? undefined
      : items
          .map((item) => {
            const test = this.Test(item);
            const exact = test.macro === 'TEST' || test.macro === 'TEST_F';
            return exact
              ? `${test.suite}.${test.name}`
              : `*${test.suite}*.${test.name}*`;
          })
          .join(':');
    items.forEach((item) => {
      run.started(item);
    });
    const reports_dir = cmake
      ? CmakeBuildDir(lab)
      : path.join(lab.root, 'build');
    const results = new Map<string, GtestResult>();
    const crashes: string[] = [];
    for (const [i, executable] of executables.entries()) {
      if (token.isCancellationRequested) break;
      const results_file = path.join(reports_dir, `labkit_results_${i}.json`);
      fs.rmSync(results_file, {force: true});
      const args = [`--gtest_output=json:${results_file}`, '--gtest_color=no'];
      if (filter) args.push(`--gtest_filter=${filter}`);
      let log = '';
      const code = await Run(executable, args, lab.root, token, (text) => {
        log += text;
        Output(text);
      });
      if (!fs.existsSync(results_file)) {
        // Упал сам бинарник: санитайзер, segfault, исключение вне теста.
        crashes.push(
          T(
            'The test binary exited with code {0} without a report:',
            String(code),
          ) +
            ` ${path.basename(executable)}\n` +
            log.slice(-4000),
        );
        continue;
      }
      for (const [key, result] of ReadResults(results_file, lab)) {
        const entry = results.get(key);
        if (!entry) {
          results.set(key, result);
        } else {
          entry.failed ||= result.failed;
          entry.messages.push(...result.messages);
          entry.ms += result.ms;
        }
      }
    }
    const crash = crashes.length
      ? new vscode.TestMessage(crashes.join('\n\n'))
      : undefined;
    for (const item of items) {
      const test = this.Test(item);
      const result = results.get(`${test.suite}.${test.name}`);
      if (result?.failed) {
        run.failed(item, result.messages, result.ms);
        summary.failed++;
      } else if (result) {
        run.passed(item, result.ms);
        summary.passed++;
      } else if (crash) {
        run.errored(item, crash);
        summary.errored++;
      } else {
        run.skipped(item);
        summary.skipped++;
      }
    }
  }

  // Бинарники с тестами по данным ctest.
  private async CtestExecutables(
    lab: Lab,
    token: vscode.CancellationToken,
  ): Promise<string[]> {
    let json = '';
    await Run(
      'ctest',
      ['--test-dir', CmakeBuildDir(lab), '--show-only=json-v1'],
      lab.root,
      token,
      (text) => (json += text),
      {stderr: false},
    );
    try {
      return ParseCtestExecutables(json);
    } catch {
      return [];
    }
  }
}
