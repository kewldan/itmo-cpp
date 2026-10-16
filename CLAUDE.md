# CLAUDE.md

ITMO C++ Lab Kit — расширение VS Code для лаб по C++ (см. README.md).
Пользователи — студенты с готовыми репозиториями лаб (CMake или Makefile),
macOS и WSL.

## Стек и команды

TypeScript (tsc 7, `module: node20`, CommonJS на выходе), пакетный менеджер —
**bun**, линтер и форматтер — **Biome**, тесты — `node:test` через `bun test`.

```bash
bun install
bun run check        # Biome: линтер + формат (то же в CI)
bun run fix          # Biome: применить исправления
bun run typecheck    # tsc --noEmit
bun run test         # юнит-тесты из test/*.test.ts
bun run test:vscode -- <папка>         # smoke в настоящем VS Code
LABKIT_LANG=ru bun run test:vscode -- <папка>
bun run package      # biome check + сборка + .vsix
code --install-extension itmo-cpp-labkit-<версия>.vsix --force
```

Перед завершением задачи: `bun run check && bun run typecheck && bun run test`.
При изменении поведения расширения поднимите `version` в package.json.

## Устройство

Модули без `vscode` (их проверяют юнит-тесты — держите их чистыми):

- `src/complexity/analyzer.ts` — лексер C++ и метрики функций (цикломатическая,
  когнитивная, строки, параметры, вложенность, точки ветвлений).
- `src/templates.ts` — генерируемые `.clang-format`, `.clang-tidy`, Makefile,
  git-хуки (тексты на en/ru).
- `src/cmake.ts` — CMake File API, разбор `ctest --show-only=json-v1`,
  разбор CI-workflow курса (`tidy-config`), bash-скрипты действий.
- `src/gtest.ts`, `src/time_log.ts` — разбор тестов GoogleTest, учёт времени.

Модули на `vscode`:

- `extension.ts` — активация, команды, контекст `labkit.inLab`.
- `lab.ts` — корень лабы (`.labkit.json` → корень git → Makefile вне `build/`),
  система сборки (`labkit` / `cmake` / `make`), поиск LLVM.
- `tasks.ts` — действия build/run/test/fmt/check как задачи VS Code, doctor.
- `tests.ts` — Test Controller для GoogleTest.
- `complexity/provider.ts` — CodeLens, hover, подсветка «+N», диагностика,
  отчёт. `report.ts` — вкладка отчёта (webview, без Untitled-документа).
- `task_view.ts` — панель условия с чек-листом. `menu.ts` — кнопка «Lab Kit».
- `setup.ts`, `hooks.ts`, `time_tracker.ts`, `platform.ts`, `i18n.ts`.

## Соглашения

- Стиль — Google, адаптированный к TS: функции и методы `PascalCase`,
  переменные `snake_case`, приватные поля `name_`, константы `kName`.
  Форматирование — только Biome (`bun run fix`), руками не выравнивать.
- Комментарии в коде — на русском, объясняют «почему».
- **Все строки интерфейса** — через `T('English text {0}', arg)` из `i18n.ts`,
  перевод — в `l10n/bundle.l10n.ru.json`. Строки манифеста — `%ключ%` в
  package.json, тексты в `package.nls.json` и `package.nls.ru.json`.
  Тест `test/l10n.test.ts` падает при непереведённой или лишней строке.
  Склейку `'…' + '…'` внутри `T()` тест понимает — пишите длинные ключи так.
- Тесты преподавателя (`tests/`, `test/`, `*_test(s).*`) не проверяются
  clang-format/clang-tidy и не попадают в отчёт о сложности — см. `IsTestPath`.

## Подводные камни

- Генерируемые bash-скрипты и хуки должны работать в **bash 3.2** (macOS):
  без `mapfile`, пустые массивы под `set -u` — через `${a[@]+"${a[@]}"}`.
- Makefile должен работать в **GNU Make 3.81** (macOS): скобки внутри
  `$(shell …)` ломают разбор — выносите регулярки в переменные.
- `vscode.workspace.findFiles` не понимает вложенные `{}` в glob — фильтруйте
  в коде.
- `onDidChangeTextDocument` приходит и при смене «грязного» состояния
  (автосохранение) — проверяйте `contentChanges.length`.
- CMake кладёт свои Makefile в `build/` — не путать с корнем лабы.
- Длинные скрипты задач пишутся в `build/.labkit/<действие>.sh`, иначе
  VS Code печатает в терминал весь текст скрипта.
- Smoke-тесты в VS Code запускают установленный VS Code
  (`/Applications/Visual Studio Code.app`), без скачивания.
