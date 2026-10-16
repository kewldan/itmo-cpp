// Разбор тестов GoogleTest без vscode, чтобы проверять обычными тестами.

import {Tokenize} from './complexity/analyzer';

const kTestMacros = new Set([
  'TEST',
  'TEST_F',
  'TEST_P',
  'TYPED_TEST',
  'TYPED_TEST_P',
]);

export interface DiscoveredTest {
  macro: string;
  suite: string;
  name: string;
  line: number;
}

// TEST(Suite, Name) и родственники; закомментированные тесты не попадут,
// потому что разбор идёт по токенам.
export function DiscoverTests(source: string): DiscoveredTest[] {
  const t = Tokenize(source);
  const found: DiscoveredTest[] = [];
  for (let i = 0; i + 5 < t.length; i++) {
    if (
      kTestMacros.has(t[i].text) &&
      t[i + 1].text === '(' &&
      t[i + 2].kind === 'id' &&
      t[i + 3].text === ',' &&
      t[i + 4].kind === 'id' &&
      t[i + 5].text === ')'
    ) {
      found.push({
        macro: t[i].text,
        suite: t[i + 2].text,
        name: t[i + 4].text,
        line: t[i].line,
      });
    }
  }
  return found;
}

// Имя из отчёта GoogleTest без префикса инстанцирования и номеров
// параметров: Inst/Suite.Name/0 и Suite/0.Name превращаются в Suite.Name.
export function NormalizeResultName(suite: string, name: string): string {
  const parts = suite.split('/').filter((p) => !/^\d+$/.test(p));
  const clean_suite = parts[parts.length - 1] ?? suite;
  return `${clean_suite}.${name.split('/')[0]}`;
}
