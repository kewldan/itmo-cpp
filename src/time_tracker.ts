import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import {T} from './i18n';
import {FindLab, type Lab, MakeLab} from './lab';
import {ShowReport} from './report';
import {ExcludeLabkitFromGit} from './setup';
import {
  ActivityClock,
  AddTime,
  DaysLeft,
  EmptyTimeData,
  FormatDuration as FormatWithUnits,
  LocalDate,
  ParseTimeData,
  type TimeData,
} from './time_log';

function FormatDuration(seconds: number): string {
  return FormatWithUnits(seconds, {hour: T('h'), minute: T('min')});
}

const kTickMs = 15000;
const kFlushMs = 60000;

function TimeFile(lab_root: string): string {
  return path.join(lab_root, '.labkit', 'time.json');
}

export class TimeTracker implements vscode.Disposable {
  private readonly status_ = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  private readonly data_ = new Map<string, TimeData>();
  private readonly dirty_ = new Set<string>();
  private readonly excluded_ = new Set<string>();
  private readonly disposables_: vscode.Disposable[] = [];
  private clock_: ActivityClock;
  private lab_: Lab | undefined;
  private paused_ = false;

  constructor() {
    this.clock_ = this.NewClock();
    this.status_.command = 'labkit.timeReport';
    const Activity = () => this.clock_.Activity(Date.now());
    const tick = setInterval(() => this.Tick(), kTickMs);
    const flush = setInterval(() => this.Flush(), kFlushMs);
    this.disposables_.push(
      this.status_,
      {dispose: () => clearInterval(tick)},
      {dispose: () => clearInterval(flush)},
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.Follow(editor);
        Activity();
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme === 'file') Activity();
      }),
      vscode.workspace.onDidSaveTextDocument(Activity),
      vscode.window.onDidChangeTextEditorSelection(Activity),
      vscode.window.onDidChangeTextEditorVisibleRanges(Activity),
      vscode.window.onDidChangeActiveTerminal(Activity),
      vscode.window.onDidStartTerminalShellExecution(Activity),
      vscode.debug.onDidStartDebugSession(Activity),
      vscode.tasks.onDidStartTask(Activity),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) Activity();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('labkit.time') ||
          e.affectsConfiguration('labkit.language')
        ) {
          this.clock_ = this.NewClock();
          this.Render();
        }
      }),
    );
    this.Follow(vscode.window.activeTextEditor);
    Activity();
  }

  dispose(): void {
    this.Tick();
    this.Flush();
    this.disposables_.forEach((d) => {
      d.dispose();
    });
  }

  TogglePause(): void {
    this.paused_ = !this.paused_;
    // Возобновление не должно засчитать время паузы.
    this.clock_ = this.NewClock();
    this.clock_.Activity(Date.now());
    this.Render();
  }

  private NewClock(): ActivityClock {
    const idle = vscode.workspace
      .getConfiguration('labkit.time')
      .get<number>('idleMinutes', 5);
    return new ActivityClock(idle * 60000, 2 * kTickMs, Date.now());
  }

  private Enabled(): boolean {
    return vscode.workspace
      .getConfiguration('labkit.time')
      .get('enabled', true);
  }

  // Время идёт на лабу последнего открытого файла: пока смотрите в терминал
  // или в «Проблемы», лаба не меняется.
  private Follow(editor: vscode.TextEditor | undefined): void {
    if (editor?.document.uri.scheme !== 'file') {
      if (!this.lab_) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (folder) this.lab_ = MakeLab(folder.uri.fsPath, folder);
      }
    } else {
      this.lab_ = FindLab(editor.document.uri.fsPath) ?? this.lab_;
    }
    this.Render();
  }

  private Data(lab_root: string): TimeData {
    let data = this.data_.get(lab_root);
    if (!data) {
      try {
        data = ParseTimeData(fs.readFileSync(TimeFile(lab_root), 'utf8'));
      } catch {
        data = EmptyTimeData();
      }
      this.data_.set(lab_root, data);
    }
    return data;
  }

  private Tick(): void {
    const ms = this.clock_.Tick(Date.now());
    if (!this.lab_ || this.paused_ || !this.Enabled() || ms === 0) return;
    AddTime(this.Data(this.lab_.root), ms / 1000, new Date());
    this.dirty_.add(this.lab_.root);
    this.Render();
  }

  private Flush(): void {
    for (const root of this.dirty_) {
      try {
        const file = TimeFile(root);
        if (!this.excluded_.has(root)) {
          // Чтобы .labkit/ не висела в git как неотслеживаемая папка.
          ExcludeLabkitFromGit(root);
          this.excluded_.add(root);
        }
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(
          file,
          `${JSON.stringify(this.data_.get(root), null, 2)}\n`,
        );
      } catch (error) {
        console.error('labkit: failed to save time', error);
      }
    }
    this.dirty_.clear();
  }

  private Render(): void {
    if (!this.lab_ || !this.Enabled()) {
      this.status_.hide();
      return;
    }
    const data = this.Data(this.lab_.root);
    const today = data.days[LocalDate(new Date())] ?? 0;
    const icon = this.paused_ ? '$(debug-pause)' : '$(clock)';
    let text = `${icon} ${this.lab_.name} ${FormatDuration(data.totalSeconds)}`;
    const tooltip = [
      T('Lab: {0}', this.lab_.name),
      T('Today: {0}', FormatDuration(today)),
      T('Total: {0}', FormatDuration(data.totalSeconds)),
    ];
    const deadline = this.lab_.config.deadline;
    const left = deadline ? DaysLeft(deadline, new Date()) : undefined;
    if (left !== undefined) {
      text +=
        left < 0
          ? ` · $(error) ${T('overdue')}`
          : ` · $(calendar) ${T('{0} d', left)}`;
      tooltip.push(T('Deadline: {0}', deadline ?? ''));
      this.status_.backgroundColor =
        left <= 1
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
    }
    if (this.paused_) tooltip.push(T('Tracking is paused'));
    tooltip.push('', T('Click to open the report'));
    this.status_.text = text;
    this.status_.tooltip = tooltip.join('\n');
    this.status_.show();
  }

  async Report(): Promise<void> {
    this.Tick();
    this.Flush();
    const files = await vscode.workspace.findFiles(
      '**/.labkit/time.json',
      '**/node_modules/**',
    );
    const labs: Array<{lab: Lab; data: TimeData}> = [];
    for (const file of files) {
      const root = path.dirname(path.dirname(file.fsPath));
      const folder = vscode.workspace.getWorkspaceFolder(file);
      if (folder) {
        labs.push({lab: MakeLab(root, folder), data: this.Data(root)});
      }
    }
    labs.sort((a, b) =>
      a.lab.name.localeCompare(b.lab.name, undefined, {numeric: true}),
    );
    const total = labs.reduce((sum, l) => sum + l.data.totalSeconds, 0);
    const lines = [
      `# ${T('Time spent on labs')}`,
      '',
      T('Total: **{0}**.', FormatDuration(total)),
      '',
      `| ${T('Lab')} | ${T('Total')} | ${T('Days worked')} | ` +
        `${T('Started')} | ${T('Last seen')} | ` +
        `${T('Deadline')} |`,
      '|---|---:|---:|---|---|---|',
      ...labs.map(
        ({lab, data}) =>
          `| ${lab.name} | ${FormatDuration(data.totalSeconds)} | ` +
          `${Object.keys(data.days).length} | ` +
          `${data.firstSeen?.slice(0, 10) ?? '—'} | ` +
          `${data.lastSeen?.slice(0, 10) ?? '—'} | ` +
          `${lab.config.deadline ?? '—'} |`,
      ),
    ];
    for (const {lab, data} of labs) {
      lines.push(
        '',
        `## ${lab.name}`,
        '',
        `| ${T('Day')} | ${T('Time')} | |`,
        '|---|---:|---|',
      );
      const max = Math.max(...Object.values(data.days), 1);
      for (const [day, seconds] of Object.entries(data.days).sort()) {
        const bar = '█'.repeat(Math.max(1, Math.round((seconds / max) * 20)));
        lines.push(`| ${day} | ${FormatDuration(seconds)} | ${bar} |`);
      }
    }
    lines.push('');
    await ShowReport('time', T('Time spent on labs'), lines.join('\n'));
  }
}
