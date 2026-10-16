import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import {T, UiLang} from './i18n';
import {CurrentLab, FindLab, type Lab} from './lab';

export const kTaskViewId = 'labkit.task';

interface TaskState {
  checked: string[];
  // Файл условия, выбранный вручную, относительно корня лабы.
  file?: string;
  // Пользователь уже трогал чек-лист: отметки «- [x]» из файла больше не
  // применяются.
  touched?: boolean;
}

function StateFile(lab: Lab): string {
  return path.join(lab.root, '.labkit', 'task.json');
}

function ReadState(lab: Lab): TaskState {
  try {
    const state = JSON.parse(fs.readFileSync(StateFile(lab), 'utf8'));
    return {
      checked: Array.isArray(state.checked) ? state.checked : [],
      touched: state.touched === true,
      file: typeof state.file === 'string' ? state.file : undefined,
    };
  } catch {
    return {checked: []};
  }
}

function WriteState(lab: Lab, state: TaskState): void {
  fs.mkdirSync(path.dirname(StateFile(lab)), {recursive: true});
  fs.writeFileSync(StateFile(lab), `${JSON.stringify(state, null, 2)}\n`);
}

// Первый подходящий файл из labkit.task.files в корне лабы, без учёта
// регистра имени.
function TaskFileNames(): string[] {
  return vscode.workspace
    .getConfiguration('labkit.task')
    .get<string[]>('files', []);
}

// Сначала корень лабы, затем папка рабочей области.
function TaskDirs(lab: Lab): string[] {
  return [...new Set([lab.root, lab.workspaceFolder.uri.fsPath])];
}

// Файл, выбранный вручную, иначе первый подходящий из labkit.task.files.
export function FindTaskFile(lab: Lab): string | undefined {
  const chosen = ReadState(lab).file;
  if (chosen && fs.existsSync(path.join(lab.root, chosen))) {
    return path.join(lab.root, chosen);
  }
  const names = TaskFileNames();
  const dirs = TaskDirs(lab);
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.includes('/')) {
        const full = path.join(dir, name);
        if (fs.existsSync(full)) return full;
        continue;
      }
      const match = entries.find((e) => e.toLowerCase() === name.toLowerCase());
      if (match) return path.join(dir, match);
    }
  }
  return undefined;
}

export class TaskViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view_: vscode.WebviewView | undefined;
  private lab_: Lab | undefined;
  private file_: string | undefined;
  private readonly disposables_: vscode.Disposable[] = [];

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.md');
    const Changed = (uri: vscode.Uri) => {
      if (uri.fsPath === this.file_) void this.Render();
    };
    this.disposables_.push(
      watcher,
      watcher.onDidChange(Changed),
      watcher.onDidCreate(() => {
        if (!this.file_) void this.Render();
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.uri.scheme !== 'file') return;
        const lab = FindLab(editor.document.uri.fsPath);
        if (lab && (lab.root !== this.lab_?.root || !this.file_)) {
          void this.Render(lab);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('labkit.task') ||
          e.affectsConfiguration('labkit.language')
        ) {
          void this.Render();
        }
      }),
    );
  }

  dispose(): void {
    this.disposables_.forEach((d) => {
      d.dispose();
    });
  }

  // Для smoke-теста: текущий HTML панели.
  get html(): string | undefined {
    return this.view_?.webview.html;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view_ = view;
    view.webview.options = {enableScripts: true};
    view.webview.onDidReceiveMessage((message) => this.OnMessage(message));
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.Render();
    });
    void this.Render();
  }

  OpenSource(): void {
    if (this.file_) {
      void vscode.window.showTextDocument(vscode.Uri.file(this.file_));
    } else {
      void vscode.window.showInformationMessage(
        T('No task file found. File names are set in ' + 'labkit.task.files.'),
      );
    }
  }

  ResetChecklist(): void {
    if (!this.lab_) return;
    WriteState(this.lab_, {checked: [], file: ReadState(this.lab_).file});
    void this.Render();
  }

  // Ручной выбор файла условия; запоминается в .labkit/task.json.
  async PickFile(): Promise<void> {
    const lab = this.lab_ ?? CurrentLab();
    if (!lab) return;
    const picked = await vscode.window.showOpenDialog({
      defaultUri: vscode.Uri.file(lab.root),
      canSelectMany: false,
      filters: {Markdown: ['md', 'markdown'], [T('All files')]: ['*']},
      openLabel: T('Use as task'),
    });
    if (!picked?.[0]) return;
    const state = ReadState(lab);
    state.file = path.relative(lab.root, picked[0].fsPath);
    WriteState(lab, state);
    await this.Render(lab);
  }

  async Render(lab = CurrentLab() ?? this.lab_): Promise<void> {
    try {
      await this.RenderUnsafe(lab);
    } catch (error) {
      // Не оставляем в панели устаревший текст: показываем, что сломалось.
      if (this.view_) {
        this.view_.webview.html = this.Page(
          `<p class="empty">${Escape(
            T('Failed to show the task: {0}', String(error)),
          )}</p>${this.EmptyActions()}`,
          {checked: []},
        );
      }
    }
  }

  private EmptyActions(): string {
    return `<p class="actions">
  <button data-action="pick">${Escape(T('Choose task file…'))}</button>
  <button data-action="refresh" class="secondary">${Escape(T('Refresh'))}</button>
</p>`;
  }

  private async RenderUnsafe(lab: Lab | undefined): Promise<void> {
    this.lab_ = lab;
    if (!this.view_ || !lab) return;
    const webview = this.view_.webview;
    this.file_ = FindTaskFile(lab);
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(lab.root)],
    };
    this.view_.description = lab.name;
    if (!this.file_) {
      this.view_.badge = undefined;
      // Где и что искали — чтобы было видно, почему не нашлось.
      const where = TaskDirs(lab)
        .map((d) => `<code>${Escape(d)}</code>`)
        .join(', ');
      const names = TaskFileNames()
        .map((n) => `<code>${Escape(n)}</code>`)
        .join(', ');
      webview.html = this.Page(
        `<p class="empty">${Escape(T('No task file found.'))}</p>` +
          `<p class="hint">${Escape(T('Searched in'))} ${where}: ` +
          `${names || '—'}.</p>` +
          this.EmptyActions(),
        {checked: []},
      );
      return;
    }
    const markdown = fs.readFileSync(this.file_, 'utf8');
    let html = await vscode.commands.executeCommand<string>(
      'markdown.api.render',
      markdown,
    );
    // Картинки с относительными путями — из папки лабы.
    const base = path.dirname(this.file_);
    html = html.replace(/(<img[^>]*\ssrc=")([^"]+)"/g, (all, prefix, src) => {
      if (/^[a-z]+:/i.test(src)) return all;
      const uri = webview.asWebviewUri(vscode.Uri.file(path.join(base, src)));
      return `${prefix}${uri.toString()}"`;
    });
    webview.html = this.Page(html, ReadState(lab));
  }

  private OnMessage(message: {type: string; [key: string]: unknown}): void {
    const lab = this.lab_;
    if (!lab) return;
    if (message.type === 'toggle') {
      const state = ReadState(lab);
      const key = String(message.key);
      state.checked = state.checked.filter((k) => k !== key);
      if (message.checked) state.checked.push(key);
      state.touched = true;
      WriteState(lab, state);
    } else if (message.type === 'progress' && this.view_) {
      const left = Number(message.total) - Number(message.done);
      this.view_.badge =
        left > 0
          ? {value: left, tooltip: T('Items left: {0}', left)}
          : undefined;
    } else if (message.type === 'pick') {
      void this.PickFile();
    } else if (message.type === 'refresh') {
      void this.Render(CurrentLab() ?? lab);
    } else if (message.type === 'link') {
      const href = String(message.href);
      if (/^https?:/i.test(href)) {
        void vscode.env.openExternal(vscode.Uri.parse(href));
      } else if (this.file_ && !href.startsWith('#')) {
        const target = path.resolve(
          path.dirname(this.file_),
          decodeURI(href.split('#')[0]),
        );
        void vscode.commands.executeCommand(
          'vscode.open',
          vscode.Uri.file(target),
        );
      }
    }
  }

  private Page(body: string, state: TaskState): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = [
      `default-src 'none'`,
      `img-src ${this.view_?.webview.cspSource ?? ''} https: data:`,
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="${UiLang()}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style nonce="${nonce}">
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 0 12px 16px;
    line-height: 1.5;
  }
  .progress {
    position: sticky;
    top: 0;
    padding: 8px 0;
    background: var(--vscode-sideBar-background);
    z-index: 1;
  }
  .progress-text { font-size: 0.9em; opacity: 0.8; margin-bottom: 4px; }
  .bar { height: 4px; border-radius: 2px;
         background: var(--vscode-progressBar-background); opacity: 0.25; }
  .bar-fill { height: 4px; border-radius: 2px; margin-top: -4px;
              background: var(--vscode-progressBar-background);
              transition: width 0.2s; }
  h1 { font-size: 1.4em; } h2 { font-size: 1.2em; } h3 { font-size: 1.05em; }
  a { color: var(--vscode-textLink-foreground); }
  code { font-family: var(--vscode-editor-font-family);
         background: var(--vscode-textCodeBlock-background);
         padding: 1px 4px; border-radius: 3px; }
  pre { background: var(--vscode-textCodeBlock-background);
        padding: 8px; overflow-x: auto; border-radius: 4px; }
  pre code { padding: 0; background: none; }
  img { max-width: 100%; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid var(--vscode-panel-border); padding: 2px 6px; }
  li.task { list-style: none; margin-left: -1.4em; }
  li.task > input { margin: 0 6px 0 0; vertical-align: middle; }
  li.done > .text { opacity: 0.55; text-decoration: line-through; }
  .empty { opacity: 0.8; }
  .hint { opacity: 0.7; font-size: 0.9em; word-break: break-all; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  button {
    font-family: inherit;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: none;
    padding: 4px 10px;
    border-radius: 2px;
    cursor: pointer;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
  }
</style>
</head>
<body>
<div class="progress" hidden>
  <div class="progress-text"></div>
  <div class="bar"></div><div class="bar-fill"></div>
</div>
${body}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const checked = new Set(${JSON.stringify(state.checked)});
  const touched = ${state.touched === true};
  const kDoneTemplate = ${JSON.stringify(T('Done {0} of {1}'))};

  // Ключ пункта — его собственный текст без вложенных списков, так отметки
  // переживают правки остального условия.
  function OwnText(li) {
    let text = '';
    for (const node of li.childNodes) {
      if (node.nodeType === 1 && /^(UL|OL)$/.test(node.tagName)) continue;
      text += node.textContent;
    }
    return text.replace(/\\s+/g, ' ').trim();
  }

  const items =
      [...document.querySelectorAll('body > ul > li, body > ol > li')];
  function Update() {
    const done = items.filter((li) => li.classList.contains('done')).length;
    const panel = document.querySelector('.progress');
    panel.hidden = items.length === 0;
    panel.querySelector('.progress-text').textContent =
        kDoneTemplate.replace('{0}', done).replace('{1}', items.length);
    panel.querySelector('.bar-fill').style.width =
        (items.length ? done / items.length * 100 : 0) + '%';
    vscode.postMessage({type: 'progress', done, total: items.length});
  }

  for (const li of items) {
    let key = OwnText(li);
    // Пункты «- [ ]» и «- [x]» из Markdown.
    const preset = /^\\[( |x|X)\\]\\s*/.exec(key);
    if (preset) key = key.slice(preset[0].length);
    const wrapper = document.createElement('span');
    wrapper.className = 'text';
    while (li.firstChild &&
           !(li.firstChild.nodeType === 1 &&
             /^(UL|OL)$/.test(li.firstChild.tagName))) {
      wrapper.appendChild(li.firstChild);
    }
    if (preset) {
      const walker = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && node.textContent.trim() === '') node = walker.nextNode();
      if (node) {
        node.textContent =
            node.textContent.replace(/^\\s*\\[( |x|X)\\]\\s*/, '');
      }
    }
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = checked.has(key) ||
        (!touched && preset !== null && preset[1] !== ' ');
    li.classList.add('task');
    li.classList.toggle('done', box.checked);
    li.prepend(box, wrapper);
    box.addEventListener('change', () => {
      li.classList.toggle('done', box.checked);
      vscode.postMessage({type: 'toggle', key, checked: box.checked});
      Update();
    });
  }
  Update();

  document.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (button) {
      vscode.postMessage({type: button.dataset.action});
      return;
    }
    const link = event.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (href.startsWith('#')) return;
    event.preventDefault();
    vscode.postMessage({type: 'link', href});
  });
</script>
</body>
</html>`;
  }
}

const kHtmlEntities: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

function Escape(text: string): string {
  return text.replace(/[&<>"]/g, (c) => kHtmlEntities[c] ?? c);
}
