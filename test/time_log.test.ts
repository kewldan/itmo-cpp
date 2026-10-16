import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  ActivityClock,
  AddTime,
  DaysLeft,
  EmptyTimeData,
  FormatDuration,
  ParseTimeData,
} from '../src/time_log';

const kMinute = 60000;

test('засчитывает время только после активности', () => {
  const clock = new ActivityClock(5 * kMinute, kMinute, 0);
  assert.equal(clock.Tick(15000), 0);
  clock.Activity(15000);
  assert.equal(clock.Tick(30000), 15000);
  // 4 минуты без действий — ещё считаем.
  assert.equal(clock.Tick(30000 + 4 * kMinute), kMinute);
  // Больше 5 минут — простой.
  assert.equal(clock.Tick(30000 + 6 * kMinute), 0);
  clock.Activity(30000 + 6 * kMinute);
  // Ноутбук спал час: засчитываем не больше одного тика.
  assert.equal(clock.Tick(30000 + 6 * kMinute + 30000), 30000);
});

test('копит время по дням', () => {
  const data = EmptyTimeData();
  AddTime(data, 90, new Date(2026, 9, 16, 23, 59));
  AddTime(data, 30, new Date(2026, 9, 17, 0, 1));
  assert.equal(data.totalSeconds, 120);
  assert.deepEqual(data.days, {'2026-10-16': 90, '2026-10-17': 30});
  const copy = ParseTimeData(JSON.stringify(data));
  assert.deepEqual(copy, data);
});

test('форматирует длительность и дедлайн', () => {
  const ru = {hour: 'ч', minute: 'мин'};
  assert.equal(FormatDuration(59, ru), '0 мин');
  assert.equal(FormatDuration(65 * 60, ru), '1 ч 05 мин');
  assert.equal(FormatDuration(65 * 60), '1 h 05 min');
  const now = new Date(2026, 9, 16, 22, 0);
  assert.equal(DaysLeft('2026-10-16', now), 0);
  assert.equal(DaysLeft('2026-11-01', now), 16);
  assert.equal(DaysLeft('2026-10-15', now), -1);
  assert.equal(DaysLeft('завтра', now), undefined);
});
