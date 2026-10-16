import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import type {Lang} from './templates';

// Свой загрузчик вместо vscode.l10n: язык расширения можно выбрать
// настройкой labkit.language, не меняя язык всего VS Code.
let bundles: Partial<Record<Lang, Record<string, string>>> = {};
let root = '';

export function InitI18n(extension_root: string): void {
  root = extension_root;
  bundles = {};
}

export function UiLang(): Lang {
  const setting = vscode.workspace
    .getConfiguration('labkit')
    .get<string>('language', 'auto');
  if (setting === 'en' || setting === 'ru') return setting;
  return vscode.env.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

function Bundle(lang: Lang): Record<string, string> {
  if (lang === 'en') return {};
  const cached = bundles[lang];
  if (cached) return cached;
  let bundle: Record<string, string> = {};
  try {
    bundle = JSON.parse(
      fs.readFileSync(
        path.join(root, 'l10n', `bundle.l10n.${lang}.json`),
        'utf8',
      ),
    );
  } catch {
    // Нет перевода — показываем английский.
  }
  bundles[lang] = bundle;
  return bundle;
}

// Перевод строки с подстановкой {0}, {1}, …
export function T(message: string, ...args: Array<string | number>): string {
  const template = Bundle(UiLang())[message] ?? message;
  return template.replace(/\{(\d+)\}/g, (all, index) =>
    index < args.length ? String(args[Number(index)]) : all,
  );
}
