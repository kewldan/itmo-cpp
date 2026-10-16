import * as path from 'node:path';
import * as vscode from 'vscode';

import {T} from '../i18n';
import {ComplexityLimits, CurrentLab, FindLab, IsTestPath} from '../lab';
import {OpenLink, ShowReport} from '../report';
import {
  Analyze,
  type DecisionPoint,
  type FunctionMetrics,
  type MetricLimits,
  type Violation,
  Violations,
} from './analyzer';

const kLanguages = ['c', 'cpp', 'cuda-cpp'];
const kToggleCommand = 'labkit.toggleComplexityDetails';

function MetricName(metric: Violation['metric']): string {
  switch (metric) {
    case 'cyclomatic':
      return T('Cyclomatic complexity');
    case 'cognitive':
      return T('Cognitive complexity');
    case 'lines':
      return T('Lines of code');
    case 'params':
      return T('Parameters');
    case 'nesting':
      return T('Nesting depth');
  }
}

function Enabled(): boolean {
  return vscode.workspace
    .getConfiguration('labkit.complexity')
    .get('enabled', true);
}

function IsCpp(doc: vscode.TextDocument): boolean {
  return kLanguages.includes(doc.languageId) && doc.uri.scheme === 'file';
}

// Кеш метрик по версии документа: CodeLens, hover и диагностика считают
// один раз.
class MetricsCache {
  private cache_ = new Map<
    string,
    {version: number; metrics: FunctionMetrics[]}
  >();

  Get(doc: vscode.TextDocument): FunctionMetrics[] {
    const key = doc.uri.toString();
    const hit = this.cache_.get(key);
    if (hit?.version === doc.version) return hit.metrics;
    const metrics = Analyze(doc.getText());
    this.cache_.set(key, {version: doc.version, metrics});
    return metrics;
  }

  Forget(doc: vscode.TextDocument): void {
    this.cache_.delete(doc.uri.toString());
  }
}

function Summary(m: FunctionMetrics): string {
  return T(
    'complexity {0} · cognitive {1} · {2} lines · {3} params · ' +
      'nesting {4}',
    m.cyclomatic,
    m.cognitive,
    m.lines,
    m.params,
    m.maxNesting,
  );
}

function Values(
  m: FunctionMetrics,
  limits: MetricLimits,
): Array<[Violation['metric'], number, number]> {
  return [
    ['cyclomatic', m.cyclomatic, limits.maxCyclomatic],
    ['cognitive', m.cognitive, limits.maxCognitive],
    ['lines', m.lines, limits.maxLines],
    ['params', m.params, limits.maxParams],
    ['nesting', m.maxNesting, limits.maxNesting],
  ];
}

// Карточка при наведении на имя функции.
function HoverCard(
  m: FunctionMetrics,
  uri: vscode.Uri,
  showing: boolean,
): vscode.MarkdownString {
  const limits = ComplexityLimits();
  const bad = Violations(m, limits).length;
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = {enabledCommands: [kToggleCommand]};
  md.appendMarkdown(`**${Escape(m.name)}** — `);
  md.appendMarkdown(
    bad
      ? `$(warning) ${T('{0} of 5 limits exceeded', bad)}\n\n`
      : `$(pass) ${T('all limits met')}\n\n`,
  );
  md.appendMarkdown(`| | ${T('Value')} | ${T('Limit')} |\n`);
  md.appendMarkdown('|---|---:|---:|\n');
  for (const [metric, value, limit] of Values(m, limits)) {
    const mark = value > limit ? ' $(warning)' : '';
    md.appendMarkdown(
      `| ${MetricName(metric)} | **${value}**${mark} | ` + `${limit} |\n`,
    );
  }
  const branches = Object.entries(m.decisions)
    .sort(([, a], [, b]) => b - a)
    .map(([what, count]) => `\`${what}\` ×${count}`);
  md.appendMarkdown(
    '\n' +
      T('Cyclomatic = 1 + branches: {0}', branches.join(', ') || '—') +
      '\n\n',
  );
  if (m.points.length > 0) {
    const args = encodeURIComponent(
      JSON.stringify([uri.toString(), m.startLine]),
    );
    const label = showing ? T('Hide in code') : T('Show in code');
    md.appendMarkdown(`[$(eye) ${label}](command:${kToggleCommand}?${args})`);
  }
  return md;
}

function Escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

// Надписи «+N» прямо в коде у каждого if, for, && и т.д. и итог справа от
// заголовка функции, чтобы клик всегда давал видимый результат.
interface Shown {
  name: string;
  line: number;
}

class InlineDetails implements vscode.Disposable {
  private readonly decoration_ = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      margin: '0 0 0 2px',
      fontStyle: 'italic',
    },
  });
  private readonly highlight_ = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor(
      'editor.findMatchHighlightBackground',
    ),
    borderRadius: '2px',
  });
  private readonly header_ = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      margin: '0 0 0 2em',
      fontStyle: 'italic',
    },
  });
  // Документ → функции, у которых показаны подробности.
  private readonly shown_ = new Map<string, Shown[]>();

  constructor(private readonly cache_: MetricsCache) {}

  dispose(): void {
    this.decoration_.dispose();
    this.highlight_.dispose();
    this.header_.dispose();
  }

  IsShown(uri: vscode.Uri, line: number): boolean {
    return (this.shown_.get(uri.toString()) ?? []).some((s) => s.line === line);
  }

  Toggle(uri: vscode.Uri, line: number): void {
    const key = uri.toString();
    const shown = this.shown_.get(key) ?? [];
    const index = shown.findIndex((s) => s.line === line);
    if (index >= 0) {
      shown.splice(index, 1);
    } else {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === key,
      );
      const m = doc && this.cache_.Get(doc).find((f) => f.startLine === line);
      if (m) shown.push({name: m.name, line});
    }
    this.shown_.set(key, shown);
    this.Refresh(uri);
  }

  Refresh(uri: vscode.Uri): void {
    vscode.window.visibleTextEditors
      .filter((e) => e.document.uri.toString() === uri.toString())
      .forEach((e) => {
        this.Apply(e);
      });
  }

  Forget(uri: vscode.Uri): void {
    this.shown_.delete(uri.toString());
  }

  // После правок функции могли сдвинуться: ищем каждую по имени,
  // ближайшую к прежней строке; исчезнувшие забываем.
  private Find(editor: vscode.TextEditor): FunctionMetrics[] {
    const key = editor.document.uri.toString();
    const metrics = this.cache_.Get(editor.document);
    const found: FunctionMetrics[] = [];
    const shown = (this.shown_.get(key) ?? []).filter((s) => {
      const candidates = metrics.filter((f) => f.name === s.name);
      if (candidates.length === 0) return false;
      const m = candidates.reduce((best, f) =>
        Math.abs(f.startLine - s.line) < Math.abs(best.startLine - s.line)
          ? f
          : best,
      );
      s.line = m.startLine;
      found.push(m);
      return true;
    });
    this.shown_.set(key, shown);
    return found;
  }

  Apply(editor: vscode.TextEditor): void {
    const labels: vscode.DecorationOptions[] = [];
    const marks: vscode.Range[] = [];
    const header: vscode.DecorationOptions[] = [];
    for (const m of this.Find(editor)) {
      for (const point of m.points) {
        const range = new vscode.Range(
          point.line,
          point.column,
          point.line,
          point.column + point.text.length,
        );
        marks.push(range);
        labels.push({
          range,
          hoverMessage: PointHover(point),
          renderOptions: {after: {contentText: PointLabel(point)}},
        });
      }
      const end = editor.document.lineAt(m.startLine).range.end;
      header.push({
        range: new vscode.Range(end, end),
        renderOptions: {after: {contentText: HeaderLabel(m)}},
      });
    }
    editor.setDecorations(this.decoration_, labels);
    editor.setDecorations(this.highlight_, marks);
    editor.setDecorations(this.header_, header);
  }
}

function HeaderLabel(m: FunctionMetrics): string {
  if (m.points.length === 0) {
    return `◀ ${T('no branches')}`;
  }
  return `◀ ${T(
    '1 + {0} branches = {1} · cognitive {2}',
    m.cyclomatic - 1,
    m.cyclomatic,
    m.cognitive,
  )}`;
}

// «+2» — когнитивная (то, что видно глазами), «+1» в цикломатике
// подразумевается для всех ветвлений.
function PointLabel(p: DecisionPoint): string {
  if (p.cognitive === 0) return '';
  return p.nesting > 0
    ? ` +${p.cognitive} (${T('nesting {0}', p.nesting)})`
    : ` +${p.cognitive}`;
}

function PointHover(p: DecisionPoint): vscode.MarkdownString {
  const lines = [`\`${p.text}\``];
  lines.push(T('Cyclomatic: +{0}', p.cyclomatic));
  if (p.cognitive > 0) {
    lines.push(
      p.nesting > 0
        ? T('Cognitive: +{0} (1 + nesting {1})', p.cognitive, p.nesting)
        : T('Cognitive: +{0}', p.cognitive),
    );
  } else {
    lines.push(
      T('Cognitive: +0 (a chain of the same operator ' + 'counts once)'),
    );
  }
  return new vscode.MarkdownString(lines.join('  \n'));
}

class ComplexityCodeLens implements vscode.CodeLensProvider {
  private changed_ = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed_.event;

  constructor(private readonly cache_: MetricsCache) {}

  Refresh(): void {
    this.changed_.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const config = vscode.workspace.getConfiguration('labkit.complexity');
    if (!config.get('enabled', true) || !config.get('codeLens', true)) {
      return [];
    }
    const limits = ComplexityLimits();
    return this.cache_.Get(doc).map((m) => {
      const bad = Violations(m, limits).length > 0;
      const range = new vscode.Range(m.startLine, 0, m.startLine, 0);
      return new vscode.CodeLens(range, {
        title: `${bad ? '$(warning)' : '$(pulse)'} ${Summary(m)}`,
        tooltip: T('Show what adds complexity'),
        command: kToggleCommand,
        arguments: [doc.uri.toString(), m.startLine],
      });
    });
  }
}

class ComplexityHover implements vscode.HoverProvider {
  constructor(
    private readonly cache_: MetricsCache,
    private readonly inline_: InlineDetails,
  ) {}

  provideHover(
    doc: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    if (!Enabled()) return undefined;
    const m = this.cache_
      .Get(doc)
      .find(
        (f) =>
          f.startLine === position.line &&
          position.character >= f.startColumn &&
          position.character <= f.nameEndColumn,
      );
    if (!m) return undefined;
    return new vscode.Hover(
      HoverCard(m, doc.uri, this.inline_.IsShown(doc.uri, m.startLine)),
      new vscode.Range(
        m.startLine,
        m.startColumn,
        m.startLine,
        m.nameEndColumn,
      ),
    );
  }
}

function IsTestDocument(doc: vscode.TextDocument): boolean {
  const lab = FindLab(doc.uri.fsPath);
  return !!lab && IsTestPath(path.relative(lab.root, doc.uri.fsPath));
}

function UpdateDiagnostics(
  doc: vscode.TextDocument,
  cache: MetricsCache,
  collection: vscode.DiagnosticCollection,
): void {
  if (!IsCpp(doc) || !Enabled() || IsTestDocument(doc)) {
    collection.delete(doc.uri);
    return;
  }
  const limits = ComplexityLimits();
  const diagnostics: vscode.Diagnostic[] = [];
  for (const m of cache.Get(doc)) {
    const violations = Violations(m, limits);
    if (violations.length === 0) continue;
    const range = new vscode.Range(
      m.startLine,
      m.startColumn,
      m.startLine,
      m.nameEndColumn,
    );
    const text = violations
      .map((v) =>
        T(
          '{0} {1} (limit {2})',
          MetricName(v.metric).toLowerCase(),
          v.value,
          v.limit,
        ),
      )
      .join(', ');
    const diagnostic = new vscode.Diagnostic(
      range,
      T('Function {0}: {1}', m.name, text),
      vscode.DiagnosticSeverity.Warning,
    );
    diagnostic.source = 'Lab Kit';
    diagnostic.code = 'complexity';
    diagnostics.push(diagnostic);
  }
  collection.set(doc.uri, diagnostics);
}

async function Report(): Promise<void> {
  const lab = CurrentLab();
  if (!lab) return;
  const pattern = new vscode.RelativePattern(
    lab.root,
    '**/*.{c,cc,cpp,cxx,h,hpp}',
  );
  const files = await vscode.workspace.findFiles(pattern, '**/{build,.*}/**');
  const limits = ComplexityLimits();
  const rows: Array<{file: string; m: FunctionMetrics; bad: boolean}> = [];
  for (const uri of files) {
    if (IsTestPath(path.relative(lab.root, uri.fsPath))) continue;
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(
      'utf8',
    );
    for (const m of Analyze(text)) {
      rows.push({
        file: path.relative(lab.root, uri.fsPath),
        m,
        bad: Violations(m, limits).length > 0,
      });
    }
  }
  rows.sort(
    (a, b) => b.m.cyclomatic - a.m.cyclomatic || b.m.cognitive - a.m.cognitive,
  );
  const bad = rows.filter((r) => r.bad).length;
  const average = rows.length
    ? (rows.reduce((sum, r) => sum + r.m.cyclomatic, 0) / rows.length).toFixed(
        1,
      )
    : '—';
  const lines = [
    `# ${T('Function complexity: {0}', lab.name)}`,
    '',
    T(
      'Functions: **{0}**, average cyclomatic complexity: **{1}**, ' +
        'over the limits: **{2}**.',
      rows.length,
      average,
      bad,
    ),
    '',
    T(
      'Limits: cyclomatic {0}, cognitive {1}, lines {2}, params {3}, ' +
        'nesting {4}.',
      limits.maxCyclomatic,
      limits.maxCognitive,
      limits.maxLines,
      limits.maxParams,
      limits.maxNesting,
    ) +
      ' ' +
      T('Tests are not included.'),
    '',
    `| | ${T('Function')} | ${T('File')} | ${T('Cycl.')} | ` +
      `${T('Cogn.')} | ${T('Lines')} | ${T('Params')} | ` +
      `${T('Nest.')} |`,
    '|---|---|---|---:|---:|---:|---:|---:|',
    ...rows.map(({file, m, bad}) => {
      const line = m.startLine + 1;
      return (
        `| ${bad ? '⚠️' : '✅'} | ` +
        `\`${m.name.replace(/\|/g, '\\|')}\` | ` +
        `${OpenLink(`${file}:${line}`, file, line)} | ` +
        `${m.cyclomatic} | ${m.cognitive} | ` +
        `${m.lines} | ${m.params} | ${m.maxNesting} |`
      );
    }),
    '',
  ];
  await ShowReport(
    'complexity',
    T('Complexity: {0}', lab.name),
    lines.join('\n'),
    lab.root,
  );
}

export function RegisterComplexity(context: vscode.ExtensionContext): void {
  const cache = new MetricsCache();
  const lens = new ComplexityCodeLens(cache);
  const inline = new InlineDetails(cache);
  const collection =
    vscode.languages.createDiagnosticCollection('labkit-complexity');
  const update = (doc: vscode.TextDocument) =>
    UpdateDiagnostics(doc, cache, collection);
  const selector = kLanguages.map((language) => ({language, scheme: 'file'}));
  let pending: NodeJS.Timeout | undefined;

  context.subscriptions.push(
    collection,
    inline,
    vscode.languages.registerCodeLensProvider(selector, lens),
    vscode.languages.registerHoverProvider(
      selector,
      new ComplexityHover(cache, inline),
    ),
    vscode.commands.registerCommand(
      kToggleCommand,
      (uri: string, line: number) => inline.Toggle(vscode.Uri.parse(uri), line),
    ),
    vscode.commands.registerCommand('labkit.complexityReport', Report),
    vscode.workspace.onDidOpenTextDocument(update),
    vscode.workspace.onDidChangeTextDocument((e) => {
      // Событие приходит и при смене «грязного» состояния (автосохранение)
      // — тогда пересчитывать нечего.
      if (e.contentChanges.length === 0) return;
      clearTimeout(pending);
      pending = setTimeout(() => {
        update(e.document);
        inline.Refresh(e.document.uri);
      }, 400);
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const e of editors) inline.Apply(e);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      cache.Forget(doc);
      inline.Forget(doc.uri);
      collection.delete(doc.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        !e.affectsConfiguration('labkit.complexity') &&
        !e.affectsConfiguration('labkit.language')
      ) {
        return;
      }
      vscode.workspace.textDocuments.forEach(update);
      lens.Refresh();
    }),
    {dispose: () => clearTimeout(pending)},
  );
  vscode.workspace.textDocuments.forEach(update);
}
