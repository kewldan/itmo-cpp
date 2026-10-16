import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';

import {UiLang} from './i18n';

// Отчёт в отдельной вкладке только для чтения: отрисованный Markdown без
// сырого документа Untitled рядом. Одна вкладка на вид отчёта.
const panels = new Map<string, vscode.WebviewPanel>();
// Корень, от которого отсчитываются пути в ссылках отчёта.
const roots = new Map<string, string | undefined>();

// Ссылка на место в коде: [текст](#open:путь/от/корня:строка).
export function OpenLink(text: string, file: string, line: number): string {
  return `[${text}](#open:${encodeURI(file)}:${line})`;
}

export async function ShowReport(
  id: string,
  title: string,
  markdown: string,
  root?: string,
): Promise<void> {
  const html = await vscode.commands.executeCommand<string>(
    'markdown.api.render',
    markdown,
  );
  let panel = panels.get(id);
  if (panel) {
    panel.title = title;
    panel.reveal();
  } else {
    panel = vscode.window.createWebviewPanel(
      `labkit.report.${id}`,
      title,
      vscode.ViewColumn.Active,
      {enableScripts: true, enableFindWidget: true},
    );
    panels.set(id, panel);
    panel.onDidDispose(() => {
      panels.delete(id);
      roots.delete(id);
    });
    panel.webview.onDidReceiveMessage((message: {href: string}) => {
      const match = /^#open:(.*):(\d+)$/.exec(message.href);
      const base = roots.get(id);
      if (!match || !base) return;
      const uri = vscode.Uri.file(path.join(base, decodeURI(match[1])));
      const line = Number(match[2]) - 1;
      void vscode.window.showTextDocument(uri, {
        viewColumn: vscode.ViewColumn.Active,
        selection: new vscode.Range(line, 0, line, 0),
      });
    });
  }
  roots.set(id, root);
  panel.webview.html = Page(panel.webview, html);
}

function Page(webview: vscode.Webview, body: string): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
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
    padding: 8px 20px 24px;
    line-height: 1.5;
  }
  h1 { font-size: 1.5em; } h2 { font-size: 1.2em; margin-top: 1.6em; }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font-family: var(--vscode-editor-font-family);
         background: var(--vscode-textCodeBlock-background);
         padding: 1px 4px; border-radius: 3px; }
  table { border-collapse: collapse; margin: 8px 0; }
  th, td { padding: 3px 10px;
           border-bottom: 1px solid var(--vscode-panel-border); }
  th { text-align: left; font-weight: 600; }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
</style>
</head>
<body>
${body}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href^="#open:"]');
    if (!link) return;
    event.preventDefault();
    vscode.postMessage({href: link.getAttribute('href')});
  });
</script>
</body>
</html>`;
}
