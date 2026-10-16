// Учёт времени без vscode: часы активности и формат файла .labkit/time.json.

export interface TimeData {
  version: 1;
  totalSeconds: number;
  days: Record<string, number>; // YYYY-MM-DD → секунды
  firstSeen?: string;
  lastSeen?: string;
}

export function EmptyTimeData(): TimeData {
  return {version: 1, totalSeconds: 0, days: {}};
}

export function ParseTimeData(text: string): TimeData {
  const data = JSON.parse(text) as Partial<TimeData>;
  return {
    version: 1,
    totalSeconds: Number(data.totalSeconds) || 0,
    days: data.days ?? {},
    firstSeen: data.firstSeen,
    lastSeen: data.lastSeen,
  };
}

export function LocalDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-` + `${pad(now.getDate())}`
  );
}

export function AddTime(data: TimeData, seconds: number, now: Date): void {
  if (seconds <= 0) return;
  const day = LocalDate(now);
  data.totalSeconds += seconds;
  data.days[day] = (data.days[day] ?? 0) + seconds;
  data.firstSeen ??= now.toISOString();
  data.lastSeen = now.toISOString();
}

// Время засчитывается, пока с последнего действия прошло не больше idle_ms.
// Большие разрывы между тиками (сон ноутбука) обрезаются до max_tick_ms.
export class ActivityClock {
  private last_activity_ = -Infinity;
  private last_tick_: number;

  constructor(
    private readonly idle_ms: number,
    private readonly max_tick_ms: number,
    now: number,
  ) {
    this.last_tick_ = now;
  }

  Activity(now: number): void {
    this.last_activity_ = now;
  }

  // Сколько миллисекунд засчитать за промежуток с прошлого тика.
  Tick(now: number): number {
    const elapsed = Math.max(0, now - this.last_tick_);
    this.last_tick_ = now;
    if (now - this.last_activity_ > this.idle_ms) return 0;
    return Math.min(elapsed, this.max_tick_ms);
  }
}

export interface DurationUnits {
  hour: string;
  minute: string;
}

const kEnglishUnits: DurationUnits = {hour: 'h', minute: 'min'};

export function FormatDuration(seconds: number, units = kEnglishUnits): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes} ${units.minute}`;
  return (
    `${hours} ${units.hour} ` +
    `${String(minutes % 60).padStart(2, '0')} ${units.minute}`
  );
}

// Целых дней до дедлайна (0 — сегодня, отрицательное — просрочено).
export function DaysLeft(deadline: string, now: Date): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(deadline);
  if (!match) return undefined;
  const due = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due.getTime() - today.getTime()) / 86400000);
}
