import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { expandEvents } from "../core/calendar";
import { useUI, addDays, dayStart, localDate } from "./ui";
import { EntityActions, type ViewProps } from "./Projects";
export function Calendar({ snapshot, run }: ViewProps) {
  const { t, i18n } = useTranslation();
  const { date, calendarMode, set } = useUI();
  const [calendarId, setCalendarId] = useState("");
  const chosen =
    snapshot.work_calendars.find((c) => c.id === calendarId) ??
    snapshot.work_calendars.find((c) => c.is_default) ??
    snapshot.work_calendars[0];
  const current = new Date(date);
  const first =
    calendarMode === "month"
      ? new Date(current.getFullYear(), current.getMonth(), 1)
      : new Date(dayStart(date));
  const start = addDays(+first, -first.getDay());
  const count = calendarMode === "month" ? 42 : 7;
  const events = useMemo(() => {
    try {
      return {
        values: expandEvents(
          snapshot.calendar_events.filter(
            (e) => !chosen || e.calendar_id === chosen.id,
          ),
          start,
          addDays(start, count),
        ),
        error: "",
      };
    } catch (e) {
      return { values: [], error: e instanceof Error ? e.message : String(e) };
    }
  }, [snapshot.calendar_events, chosen, start, count]);
  const dayFormat = new Intl.DateTimeFormat(i18n.language, {
    weekday: "short",
  });
  const heading = new Intl.DateTimeFormat(i18n.language, {
    year: "numeric",
    month: "long",
  });
  const timeFormat = new Intl.DateTimeFormat(i18n.language, {
    hour: "2-digit",
    minute: "2-digit",
  });
  function navigate(amount: number) {
    const next = new Date(date);
    if (calendarMode === "month") {
      next.setDate(1);
      next.setMonth(next.getMonth() + amount);
    } else next.setDate(next.getDate() + amount * 7);
    set({ date: +next });
  }
  return (
    <div className="calendar-layout">
      <section className="panel calendar-panel">
        <div className="section-heading">
          <h2>{heading.format(date)}</h2>
          <div className="toolbar">
            <button aria-label={t("previous")} onClick={() => navigate(-1)}>
              ←
            </button>
            <button onClick={() => set({ date: Date.now() })}>
              {t("today")}
            </button>
            <button aria-label={t("next")} onClick={() => navigate(1)}>
              →
            </button>
            <div className="segmented">
              {(["month", "week"] as const).map((mode) => (
                <button
                  key={mode}
                  className={calendarMode === mode ? "selected" : ""}
                  onClick={() => set({ calendarMode: mode })}
                >
                  {t(mode)}
                </button>
              ))}
            </div>
            <button
              className="primary"
              onClick={() =>
                set({
                  editor: {
                    table: "calendar_events",
                    defaults: {
                      calendar_id: chosen?.id,
                      start_at: date,
                      end_at: addDays(date, 1),
                    },
                  },
                })
              }
            >
              + {t("newEvent")}
            </button>
          </div>
        </div>
        {events.error && (
          <p role="alert" className="error">
            {t("error")}: {events.error}
          </p>
        )}
        <div className={`calendar-grid ${calendarMode}`}>
          <div className="weekday-head">
            {Array.from({ length: 7 }, (_, i) => (
              <span key={i}>{dayFormat.format(addDays(start, i))}</span>
            ))}
          </div>
          <div className="calendar-days">
            {Array.from({ length: count }, (_, index) => {
              const day = addDays(start, index);
              const next = addDays(day, 1);
              const dayEvents = events.values.filter(
                (e) =>
                  (e.start_at < next && e.end_at > day) ||
                  (e.start_at >= day && e.start_at < next),
              );
              const exceptions = snapshot.calendar_exceptions.filter(
                (e) =>
                  e.calendar_id === chosen?.id && e.date === localDate(day),
              );
              return (
                <div
                  key={day}
                  className={`calendar-day ${new Date(day).getMonth() !== current.getMonth() ? "outside" : ""} ${localDate(day) === localDate(Date.now()) ? "is-today" : ""}`}
                >
                  <button
                    className="date-button"
                    aria-label={`${t("newEvent")} ${new Intl.DateTimeFormat(i18n.language, { dateStyle: "full" }).format(day)}`}
                    onClick={() =>
                      set({
                        editor: {
                          table: "calendar_events",
                          defaults: {
                            calendar_id: chosen?.id,
                            start_at: new Date(day).setHours(9, 0, 0, 0),
                            end_at: new Date(day).setHours(10, 0, 0, 0),
                          },
                        },
                      })
                    }
                  >
                    {new Date(day).getDate()}
                  </button>
                  {exceptions.map((e) => (
                    <button
                      key={e.id}
                      className={`calendar-event ${e.is_working ? "working" : "leave"}`}
                      onClick={() =>
                        set({
                          editor: { table: "calendar_exceptions", value: e },
                        })
                      }
                    >
                      {t(e.kind)} {e.note}
                    </button>
                  ))}
                  {dayEvents.map((event, i) => {
                    const original =
                      snapshot.calendar_events.find((e) => e.id === event.id) ??
                      snapshot.calendar_events.find(
                        (e) =>
                          e.rrule &&
                          e.title === event.title &&
                          e.calendar_id === event.calendar_id,
                      );
                    return (
                      <button
                        key={`${event.id}-${i}`}
                        className={`calendar-event ${event.kind}`}
                        onClick={() =>
                          original &&
                          set({
                            editor: {
                              table: "calendar_events",
                              value: original,
                            },
                          })
                        }
                      >
                        {!event.all_day && (
                          <small>{timeFormat.format(event.start_at)} </small>
                        )}
                        {event.title}
                        {event.rrule ? " ↻" : ""}
                        {event.override ? " ↗" : ""}
                      </button>
                    );
                  })}
                  {snapshot.projects
                    .filter(
                      (p) =>
                        p.calendar_id === chosen?.id &&
                        localDate(p.end_at) === localDate(day),
                    )
                    .map((p) => (
                      <button
                        key={p.id}
                        className="calendar-event project-event"
                        style={{ borderLeftColor: p.color }}
                        onClick={() =>
                          set({ selected: p.id, view: "projects" })
                        }
                      >
                        {p.name} · {t("end")}
                      </button>
                    ))}
                </div>
              );
            })}
          </div>
        </div>
      </section>
      <aside className="panel calendar-sidebar">
        <div className="section-heading">
          <h3>{t("calendars")}</h3>
          <button
            onClick={() => set({ editor: { table: "work_calendars" } })}
            aria-label={t("addCalendar")}
          >
            ＋
          </button>
        </div>
        <label>
          {t("selectCalendar")}
          <select
            value={chosen?.id ?? ""}
            onChange={(e) => setCalendarId(e.target.value)}
          >
            {snapshot.work_calendars.map((c) => (
              <option value={c.id} key={c.id}>
                {c.name}
                {c.is_default ? " ★" : ""}
              </option>
            ))}
          </select>
        </label>
        {chosen && (
          <>
            <EntityActions table="work_calendars" value={chosen} run={run} />
            <div className="section-heading">
              <h3>{t("rules")}</h3>
              <button
                onClick={() =>
                  set({
                    editor: {
                      table: "weekday_rules",
                      defaults: { calendar_id: chosen.id },
                    },
                  })
                }
              >
                ＋
              </button>
            </div>
            {snapshot.weekday_rules
              .filter((r) => r.calendar_id === chosen.id)
              .sort((a, b) => a.weekday - b.weekday)
              .map((rule) => (
                <div key={rule.id} className="rule-row">
                  <div>
                    <strong>
                      {dayFormat.format(new Date(2024, 0, 7 + rule.weekday))}
                    </strong>
                    <small>
                      {rule.is_working
                        ? rule.segments
                            .map((s) => `${s.start}–${s.end}`)
                            .join(" / ")
                        : t("holiday")}
                    </small>
                  </div>
                  <EntityActions table="weekday_rules" value={rule} run={run} />
                </div>
              ))}
            <div className="section-heading">
              <h3>{t("exceptions")}</h3>
              <button
                onClick={() =>
                  set({
                    editor: {
                      table: "calendar_exceptions",
                      defaults: { calendar_id: chosen.id },
                    },
                  })
                }
              >
                ＋
              </button>
            </div>
            {snapshot.calendar_exceptions
              .filter((e) => e.calendar_id === chosen.id)
              .sort((a, b) => a.date.localeCompare(b.date))
              .map((exception) => (
                <div key={exception.id} className="rule-row">
                  <div>
                    <strong>{exception.date}</strong>
                    <small>
                      {t(exception.kind)} · {exception.note}
                    </small>
                  </div>
                  <EntityActions
                    table="calendar_exceptions"
                    value={exception}
                    run={run}
                  />
                </div>
              ))}
            <div className="section-heading">
              <h3>{t("events")}</h3>
            </div>
            {snapshot.calendar_events
              .filter((e) => e.calendar_id === chosen.id)
              .map((event) => (
                <div key={event.id} className="rule-row">
                  <div>
                    <strong>{event.title}</strong>
                    <small>
                      {event.rrule ?? t("once")}
                      {event.override ? ` · ${t(event.override.mode)}` : ""}
                    </small>
                  </div>
                  <EntityActions
                    table="calendar_events"
                    value={event}
                    run={run}
                  />
                </div>
              ))}
          </>
        )}
      </aside>
    </div>
  );
}
