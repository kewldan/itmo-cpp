import assert from 'node:assert/strict';
import {test} from 'node:test';

import {DiscoverTests, NormalizeResultName} from '../src/gtest';

test('находит тесты и пропускает закомментированные', () => {
  const tests = DiscoverTests(`
TEST(AddTest, Works) { EXPECT_EQ(1, 1); }
// TEST(AddTest, Old) {}
TEST_F(Fixture, Uses) {}
TEST_P(Param, Each) {}
EXPECT_TRUE(Foo(a, b));`);
  assert.deepEqual(
    tests.map((t) => `${t.macro} ${t.suite}.${t.name}:${t.line}`),
    ['TEST AddTest.Works:1', 'TEST_F Fixture.Uses:3', 'TEST_P Param.Each:4'],
  );
});

test('нормализует имена параметризованных и типизированных тестов', () => {
  assert.equal(NormalizeResultName('AddTest', 'Works'), 'AddTest.Works');
  assert.equal(NormalizeResultName('Inst/Param', 'Each/3'), 'Param.Each');
  assert.equal(NormalizeResultName('Typed/0', 'Works'), 'Typed.Works');
});
