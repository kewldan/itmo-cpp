import assert from 'node:assert/strict';
import {test} from 'node:test';

import {ParseCiWorkflow, ParseCtestExecutables} from '../src/cmake';

const kWorkflow = `jobs:
  tests:
    with:
      platforms: |
        [
          {
            "id": "clang_san",
            "compiler": "clang++-21",
            "flags": "-fsanitize=address,undefined"
          }
        ]

  codestyle:
    with:
      levels: |
        [9, 6, 3, 0]
      tidy-version: 21
      tidy-config: |
        Checks:
          -*,
          readability-identifier-naming,

        CheckOptions:
          - { key: readability-identifier-naming.ClassCase, value: CamelCase }

  report:
    name: Report
`;

test('достаёт конфиг clang-tidy и параметры CI', () => {
  const ci = ParseCiWorkflow(kWorkflow);
  assert.equal(ci.tidyVersion, 21);
  assert.equal(ci.compiler, 'clang++-21');
  assert.equal(ci.flags, '-fsanitize=address,undefined');
  assert.equal(
    ci.tidyConfig,
    `Checks:
  -*,
  readability-identifier-naming,

CheckOptions:
  - { key: readability-identifier-naming.ClassCase, value: CamelCase }
`,
  );
});

test('без codestyle конфига нет', () => {
  assert.equal(
    ParseCiWorkflow('jobs:\n  build:\n    runs-on: x\n').tidyConfig,
    undefined,
  );
});

test('бинарники тестов из ctest', () => {
  const json = JSON.stringify({
    tests: [
      {name: 'A.B', command: ['/b/tests/lab_tests', '--gtest_filter=A.B']},
      {name: 'A.C', command: ['/b/tests/lab_tests', '--gtest_filter=A.C']},
      {name: 'X.Y', command: ['/b/other', '--gtest_filter=X.Y']},
      {name: 'broken'},
    ],
  });
  assert.deepEqual(ParseCtestExecutables(json), [
    '/b/tests/lab_tests',
    '/b/other',
  ]);
});
