// CMake-лабы и конфиг CI без vscode: File API, ctest, скрипты для задач.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {Lang} from './templates';

export interface CmakeTarget {
  name: string;
  path: string; // абсолютный путь к исполняемому файлу
  sourceDir: string; // папка CMakeLists.txt цели относительно корня
}

// Исполняемые цели из ответа CMake File API (codemodel-v2). Читаем
// objects из index, поэтому подходит и ответ, который запросило расширение
// CMake Tools.
export function ReadExecutables(build_dir: string): CmakeTarget[] {
  const reply = path.join(build_dir, '.cmake', 'api', 'v1', 'reply');
  let index_file: string | undefined;
  try {
    index_file = fs
      .readdirSync(reply)
      .filter((f) => /^index-.*\.json$/.test(f))
      .sort()
      .pop();
  } catch {
    return [];
  }
  if (!index_file) return [];
  const Read = (file: string) =>
    JSON.parse(fs.readFileSync(path.join(reply, file), 'utf8'));
  const index = Read(index_file);
  const codemodel = (index.objects ?? []).find(
    (o: {kind: string}) => o.kind === 'codemodel',
  );
  if (!codemodel) return [];
  const model = Read(codemodel.jsonFile);
  const configuration = model.configurations?.[0];
  const targets: CmakeTarget[] = [];
  for (const ref of configuration?.targets ?? []) {
    const target = Read(ref.jsonFile);
    if (target.type !== 'EXECUTABLE' || !target.artifacts?.length) continue;
    const source_dir: string = target.paths?.source ?? '.';
    // Цели из FetchContent (googletest и т.п.) — не наши.
    if (source_dir.startsWith('..') || /(^|\/)_deps\//.test(source_dir)) {
      continue;
    }
    const artifact: string = target.artifacts[0].path;
    targets.push({
      name: target.name,
      path: path.isAbsolute(artifact)
        ? artifact
        : path.join(build_dir, artifact),
      sourceDir: source_dir,
    });
  }
  return targets;
}

// Бинарники с тестами из `ctest --show-only=json-v1`.
export function ParseCtestExecutables(json: string): string[] {
  const data = JSON.parse(json) as {tests?: Array<{command?: string[]}>};
  const executables = new Set<string>();
  for (const test of data.tests ?? []) {
    if (test.command?.[0]) executables.add(test.command[0]);
  }
  return [...executables];
}

export interface CiConfig {
  tidyConfig?: string;
  tidyVersion?: number;
  compiler?: string;
  flags?: string;
}

// Блок YAML вида `key: |` и строки с большим отступом под ним.
function BlockScalar(lines: string[], key: string): string | undefined {
  const start = lines.findIndex((l) =>
    new RegExp(`^\\s*${key}:\\s*\\|`).test(l),
  );
  if (start < 0) return undefined;
  const base = lines[start].search(/\S/);
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= base) break;
    block.push(line);
  }
  while (block.length && block[block.length - 1].trim() === '') block.pop();
  const indent = Math.min(
    ...block.filter((l) => l.trim()).map((l) => l.search(/\S/)),
  );
  return `${block.map((l) => l.slice(indent)).join('\n')}\n`;
}

function Scalar(lines: string[], key: string): string | undefined {
  for (const line of lines) {
    // "key": "value", или key: value
    const match = new RegExp(
      `^\\s*"?${key}"?:\\s*(?:"([^"]*)"|([^\\s"|][^,]*?))\\s*,?\\s*$`,
    ).exec(line);
    if (match) return match[1] ?? match[2];
  }
  return undefined;
}

// Что CI курса проверяет: tidy-config и tidy-version из codestyle, а также
// компилятор и флаги тестов (is-itmo-cpp/cicd).
export function ParseCiWorkflow(text: string): CiConfig {
  const lines = text.split(/\r?\n/);
  const version = Scalar(lines, 'tidy-version');
  return {
    tidyConfig: BlockScalar(lines, 'tidy-config'),
    tidyVersion: version && /^\d+$/.test(version) ? Number(version) : undefined,
    compiler: Scalar(lines, 'compiler'),
    flags: Scalar(lines, 'flags'),
  };
}

export function FindCiConfig(lab_root: string): CiConfig | undefined {
  const dir = path.join(lab_root, '.github', 'workflows');
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort();
  } catch {
    return undefined;
  }
  for (const file of files) {
    const config = ParseCiWorkflow(
      fs.readFileSync(path.join(dir, file), 'utf8'),
    );
    if (config.tidyConfig) return config;
  }
  return undefined;
}

export type CmakeAction = 'build' | 'run' | 'test' | 'fmt' | 'check';

export interface CmakeScriptOptions {
  buildDir: string;
  configureArgs: string[];
  clangFormat: string;
  clangTidy: string;
  // Конфиг clang-tidy из CI: тогда check проверяет ровно как CI.
  tidyConfigFile?: string;
  // Для run: какую цель собрать и запустить.
  runTarget?: CmakeTarget;
  lang: Lang;
}

const kText = {
  en: {
    configure: 'Configuring CMake',
    format: 'clang-format',
    notFormatted: 'Not formatted:',
    fix: 'Fix: Lab Kit: Format the Whole Lab',
    build: 'Build',
    tidy: 'clang-tidy',
    tests: 'Tests',
    passed: 'All clean, ready to submit.',
    failed: 'Check failed:',
    noFormatConfig: 'no .clang-format in the repository, skipped',
  },
  ru: {
    configure: 'Настройка CMake',
    format: 'clang-format',
    notFormatted: 'Не отформатированы:',
    fix: 'Исправить: Lab Kit: Отформатировать всю лабу',
    build: 'Сборка',
    tidy: 'clang-tidy',
    tests: 'Тесты',
    passed: 'Всё чисто, можно сдавать.',
    failed: 'Проверка не прошла:',
    noFormatConfig: 'в репозитории нет .clang-format, пропущено',
  },
};

function Quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Скрипт bash для задачи VS Code. Совместим с bash 3.2 из macOS.
export function CmakeScript(
  action: CmakeAction,
  o: CmakeScriptOptions,
): string {
  const t = kText[o.lang];
  const B = Quote(o.buildDir);
  const configure_args = o.configureArgs.map(Quote).join(' ');
  const tidy_config = o.tidyConfigFile
    ? ` --config-file=${Quote(o.tidyConfigFile)}`
    : '';
  const header = `set -u
B=${B}
CLANG_FORMAT=${Quote(o.clangFormat)}
CLANG_TIDY=${Quote(o.clangTidy)}
step() { printf '\\n\\033[1m▶ %s\\033[0m\\n' "$1"; }
configure() {
  # Запрос codemodel для File API: по нему находятся исполняемые цели.
  mkdir -p "$B/.cmake/api/v1/query"
  if [ ! -f "$B/CMakeCache.txt" ] || \\
     [ ! -f "$B/.cmake/api/v1/query/codemodel-v2" ]; then
    touch "$B/.cmake/api/v1/query/codemodel-v2"
    step ${Quote(t.configure)}
    cmake -S . -B "$B" -DCMAKE_EXPORT_COMPILE_COMMANDS=ON ${configure_args} \\
      || return 1
  fi
}
build() { configure && cmake --build "$B" --parallel; }
sources() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git ls-files --cached --others --exclude-standard -- \\
      '*.cpp' '*.cc' '*.cxx' '*.h' '*.hpp'
  else
    find . -type d \\( -name "$(basename "$B")" -o -name '_deps' \\
      -o -name 'cmake-build-*' -o -name '.?*' \\) -prune -o -type f \\
      \\( -name '*.cpp' -o -name '*.cc' -o -name '*.cxx' -o -name '*.h' \\
      -o -name '*.hpp' \\) -print | sed 's|^\\./||'
  fi
}
# Свой код — всё, кроме тестов: их обычно даёт преподаватель.
files=()
while IFS= read -r file; do
  case "$file" in tests/*|test/*|*_test.*|*_tests.*) continue ;; esac
  [ -f "$file" ] && files+=("$file")
done < <(sources)
jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)
ctest_run() {
  ctest --test-dir "$B" --output-on-failure --progress --parallel "$jobs"
}
`;
  switch (action) {
    case 'build':
      return `${header}build\n`;
    case 'run': {
      const target = o.runTarget;
      if (!target) throw new Error('CmakeScript: run needs runTarget');
      return `${header}configure && \\
  cmake --build "$B" --parallel --target ${Quote(target.name)} && \\
  ${Quote(target.path)}
`;
    }
    case 'test':
      return `${header}build && ctest_run\n`;
    case 'fmt':
      return `${header}[ \${#files[@]} -eq 0 ] && exit 0
[ -f .clang-format ] || [ -f _clang-format ] || \\
  { echo "— ${t.noFormatConfig}"; exit 1; }
"$CLANG_FORMAT" -i --style=file "\${files[@]}" && echo "✔ \${#files[@]}"
`;
    case 'check':
      return `${header}failed=()

step ${Quote(t.format)}
bad=()
if [ ! -f .clang-format ] && [ ! -f _clang-format ]; then
  echo "— ${t.noFormatConfig}"
  files_to_format=()
else
  files_to_format=(\${files[@]+"\${files[@]}"})
fi
for file in \${files_to_format[@]+"\${files_to_format[@]}"}; do
  "$CLANG_FORMAT" --style=file --dry-run --Werror "$PWD/$file" \\
    >/dev/null 2>&1 || bad+=("$file")
done
if [ \${#bad[@]} -gt 0 ]; then
  echo "✘ ${t.notFormatted}"
  for file in "\${bad[@]}"; do
    "$CLANG_FORMAT" --style=file --dry-run "$PWD/$file" 2>&1 | head -3
  done
  echo "  ${t.fix}"
  failed+=(${Quote(t.format)})
elif [ \${#files_to_format[@]} -gt 0 ]; then
  echo "✔"
fi

step ${Quote(t.build)}
if build; then
  echo "✔"
else
  failed+=(${Quote(t.build)})
fi

step ${Quote(t.tidy)}
tidy=()
for file in \${files[@]+"\${files[@]}"}; do
  case "$file" in *.cpp|*.cc|*.cxx) tidy+=("$PWD/$file") ;; esac
done
if [ \${#tidy[@]} -gt 0 ] && [ -f "$B/compile_commands.json" ]; then
  if "$CLANG_TIDY" --quiet${tidy_config} -p "$B" "\${tidy[@]}" 2>/dev/null \\
      | tee "$B/labkit-tidy.log" | grep -E 'warning:|error:'; then
    failed+=(${Quote(t.tidy)})
  else
    echo "✔"
  fi
fi

step ${Quote(t.tests)}
if ctest_run; then
  echo "✔"
else
  failed+=(${Quote(t.tests)})
fi

echo
if [ \${#failed[@]} -eq 0 ]; then
  echo "✔ ${t.passed}"
else
  echo "✘ ${t.failed} \${failed[*]}"
  exit 1
fi
`;
  }
}
