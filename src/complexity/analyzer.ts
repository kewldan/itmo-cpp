// Метрики функций C/C++ без компилятора: лексер плюс эвристический поиск
// определений функций. Модуль не зависит от vscode.

export type TokenKind = 'id' | 'num' | 'str' | 'punct';

export interface Token {
  text: string;
  kind: TokenKind;
  line: number; // с нуля
  column: number;
}

// Место в коде, которое добавляет сложность.
export interface DecisionPoint {
  line: number;
  column: number;
  text: string; // if, for, &&, ?, else…
  cyclomatic: number; // 0 или 1
  cognitive: number; // 1 + nesting или 1
  nesting: number; // уровень вложенности, за который начислено
}

export interface FunctionMetrics {
  name: string;
  startLine: number;
  startColumn: number;
  nameEndColumn: number; // конец имени в строке startLine
  endLine: number;
  cyclomatic: number;
  cognitive: number;
  lines: number; // строк с кодом в теле и сигнатуре
  params: number;
  maxNesting: number;
  // Что увеличило цикломатическую сложность: if → 3, && → 2 и т.д.
  decisions: Record<string, number>;
  points: DecisionPoint[];
}

const kPuncts = [
  '<=>',
  '->*',
  '<<=',
  '>>=',
  '...',
  '::',
  '->',
  '&&',
  '||',
  '++',
  '--',
  '==',
  '!=',
  '<=',
  '>=',
  '<<',
  '>>',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '.*',
  '##',
];

function IsIdStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch) || ch > '\x7f';
}

function IsIdPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch) || ch > '\x7f';
}

export function Tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const n = source.length;
  let i = 0;
  let line = 0;
  let line_start = 0;
  let at_line_begin = true; // до первого непробельного символа строки

  const NewLine = (pos: number) => {
    line++;
    line_start = pos + 1;
    at_line_begin = true;
  };
  // Пропускает до конца строки с учётом переноса через обратный слэш.
  const SkipLine = () => {
    while (i < n && source[i] !== '\n') {
      if (source[i] === '\\' && source[i + 1] === '\n') {
        i++;
        NewLine(i);
      } else if (source[i] === '/' && source[i + 1] === '*') {
        SkipBlockComment();
        continue;
      }
      i++;
    }
  };
  const SkipBlockComment = () => {
    i += 2;
    while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
      if (source[i] === '\n') NewLine(i);
      i++;
    }
    i += 2;
  };
  const Push = (text: string, kind: TokenKind, start: number) => {
    tokens.push({text, kind, line, column: start - line_start});
    at_line_begin = false;
  };

  while (i < n) {
    const ch = source[i];
    if (ch === '\n') {
      NewLine(i);
      i++;
      continue;
    }
    if (
      ch === ' ' ||
      ch === '\t' ||
      ch === '\r' ||
      ch === '\f' ||
      ch === '\v'
    ) {
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      SkipLine();
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      SkipBlockComment();
      continue;
    }
    if (ch === '#' && at_line_begin) {
      SkipLine();
      continue;
    }
    const start = i;
    if (IsIdStart(ch)) {
      while (i < n && IsIdPart(source[i])) i++;
      const word = source.slice(start, i);
      // Сырые строки: R"delim( ... )delim", также u8R, LR, uR, UR.
      if (source[i] === '"' && /^(u8|u|U|L)?R$/.test(word)) {
        const open = source.indexOf('(', i);
        const delim = source.slice(i + 1, open);
        const close = source.indexOf(`)${delim}"`, open);
        const end = close < 0 ? n : close + delim.length + 2;
        for (let k = i; k < end; k++) {
          if (source[k] === '\n') NewLine(k);
        }
        i = end;
        Push(source.slice(start, i), 'str', start);
        continue;
      }
      if (
        (source[i] === '"' || source[i] === "'") &&
        /^(u8|u|U|L)$/.test(word)
      ) {
        // Префикс обычной строки или символа — разберём ниже вместе.
      } else {
        Push(word, 'id', start);
        continue;
      }
    }
    if (source[i] === '"' || source[i] === "'") {
      const quote = source[i];
      i++;
      while (i < n && source[i] !== quote && source[i] !== '\n') {
        if (source[i] === '\\') i++;
        i++;
      }
      i++;
      Push(source.slice(start, i), 'str', start);
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      i++;
      while (i < n) {
        const c = source[i];
        if (/[eEpP]/.test(c) && /[+-]/.test(source[i + 1] ?? '')) {
          i += 2;
        } else if (
          /[0-9A-Za-z_.]/.test(c) ||
          (c === "'" && /[0-9A-Za-z]/.test(source[i + 1] ?? ''))
        ) {
          i++;
        } else {
          break;
        }
      }
      Push(source.slice(start, i), 'num', start);
      continue;
    }
    const punct = kPuncts.find((p) => source.startsWith(p, i)) ?? ch;
    i += punct.length;
    Push(punct, 'punct', start);
  }
  return tokens;
}

// Слова, после которых ( — не вызов и не объявление функции.
const kNotFunctionNames = new Set([
  'if',
  'for',
  'while',
  'switch',
  'return',
  'sizeof',
  'alignof',
  'decltype',
  'static_assert',
  'alignas',
  'noexcept',
  'requires',
  'catch',
  'new',
  'delete',
  'throw',
  'case',
  'typeid',
  'defined',
  'using',
  '__attribute__',
  '__declspec',
  'co_return',
  'co_await',
  'co_yield',
  'explicit',
  'static_cast',
  'dynamic_cast',
  'const_cast',
  'reinterpret_cast',
]);

const kTypeKeywords = new Set([
  'class',
  'struct',
  'union',
  'enum',
  'namespace',
]);

const kDecisionWords = new Set([
  'if',
  'for',
  'while',
  'case',
  'catch',
  'and',
  'or',
]);
const kDecisionPuncts = new Set(['&&', '||', '?']);

// Индекс парной закрывающей скобки или tokens.length.
function MatchClose(tokens: Token[], open: number): number {
  const open_text = tokens[open].text;
  const close_text = open_text === '(' ? ')' : open_text === '[' ? ']' : '}';
  let depth = 0;
  for (let k = open; k < tokens.length; k++) {
    const t = tokens[k].text;
    if (t === open_text) depth++;
    else if (t === close_text && --depth === 0) return k;
  }
  return tokens.length;
}

interface NameInfo {
  name: string;
  first: number; // индекс первого токена имени
}

interface CognitivePoint {
  cognitive: number;
  nesting: number;
}

// Имя функции, заканчивающееся на токене j (перед открывающей скобкой).
function ReadName(tokens: Token[], j: number): NameInfo | undefined {
  // operator==, operator(), operator[], operator new, operator bool.
  for (let back = 0; back <= 3 && j - back >= 0; back++) {
    if (tokens[j - back].text === 'operator') {
      const op_start = j - back;
      const op = tokens
        .slice(op_start + 1, j + 1)
        .map((t) => t.text)
        .join('');
      if (op === '' && tokens[j].text !== 'operator') break;
      // operator bool, operator int64_t — с пробелом, operator== — без.
      const separator = /^[A-Za-z_]/.test(op) ? ' ' : '';
      return ReadQualified(tokens, op_start, `operator${separator}${op}`);
    }
  }
  const t = tokens[j];
  if (
    t.kind !== 'id' ||
    kNotFunctionNames.has(t.text) ||
    kTypeKeywords.has(t.text)
  ) {
    return undefined;
  }
  let first = j;
  let name = t.text;
  if (j > 0 && tokens[j - 1].text === '~') {
    first = j - 1;
    name = `~${name}`;
  }
  return ReadQualified(tokens, first, name);
}

function ReadQualified(tokens: Token[], first: number, name: string): NameInfo {
  while (
    first >= 2 &&
    tokens[first - 1].text === '::' &&
    tokens[first - 2].kind === 'id'
  ) {
    name = `${tokens[first - 2].text}::${name}`;
    first -= 2;
  }
  return {name, first};
}

// Ищет { тела функции после ) списка параметров. -1 — это не определение.
function FindBodyStart(tokens: Token[], k: number): number {
  const limit = Math.min(tokens.length, k + 200);
  while (k < limit) {
    const t = tokens[k].text;
    if (t === '{') return k;
    if (
      t === ';' ||
      t === '=' ||
      t === ',' ||
      t === ')' ||
      t === '}' ||
      kTypeKeywords.has(t)
    ) {
      return -1;
    }
    if (t === '(' || t === '[') {
      k = MatchClose(tokens, k) + 1;
      continue;
    }
    if (t === ':') return FindBodyAfterInitList(tokens, k + 1);
    if (t === 'try' && tokens[k + 1]?.text === ':') {
      return FindBodyAfterInitList(tokens, k + 2);
    }
    k++;
  }
  return -1;
}

// Список инициализации конструктора: a_(x), b_{y}, Base<T>(z) {
function FindBodyAfterInitList(tokens: Token[], k: number): number {
  while (k < tokens.length) {
    // Имя члена или базового класса.
    let angle = 0;
    while (k < tokens.length) {
      const t = tokens[k];
      if (t.text === '<') angle++;
      else if (t.text === '>' && angle > 0) angle--;
      else if (t.text === '>>' && angle > 0) angle = Math.max(0, angle - 2);
      else if (angle === 0 && t.kind !== 'id' && t.text !== '::') break;
      k++;
    }
    const t = tokens[k]?.text;
    if (t !== '(' && t !== '{') return -1;
    k = MatchClose(tokens, k) + 1;
    if (tokens[k]?.text === '...') k++;
    const next = tokens[k]?.text;
    if (next === '{') return k;
    if (next !== ',') return -1;
    k++;
  }
  return -1;
}

function CountParams(tokens: Token[], open: number, close: number): number {
  if (close - open === 1) return 0;
  if (close - open === 2 && tokens[open + 1].text === 'void') return 0;
  let params = 1;
  let depth = 0;
  for (let k = open + 1; k < close; k++) {
    const t = tokens[k].text;
    if (t === '(' || t === '[' || t === '{') depth++;
    else if (t === ')' || t === ']' || t === '}') depth--;
    else if (t === '<' && tokens[k - 1].kind === 'id') depth++;
    else if (t === '>' && depth > 0) depth--;
    else if (t === '>>' && depth > 0) depth = Math.max(0, depth - 2);
    else if (t === ',' && depth === 0) params++;
  }
  return params;
}

// Упрощённая когнитивная сложность (SonarSource): ветвления дают 1 плюс
// уровень вложенности, else и последовательности && / || — по 1.
function Cognitive(
  tokens: Token[],
  body: number,
  end: number,
): Map<number, CognitivePoint> {
  const points = new Map<number, CognitivePoint>();
  const Add = (k: number, nest: number) =>
    points.set(k, {cognitive: 1 + nest, nesting: nest});
  // Стек блоков: true — блок увеличивает вложенность (тело if/for/...).
  const blocks: boolean[] = [];
  let nesting = 0;
  let pending_nest = false;
  let parens = 0;
  let last_logical = '';
  for (let k = body + 1; k < end; k++) {
    const t = tokens[k];
    switch (t.text) {
      case 'if':
        Add(k, tokens[k - 1]?.text === 'else' ? 0 : nesting);
        pending_nest = true;
        break;
      case 'else':
        if (tokens[k + 1]?.text !== 'if') Add(k, 0);
        pending_nest = true;
        break;
      case 'for':
      case 'while':
      case 'switch':
      case 'catch':
        // while в конце do-while не открывает новый блок.
        if (
          t.text === 'while' &&
          tokens[k - 1]?.text === '}' &&
          IsDoWhile(tokens, k - 1)
        ) {
          break;
        }
        Add(k, nesting);
        pending_nest = true;
        break;
      case 'do':
        Add(k, nesting);
        pending_nest = true;
        break;
      case '?':
        Add(k, nesting);
        break;
      case 'goto':
        Add(k, 0);
        break;
      case '{':
        if (!IsBlockBrace(tokens, k)) {
          blocks.push(false);
          break;
        }
        blocks.push(pending_nest);
        if (pending_nest) nesting++;
        pending_nest = false;
        break;
      case '}':
        if (blocks.pop()) nesting--;
        break;
      case '(':
        parens++;
        break;
      case ')':
        parens--;
        break;
      case ';':
        // Ветка без фигурных скобок закончилась (но не ; в заголовке for).
        if (parens === 0) pending_nest = false;
        break;
    }
    if (
      t.text === '&&' ||
      t.text === '||' ||
      t.text === 'and' ||
      t.text === 'or'
    ) {
      const op = t.text === 'and' ? '&&' : t.text === 'or' ? '||' : t.text;
      if (op !== last_logical) Add(k, 0);
      last_logical = op;
    } else if (
      t.text === '(' ||
      t.text === ')' ||
      t.text === ';' ||
      t.text === '{' ||
      t.text === ','
    ) {
      last_logical = '';
    }
  }
  return points;
}

// Открывает ли { блок кода, а не инициализацию вида T{...} или = {...}.
const kBlockAfter = new Set([
  ')',
  ';',
  '{',
  '}',
  ':',
  ']',
  'else',
  'do',
  'try',
  'mutable',
  'noexcept',
  'const',
  'override',
  'final',
]);

function IsBlockBrace(tokens: Token[], k: number): boolean {
  return k === 0 || kBlockAfter.has(tokens[k - 1].text);
}

function IsDoWhile(tokens: Token[], close: number): boolean {
  let depth = 0;
  for (let k = close; k >= 0; k--) {
    const t = tokens[k].text;
    if (t === '}') depth++;
    else if (t === '{' && --depth === 0) return tokens[k - 1]?.text === 'do';
  }
  return false;
}

function Measure(
  tokens: Token[],
  name: NameInfo,
  open: number,
  close: number,
  body: number,
  end: number,
): FunctionMetrics {
  const decisions: Record<string, number> = {};
  const cognitive = Cognitive(tokens, body, end);
  const points: DecisionPoint[] = [];
  let cognitive_total = 0;
  let cyclomatic = 1;
  // Стек открытых {: true — блок кода, false — инициализация.
  const braces: boolean[] = [];
  let depth = 0;
  let max_nesting = 0;
  for (let k = body + 1; k < end; k++) {
    const t = tokens[k];
    if (t.text === '{') {
      const block = IsBlockBrace(tokens, k);
      braces.push(block);
      if (block) depth++;
      max_nesting = Math.max(max_nesting, depth);
    } else if (t.text === '}') {
      if (braces.pop()) depth--;
    }
    const is_decision =
      t.kind === 'id'
        ? kDecisionWords.has(t.text)
        : kDecisionPuncts.has(t.text);
    if (is_decision) {
      const key = t.text === 'and' ? '&&' : t.text === 'or' ? '||' : t.text;
      decisions[key] = (decisions[key] ?? 0) + 1;
      cyclomatic++;
    }
    const cog = cognitive.get(k);
    if (cog) cognitive_total += cog.cognitive;
    if (is_decision || cog) {
      points.push({
        line: t.line,
        column: t.column,
        text: t.text,
        cyclomatic: is_decision ? 1 : 0,
        cognitive: cog?.cognitive ?? 0,
        nesting: cog?.nesting ?? 0,
      });
    }
  }
  const code_lines = new Set<number>();
  for (let k = name.first; k <= Math.min(end, tokens.length - 1); k++) {
    code_lines.add(tokens[k].line);
  }
  let display = name.name;
  if (/^(TYPED_)?TEST(_F|_P)?$/.test(display)) {
    const args = tokens
      .slice(open + 1, close)
      .map((t) => t.text)
      .join('');
    display = `${display}(${args.replace(/,/g, ', ')})`;
  }
  const first = tokens[name.first];
  const last = tokens[open - 1];
  return {
    name: display,
    startLine: first.line,
    startColumn: first.column,
    nameEndColumn:
      last.line === first.line
        ? last.column + last.text.length
        : first.column + first.text.length,
    endLine: tokens[Math.min(end, tokens.length - 1)].line,
    cyclomatic,
    cognitive: cognitive_total,
    lines: code_lines.size,
    params: CountParams(tokens, open, close),
    maxNesting: max_nesting,
    decisions,
    points,
  };
}

export function AnalyzeTokens(tokens: Token[]): FunctionMetrics[] {
  const result: FunctionMetrics[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].text === '(' && i > 0) {
      const name = ReadName(tokens, i - 1);
      if (name) {
        const close = MatchClose(tokens, i);
        const body = FindBodyStart(tokens, close + 1);
        if (body >= 0) {
          const end = MatchClose(tokens, body);
          result.push(Measure(tokens, name, i, close, body, end));
          i = end + 1;
          continue;
        }
      }
    }
    i++;
  }
  return result;
}

export function Analyze(source: string): FunctionMetrics[] {
  return AnalyzeTokens(Tokenize(source));
}

export interface Violation {
  metric: 'cyclomatic' | 'cognitive' | 'lines' | 'params' | 'nesting';
  value: number;
  limit: number;
}

export interface MetricLimits {
  maxCyclomatic: number;
  maxCognitive: number;
  maxLines: number;
  maxParams: number;
  maxNesting: number;
}

export function Violations(
  m: FunctionMetrics,
  limits: MetricLimits,
): Violation[] {
  const checks: Array<[Violation['metric'], number, number]> = [
    ['cyclomatic', m.cyclomatic, limits.maxCyclomatic],
    ['cognitive', m.cognitive, limits.maxCognitive],
    ['lines', m.lines, limits.maxLines],
    ['params', m.params, limits.maxParams],
    ['nesting', m.maxNesting, limits.maxNesting],
  ];
  return checks
    .filter(([, value, limit]) => value > limit)
    .map(([metric, value, limit]) => ({metric, value, limit}));
}
