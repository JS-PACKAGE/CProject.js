import type {
  CalendarContext,
  CalendarEvent,
  DurationMode,
  Segment,
} from "./types";

const MINUTE = 60_000;
const DAY = 86_400_000;
const LIMIT = 366_000;
const weekdays = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const dateKey = (at: number): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
function midnight(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return +d;
}
function nextDay(at: number, count = 1): number {
  const d = new Date(at);
  d.setDate(d.getDate() + count);
  return +d;
}
function finite(...values: number[]): void {
  if (values.some((v) => !Number.isFinite(v)))
    throw new Error("Time and duration must be finite");
}
function configuration(
  at: number,
  context: CalendarContext,
): { working: boolean; segments: Segment[] } {
  const exception = context.exceptions.find(
    (e) =>
      e.deleted_at === null &&
      e.calendar_id === context.calendar.id &&
      e.date === dateKey(at),
  );
  const rule = context.rules.find(
    (r) =>
      r.deleted_at === null &&
      r.calendar_id === context.calendar.id &&
      r.weekday === new Date(at).getDay(),
  );
  return {
    working: exception?.is_working ?? rule?.is_working ?? false,
    segments: exception?.segments ?? rule?.segments ?? [],
  };
}
function excluded(event: CalendarEvent, context: CalendarContext): boolean {
  const o = event.override;
  if (!o || o.mode !== "exclude") return false;
  return (
    (o.target_type === context.target?.type &&
      o.target_id === context.target.id) ||
    (o.target_type === "project" && o.target_id === context.project_id)
  );
}
function exclusions(
  from: number,
  to: number,
  context: CalendarContext,
): CalendarEvent[] {
  return expandEvents(
    context.events.filter(
      (e) => e.calendar_id === context.calendar.id && excluded(e, context),
    ),
    from,
    to,
  );
}
export function isWorkingDay(at: number, context: CalendarContext): boolean {
  finite(at);
  if (!configuration(at, context).working) return false;
  const start = midnight(at),
    end = nextDay(start);
  // In whole-day mode any excluded portion makes this a non-working day.
  return !exclusions(start, end, context).some(
    (e) => e.start_at < end && e.end_at > start,
  );
}
function clock(day: number, value: string): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) && value !== "24:00")
    throw new Error(`Invalid work time: ${value}`);
  const [h, m] = value.split(":").map(Number),
    d = new Date(day);
  d.setHours(h, m, 0, 0);
  return +d;
}
function intervals(day: number, context: CalendarContext): [number, number][] {
  const config = configuration(day, context);
  if (!config.working) return [];
  const merged: [number, number][] = [];
  for (const s of config.segments
    .map((s) => [clock(day, s.start), clock(day, s.end)] as [number, number])
    .sort((a, b) => a[0] - b[0])) {
    if (s[1] <= s[0])
      throw new Error("Work segments must end after they start");
    const last = merged.at(-1);
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push(s);
  }
  let result = merged;
  for (const e of exclusions(day, nextDay(day), context)) {
    result = result.flatMap(([a, b]): [number, number][] =>
      e.end_at <= a || e.start_at >= b
        ? [[a, b]]
        : [
            ...(a < e.start_at ? [[a, e.start_at] as [number, number]] : []),
            ...(e.end_at < b ? [[e.end_at, b] as [number, number]] : []),
          ],
    );
  }
  return result;
}
export function advance(
  at: number,
  minutes: number,
  context: CalendarContext,
  mode: DurationMode = "working_hours",
): number {
  finite(at, minutes);
  if (!minutes) return at;
  const direction = Math.sign(minutes);
  let remaining = Math.abs(minutes),
    cursor = at;
  if (mode === "full_days") {
    if (remaining % 1440 !== 0)
      throw new Error("Whole-day durations must be multiples of 1440 minutes");
    remaining /= 1440;
    for (let i = 0; i < LIMIT && remaining; i++) {
      cursor = nextDay(cursor, direction);
      if (isWorkingDay(cursor, context)) remaining--;
    }
  } else {
    let day = midnight(cursor);
    for (let i = 0; i < LIMIT && remaining > 0; i++) {
      const slots = intervals(day, context);
      if (direction < 0) slots.reverse();
      for (const [a, b] of slots) {
        const start = direction > 0 ? Math.max(cursor, a) : Math.min(cursor, b);
        const available = (direction > 0 ? b - start : start - a) / MINUTE;
        if (available <= 0) continue;
        if (remaining <= available)
          return start + direction * remaining * MINUTE;
        remaining -= available;
      }
      day = nextDay(day, direction);
      cursor = direction > 0 ? day : nextDay(day);
    }
  }
  if (remaining)
    throw new Error("No reachable working time within calendar search horizon");
  return cursor;
}
export function rewind(
  at: number,
  minutes: number,
  context: CalendarContext,
  mode: DurationMode = "working_hours",
): number {
  return advance(at, -minutes, context, mode);
}
export function workingMinutesBetween(
  start: number,
  end: number,
  context: CalendarContext,
  mode: DurationMode = "working_hours",
): number {
  finite(start, end);
  if (end < start) return -workingMinutesBetween(end, start, context, mode);
  if (start === end) return 0;
  let total = 0,
    day = midnight(start),
    steps = 0;
  if (mode === "full_days") {
    let cursor = start;
    while (cursor < end && steps++ < LIMIT) {
      cursor = nextDay(cursor);
      if (cursor <= end && isWorkingDay(cursor, context)) total += 1440;
    }
  } else {
    while (day < end && steps++ < LIMIT) {
      for (const [a, b] of intervals(day, context))
        total += Math.max(0, Math.min(b, end) - Math.max(a, start)) / MINUTE;
      day = nextDay(day);
    }
  }
  if (steps >= LIMIT) throw new Error("Calendar range exceeds search horizon");
  return total;
}

interface Rule {
  freq: string;
  interval: number;
  count: number;
  until: number;
  days: number[];
}
function parseRule(value: string): Rule {
  const fields: Record<string, string> = {};
  for (const part of value
    .replace(/^RRULE:/i, "")
    .toUpperCase()
    .split(";")) {
    const [key, val, extra] = part.split("=");
    if (
      !key ||
      !val ||
      extra ||
      fields[key] ||
      !["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY"].includes(key)
    )
      throw new Error("Unsupported recurrence rule");
    fields[key] = val;
  }
  if (!["DAILY", "WEEKLY", "MONTHLY"].includes(fields.FREQ))
    throw new Error("Unsupported recurrence frequency");
  const integer = (s: string | undefined, fallback: number): number => {
    if (s === undefined) return fallback;
    const n = Number(s);
    if (!/^\d+$/.test(s) || !Number.isSafeInteger(n) || n < 1)
      throw new Error("Invalid recurrence interval/count");
    return n;
  };
  let until = Infinity;
  if (fields.UNTIL) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(
      fields.UNTIL,
    );
    if (!m) throw new Error("Invalid recurrence UNTIL");
    const values = [
      +m[1],
      +m[2] - 1,
      +m[3],
      +(m[4] ?? 23),
      +(m[5] ?? 59),
      +(m[6] ?? 59),
    ] as const;
    const check = new Date(Date.UTC(...values));
    if (
      check.getUTCFullYear() !== values[0] ||
      check.getUTCMonth() !== values[1] ||
      check.getUTCDate() !== values[2] ||
      values[3] > 23 ||
      values[4] > 59 ||
      values[5] > 59
    )
      throw new Error("Invalid recurrence UNTIL");
    until =
      (m[7] ? Date.UTC(...values) : +new Date(...values)) + (m[4] ? 0 : 999);
  }
  const days = fields.BYDAY
    ? fields.BYDAY.split(",").map((d) => {
        const index = weekdays.indexOf(d);
        if (index < 0) throw new Error("Unsupported recurrence BYDAY");
        return index;
      })
    : [];
  return {
    freq: fields.FREQ,
    interval: integer(fields.INTERVAL, 1),
    count: integer(fields.COUNT, Infinity),
    until,
    days,
  };
}
export function expandEvents(
  events: CalendarEvent[],
  from: number,
  to: number,
): CalendarEvent[] {
  finite(from, to);
  if (to < from) throw new Error("Invalid recurrence range");
  if (from === to) return [];
  const output: CalendarEvent[] = [];
  for (const event of events) {
    if (event.deleted_at !== null) continue;
    finite(event.start_at, event.end_at);
    if (event.end_at < event.start_at)
      throw new Error("Event ends before start");
    if (!event.rrule) {
      if (event.start_at < to && event.end_at >= from)
        output.push({ ...event });
      continue;
    }
    const rule = parseRule(event.rrule),
      origin = new Date(event.start_at),
      startDay = midnight(event.start_at);
    const endOriginal = new Date(event.end_at);
    const daySpan = Math.round(
      (Date.UTC(
        endOriginal.getFullYear(),
        endOriginal.getMonth(),
        endOriginal.getDate(),
      ) -
        Date.UTC(origin.getFullYear(), origin.getMonth(), origin.getDate())) /
        DAY,
    );
    let day = startDay,
      emitted = 0,
      finished = false;
    const serial = (d: Date): number =>
      Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY;
    const originSerial = serial(origin),
      originMonday = originSerial - ((origin.getDay() + 6) % 7);
    for (let i = 0; i < LIMIT; i++, day = nextDay(day)) {
      const d = new Date(day);
      d.setHours(
        origin.getHours(),
        origin.getMinutes(),
        origin.getSeconds(),
        origin.getMilliseconds(),
      );
      const at = +d;
      if (at >= to || at > rule.until || emitted >= rule.count) {
        finished = true;
        break;
      }
      const delta = serial(d) - originSerial,
        months =
          (d.getFullYear() - origin.getFullYear()) * 12 +
          d.getMonth() -
          origin.getMonth();
      const frequencyMatch =
        rule.freq === "DAILY"
          ? delta % rule.interval === 0
          : rule.freq === "WEEKLY"
            ? Math.floor((serial(d) - originMonday) / 7) % rule.interval === 0
            : months % rule.interval === 0 &&
              (rule.days.length > 0 || d.getDate() === origin.getDate());
      const dayMatch = rule.days.length
        ? rule.days.includes(d.getDay())
        : rule.freq !== "WEEKLY" || d.getDay() === origin.getDay();
      if (!frequencyMatch || !dayMatch) continue;
      emitted++;
      const end = new Date(day);
      end.setDate(end.getDate() + daySpan);
      end.setHours(
        endOriginal.getHours(),
        endOriginal.getMinutes(),
        endOriginal.getSeconds(),
        endOriginal.getMilliseconds(),
      );
      if (+end >= from) output.push({ ...event, start_at: at, end_at: +end });
    }
    if (!finished) throw new Error("Recurrence exceeds expansion horizon");
  }
  return output.sort(
    (a, b) => a.start_at - b.start_at || a.id.localeCompare(b.id),
  );
}
