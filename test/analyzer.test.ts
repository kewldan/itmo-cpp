import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Analyze, Tokenize, Violations} from '../src/complexity/analyzer';
import {kDefaultLimits} from '../src/templates';

test('пропускает комментарии, строки и препроцессор', () => {
  const tokens = Tokenize(`#define F(x) if (x) {}
// if (a && b)
/* for while */ const char* s = "if && ||"; auto r = R"x(if ")" && )x";
char c = '{';`);
  const texts = tokens.map((t) => t.text);
  assert.ok(!texts.includes('if'));
  assert.ok(!texts.includes('&&'));
  assert.ok(!texts.includes('{'));
  assert.equal(tokens[0].line, 2);
});

test('простая функция', () => {
  const [f] = Analyze('int Add(int a, int b) { return a + b; }');
  assert.equal(f.name, 'Add');
  assert.equal(f.cyclomatic, 1);
  assert.equal(f.cognitive, 0);
  assert.equal(f.params, 2);
  assert.equal(f.maxNesting, 0);
  assert.equal(f.lines, 1);
});

test('ветвления и логические операторы', () => {
  const [f] = Analyze(`
int Classify(int x) {
  if (x > 0 && x < 10) {
    for (int i = 0; i < x; ++i) {
      if (i % 2 == 0 || i == 3) return i;
    }
  } else if (x < 0) {
    return -1;
  } else {
    return x ? 1 : 0;
  }
  switch (x) {
    case 1: return 1;
    case 2: return 2;
    default: return 0;
  }
}`);
  // 1 + if, &&, for, if, ||, if, ?, case, case
  assert.equal(f.cyclomatic, 10);
  assert.deepEqual(f.decisions, {
    if: 3,
    '&&': 1,
    for: 1,
    '||': 1,
    '?': 1,
    case: 2,
  });
  assert.equal(f.maxNesting, 2);
  assert.equal(f.lines, 16);
  // if 1, && 1, for 2, if 3, || 1, else-if 1, else 1, ?: 2, switch 1
  assert.equal(f.cognitive, 13);
});

test('методы, конструкторы, операторы и деструкторы', () => {
  const names = Analyze(`
namespace lab {
class Point {
 public:
  Point(int x, int y) : x_(x), y_{y} {}
  ~Point() = default;
  int x() const { return x_; }
  void set_x(int x) noexcept { x_ = x; }
  bool operator==(const Point& other) const = default;
  Point operator+(const Point& o) const { return {x_ + o.x_, y_ + o.y_}; }
  int Get() const;
 private:
  int x_;
  int y_;
};
int Point::Get() const { return x_; }
Point::~Point() {}
template <typename T>
auto Max(const std::vector<T>& v, std::map<int, int> m) -> T { return v[0]; }
}  // namespace lab`).map((f) => `${f.name}/${f.params}`);
  assert.deepEqual(names, [
    'Point/2',
    'x/0',
    'set_x/1',
    'operator+/1',
    'Point::Get/0',
    'Point::~Point/0',
    'Max/2',
  ]);
});

test('макросы GoogleTest и лямбды', () => {
  const fs = Analyze(`
TEST(MathTest, Adds) {
  auto f = [](int a) { if (a) { return 1; } return 0; };
  EXPECT_EQ(f(1), 1);
}
TEST_F(Fixture, Works) { EXPECT_TRUE(true); }`);
  assert.deepEqual(
    fs.map((f) => f.name),
    ['TEST(MathTest, Adds)', 'TEST_F(Fixture, Works)'],
  );
  assert.equal(fs[0].cyclomatic, 2);
});

test('не путает объявления и вызовы с определениями', () => {
  const fs = Analyze(`
int Foo(int);
int x = Bar(1);
std::vector<int> v = {Baz(2)};
struct S { int a; } s;
MACRO(arg) class Hidden { void M() {} };
static_assert(sizeof(int) == 4);`);
  assert.deepEqual(
    fs.map((f) => f.name),
    ['M'],
  );
});

test('нарушения порогов', () => {
  const body = Array.from({length: 12}, (_, i) => `if (a == ${i}) b++;`);
  const [f] = Analyze(`void F(int a, int b) {\n${body.join('\n')}\n}`);
  const metrics = Violations(f, kDefaultLimits).map((v) => v.metric);
  assert.deepEqual(metrics, ['cyclomatic']);
});

test('точки сложности с вложенностью', () => {
  const [f] = Analyze(`int F(int x) {
  for (int i = 0; i < x; ++i) {
    if (i > 2 && i < 5) return i;
  }
  return 0;
}`);
  assert.equal(f.nameEndColumn, 5);
  assert.deepEqual(
    f.points.map(
      (p) =>
        `${p.line}:${p.column} ${p.text} ` + `+${p.cyclomatic}/+${p.cognitive}`,
    ),
    ['1:2 for +1/+1', '2:4 if +1/+2', '2:14 && +1/+1'],
  );
  assert.equal(
    f.points.reduce((s, p) => s + p.cognitive, 0),
    f.cognitive,
  );
});

test('инициализация в фигурных скобках — не вложенность', () => {
  const [f] = Analyze(`bool IsBitSet(const Num& num, size_t bit) noexcept {
  return ((unsigned{num.data[bit / 8]} >> (bit % 8)) & 1U) != 0;
}`);
  assert.equal(f.maxNesting, 0);
  const [g] = Analyze(`int F(int x) {
  std::vector<int> v = {1, 2};
  if (x == Point{1, 2}.x) {
    for (int i : v) { x += i; }
  }
  return x;
}`);
  assert.equal(g.maxNesting, 2);
  // if +1, for +2 (вложенность 1)
  assert.equal(g.cognitive, 3);
});

test('имя оператора приведения', () => {
  const [f] = Analyze('Num::operator int64_t() const { return v_; }');
  assert.equal(f.name, 'Num::operator int64_t');
});
