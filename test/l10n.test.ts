import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {test} from 'node:test';

const kRoot = path.join(__dirname, '..');

// Ключи T('…' + '…'): склеиваем литералы так же, как это сделает JS.
function Keys(dir: string): Set<string> {
  const keys = new Set<string>();
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      Keys(full).forEach((k) => {
        keys.add(k);
      });
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    const source = fs.readFileSync(full, 'utf8');
    const call = /\bT\(\s*((?:'(?:[^'\\]|\\.)*'\s*\+?\s*)+)/g;
    for (const match of source.matchAll(call)) {
      const literals = match[1].match(/'(?:[^'\\]|\\.)*'/g) ?? [];
      keys.add(
        literals.map((l) => l.slice(1, -1).replace(/\\(.)/g, '$1')).join(''),
      );
    }
  }
  return keys;
}

function ManifestKeys(): Set<string> {
  const manifest = fs.readFileSync(path.join(kRoot, 'package.json'), 'utf8');
  return new Set([...manifest.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]));
}

test('у каждой строки интерфейса есть русский перевод', () => {
  const bundle = JSON.parse(
    fs.readFileSync(path.join(kRoot, 'l10n', 'bundle.l10n.ru.json'), 'utf8'),
  );
  const keys = Keys(path.join(kRoot, 'src'));
  assert.ok(keys.size > 50);
  const missing = [...keys].filter((k) => !(k in bundle));
  assert.deepEqual(missing, []);
  const unused = Object.keys(bundle).filter((k) => !keys.has(k));
  assert.deepEqual(unused, []);
});

test('у каждой строки манифеста есть en и ru', () => {
  const en = JSON.parse(
    fs.readFileSync(path.join(kRoot, 'package.nls.json'), 'utf8'),
  );
  const ru = JSON.parse(
    fs.readFileSync(path.join(kRoot, 'package.nls.ru.json'), 'utf8'),
  );
  const keys = [...ManifestKeys()];
  assert.ok(keys.length > 20);
  assert.deepEqual(
    keys.filter((k) => !(k in en)),
    [],
  );
  assert.deepEqual(
    keys.filter((k) => !(k in ru)),
    [],
  );
});
