import { describe, expect, it, vi } from "vitest";
import {
  advance,
  expandEvents,
  isWorkingDay,
  rewind,
  workingMinutesBetween,
} from "./calendar";
import { at, context, event, stamp } from "./fixtures.test-helper";

describe("working-time cursor", () => {
  it("crosses lunch, weekend, boundaries and supports signed inverse travel", () => {
    const c = context();
    expect(advance(at(5, 11), 120, c)).toBe(at(5, 14));
    expect(advance(at(9, 16), 120, c)).toBe(at(12, 10));
    expect(rewind(at(12, 10), 120, c)).toBe(at(9, 16));
    expect(advance(at(5, 13), -60, c)).toBe(at(5, 11));
    expect(advance(at(5, 8), 60, c)).toBe(at(5, 10));
    expect(rewind(at(5, 19), 60, c)).toBe(at(5, 16));
    expect(advance(at(5), 0, c)).toBe(at(5));
    expect(workingMinutesBetween(at(5), at(6), c)).toBe(420);
    expect(workingMinutesBetween(at(6), at(5), c)).toBe(-420);
    expect(workingMinutesBetween(at(5), at(5), c)).toBe(0);
  });
  it("honors holidays, makeup workdays, null segment inheritance and calendar IDs", () => {
    const c = context();
    c.exceptions = [
      {
        ...stamp("h"),
        calendar_id: "cal",
        date: "2026-01-05",
        kind: "holiday",
        is_working: false,
        segments: null,
        note: "",
      },
      {
        ...stamp("m"),
        calendar_id: "cal",
        date: "2026-01-10",
        kind: "makeup_workday",
        is_working: true,
        segments: [{ start: "10:00", end: "11:00" }],
        note: "",
      },
    ];
    expect(advance(at(5), 60, c)).toBe(at(6, 10));
    expect(isWorkingDay(at(10), c)).toBe(true);
    expect(advance(at(10), 60, c)).toBe(at(10, 11));
    c.exceptions[0].is_working = true;
    expect(advance(at(5), 60, c)).toBe(at(5, 10));
    c.exceptions[0].deleted_at = 1;
    c.rules[1].calendar_id = "other";
    expect(isWorkingDay(at(5), c)).toBe(false);
  });
  it("unions overlapping work segments and subtracts overlapping exclusions", () => {
    const c = context();
    c.rules[1].segments = [
      { start: "09:00", end: "12:00" },
      { start: "11:00", end: "17:00" },
    ];
    c.events = [
      event({
        override: { target_type: "task", target_id: "a", mode: "exclude" },
      }),
      event({
        id: "e2",
        start_at: at(5, 10, 30),
        end_at: at(5, 12),
        override: { target_type: "project", target_id: "p", mode: "exclude" },
      }),
      event({
        id: "unrelated",
        start_at: at(5, 13),
        end_at: at(5, 16),
        override: { target_type: "task", target_id: "other", mode: "exclude" },
      }),
    ];
    expect(advance(at(5), 120, c)).toBe(at(5, 13));
    expect(rewind(at(5, 13), 120, c)).toBe(at(5));
    expect(workingMinutesBetween(at(5), at(5, 17), c)).toBe(360);
    expect(isWorkingDay(at(5), c)).toBe(false);
    expect(isWorkingDay(at(6), c)).toBe(true);
  });
  it("preserves local clock in whole working days, including reverse and exclusions", () => {
    const c = context();
    expect(advance(at(9, 14, 30), 1440, c, "full_days")).toBe(at(12, 14, 30));
    expect(rewind(at(12, 14, 30), 1440, c, "full_days")).toBe(at(9, 14, 30));
    expect(workingMinutesBetween(at(9, 14), at(12, 14), c, "full_days")).toBe(
      1440,
    );
    expect(workingMinutesBetween(at(9, 14), at(12, 13), c, "full_days")).toBe(
      0,
    );
    expect(workingMinutesBetween(at(12, 14), at(9, 14), c, "full_days")).toBe(
      -1440,
    );
    c.events = [
      event({
        start_at: at(12, 10),
        end_at: at(12, 11),
        override: { target_type: "task", target_id: "a", mode: "exclude" },
      }),
    ];
    expect(advance(at(9, 14), 1440, c, "full_days")).toBe(at(13, 14));
    expect(() => advance(at(5), 1, c, "full_days")).toThrow("multiples");
  });
  it("handles DST calendar dates rather than elapsed 24-hour additions", () => {
    vi.stubEnv("TZ", "America/New_York");
    try {
      const c = context();
      c.rules.forEach((r) => {
        r.is_working = true;
      });
      for (const [month, day, hours] of [
        [2, 7, 23],
        [9, 31, 25],
      ]) {
        const start = at(day, 14, 30, month),
          d = new Date(start);
        d.setDate(d.getDate() + 1);
        expect((+d - start) / 3_600_000).toBe(hours);
        expect(advance(start, 1440, c, "full_days")).toBe(+d);
        expect(rewind(+d, 1440, c, "full_days")).toBe(start);
        expect(workingMinutesBetween(start, +d, c, "full_days")).toBe(1440);
        const events = expandEvents(
          [
            event({
              start_at: start,
              end_at: start + 3_600_000,
              rrule: "FREQ=DAILY;COUNT=2",
            }),
          ],
          start,
          +d + 3_600_001,
        );
        expect(events[1].start_at).toBe(+d);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("validates invalid inputs, segments and unreachable calendars", () => {
    const c = context();
    expect(() => advance(NaN, 1, c)).toThrow("finite");
    expect(() => workingMinutesBetween(0, Infinity, c)).toThrow("finite");
    c.rules[1].segments = [{ start: "garbage", end: "17:00" }];
    expect(() => advance(at(5), 1, c)).toThrow("Invalid work time");
    c.rules[1].segments = [{ start: "17:00", end: "09:00" }];
    expect(() => advance(at(5), 1, c)).toThrow("end after");
    c.rules = [];
    expect(() => advance(at(5), 1, c)).toThrow("horizon");
    expect(() => advance(at(5), 1440, c, "full_days")).toThrow("horizon");
  });
  it("supports midnight segments, ignores unrelated/deleted exclusions and measures cursor invariants", () => {
    const c = context();
    c.rules[1].segments = [{ start: "23:00", end: "24:00" }];
    expect(advance(at(5, 23), 60, c)).toBe(at(6, 0));
    c.rules = context().rules;
    c.events = [
      event(),
      event({
        id: "foreign",
        calendar_id: "other",
        override: { target_type: "task", target_id: "a", mode: "exclude" },
      }),
      event({
        id: "deleted",
        deleted_at: 1,
        override: { target_type: "task", target_id: "a", mode: "exclude" },
      }),
      event({
        id: "rewrite",
        override: { target_type: "task", target_id: "a", mode: "rewrite" },
      }),
    ];
    expect(advance(at(5), 120, c)).toBe(at(5, 11));
    for (const minutes of [1, 30, 180, 420, 421, 1000]) {
      const end = advance(at(5), minutes, c);
      expect(workingMinutesBetween(at(5), end, c)).toBe(minutes);
      expect(rewind(end, minutes, c)).toBe(at(5));
    }
    c.target = undefined;
    c.project_id = undefined;
    expect(isWorkingDay(at(5), c)).toBe(true);
  });
  it("handles full-segment blocks, recurring exclusions and missing/deleted weekday rules", () => {
    const c = context();
    c.events = [
      event({
        start_at: at(5, 8),
        end_at: at(5, 18),
        rrule: "FREQ=DAILY;COUNT=2",
        override: { target_type: "task", target_id: "a", mode: "exclude" },
      }),
    ];
    expect(advance(at(5), 60, c)).toBe(at(7, 10));
    expect(rewind(at(7, 10), 60, c)).toBe(at(7));
    expect(workingMinutesBetween(at(5), at(7), c)).toBe(0);
    c.events = [];
    c.rules[1].deleted_at = 1;
    expect(isWorkingDay(at(5), c)).toBe(false);
    c.rules = [];
    c.exceptions = [
      {
        ...stamp("custom"),
        calendar_id: "cal",
        date: "2026-01-05",
        kind: "custom",
        is_working: true,
        segments: null,
        note: "",
      },
    ];
    expect(isWorkingDay(at(5), c)).toBe(true);
    expect(workingMinutesBetween(at(5), at(6), c)).toBe(0);
    c.events = [
      event({
        override: { target_type: "task", target_id: "a", mode: "exclude" },
      }),
    ];
    c.target = undefined;
    expect(isWorkingDay(at(5), c)).toBe(true);
  });
});

describe("recurrence expansion", () => {
  it("includes intersecting events, excludes deleted and uses half-open query end", () => {
    expect(
      expandEvents(
        [
          event(),
          event({ id: "deleted", deleted_at: 1 }),
          event({ id: "later", start_at: at(6), end_at: at(6, 10) }),
        ],
        at(5, 10, 30),
        at(6),
      ),
    ).toHaveLength(1);
    expect(() => expandEvents([], 2, 1)).toThrow("range");
    expect(() =>
      expandEvents([event({ end_at: at(4) })], at(5), at(6)),
    ).toThrow("before");
  });
  it("expands daily intervals/counts and honors BYDAY filtering", () => {
    const e = event({ rrule: "RRULE:FREQ=DAILY;INTERVAL=2;COUNT=3" });
    const result = expandEvents([e], at(1), at(20));
    expect(result.map((e) => new Date(e.start_at).getDate())).toEqual([
      5, 7, 9,
    ]);
    expect(result.every((e) => e.end_at - e.start_at === 3600000)).toBe(true);
    expect(
      expandEvents(
        [event({ rrule: "FREQ=DAILY;BYDAY=MO,WE;COUNT=2" })],
        at(1),
        at(20),
      ).map((e) => new Date(e.start_at).getDate()),
    ).toEqual([5, 7]);
  });
  it("expands Monday-anchored weekly intervals and default weekday", () => {
    expect(
      expandEvents(
        [event({ rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=4" })],
        at(1),
        at(31),
      ).map((e) => new Date(e.start_at).getDate()),
    ).toEqual([5, 9, 19, 23]);
    expect(
      expandEvents(
        [event({ rrule: "FREQ=WEEKLY;COUNT=2" })],
        at(1),
        at(31),
      ).map((e) => new Date(e.start_at).getDate()),
    ).toEqual([5, 12]);
  });
  it("skips nonexistent monthly dates and supports monthly weekday sets", () => {
    const e = event({
      start_at: at(31, 10),
      end_at: at(31, 11),
      rrule: "FREQ=MONTHLY;COUNT=3",
    });
    expect(
      expandEvents([e], at(1), at(1, 0, 0, 5)).map((e) =>
        new Date(e.start_at).getMonth(),
      ),
    ).toEqual([0, 2, 4]);
    expect(
      expandEvents(
        [event({ rrule: "FREQ=MONTHLY;BYDAY=MO;COUNT=2" })],
        at(1),
        at(31),
      ).map((e) => new Date(e.start_at).getDate()),
    ).toEqual([5, 12]);
  });
  it("honors local/UTC UNTIL and preserves multi-day wall-clock ends", () => {
    expect(
      expandEvents(
        [event({ rrule: "FREQ=DAILY;UNTIL=20260106" })],
        at(1),
        at(20),
      ),
    ).toHaveLength(2);
    const until = new Date(at(6, 10))
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(".000", "");
    expect(
      expandEvents(
        [event({ rrule: `FREQ=DAILY;UNTIL=${until}` })],
        at(1),
        at(20),
      ),
    ).toHaveLength(2);
    const result = expandEvents(
      [event({ end_at: at(6, 12), rrule: "FREQ=DAILY;COUNT=2" })],
      at(1),
      at(20),
    );
    expect(result[1].end_at).toBe(at(7, 12));
  });
  it.each([
    "FREQ=YEARLY",
    "FREQ=DAILY;BYMONTH=1",
    "FREQ=DAILY;COUNT=0",
    "FREQ=DAILY;INTERVAL=x",
    "FREQ=DAILY;COUNT=9007199254740992",
    "FREQ=DAILY;BYDAY=1MO",
    "FREQ=DAILY;UNTIL=invalid",
    "FREQ=DAILY;UNTIL=20261301",
    "FREQ=DAILY;UNTIL=20260230",
    "FREQ=DAILY;UNTIL=20260105T250000",
    "FREQ=DAILY;UNTIL=20260105T106000",
    "FREQ=DAILY;UNTIL=20260105T100060",
    "FREQ=DAILY;FREQ=WEEKLY",
    "FREQ=DAILY;COUNT=1=2",
    "FREQ=DAILY;COUNT=",
    "=DAILY",
  ])("rejects unsupported or invalid RRULE %s", (rrule) => {
    expect(() => expandEvents([event({ rrule })], at(1), at(20))).toThrow();
  });
  it("bounds very distant expansions and calendar spans explicitly", () => {
    const far = at(1, 0, 0, 0, 4000);
    expect(() =>
      expandEvents(
        [event({ rrule: "FREQ=DAILY;INTERVAL=999999" })],
        at(1),
        far,
      ),
    ).toThrow("horizon");
    const c = context();
    c.rules = [];
    expect(() => workingMinutesBetween(at(1), far, c)).toThrow("horizon");
    expect(() => workingMinutesBetween(at(1), far, c, "full_days")).toThrow(
      "horizon",
    );
    expect(expandEvents([event()], at(5, 10), at(5, 10))).toEqual([]);
    expect(
      expandEvents([event({ rrule: "FREQ=DAILY;COUNT=2" })], at(10), at(20)),
    ).toEqual([]);
    expect(expandEvents([event()], at(6), at(7))).toEqual([]);
    expect(
      expandEvents(
        [event({ rrule: "FREQ=DAILY;UNTIL=20260106T100000" })],
        at(1),
        at(20),
      ),
    ).toHaveLength(2);
  }, 20_000);
});
