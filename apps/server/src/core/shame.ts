/**
 * Wall of shame: per person and office-local day, how many `/clear` restarts, the longest an
 * agent waited for its human, and how often an agent caught fire (context >= 80%). Fed with
 * the hub's viewer events; one small kv row per day. Pure apart from the store.
 */

import type { ViewerEvent } from "@agent-office/protocol";
import type { OfficeState } from "./diff.ts";
import type { Store } from "./store.ts";

export const CLEAR_WINDOW_MS = 10_000;
export const FIRE_AT = 0.8;

export type ShameDay = {
  day: string;
  clears: Record<string, number>;
  longestWaitMs: Record<string, number>;
  fires: Record<string, number>;
};

const empty = (day: string): ShameDay => ({ day, clears: {}, longestWaitMs: {}, fires: {} });
const bump = (m: Record<string, number>, k: string, by = 1) => {
  m[k] = (m[k] ?? 0) + by;
};

export class ShameTracker {
  private today: ShameDay;
  /** sessionId -> when it started waiting */
  private waiting = new Map<string, { person: string; since: number }>();
  /** person -> last session.ended */
  private lastEnd = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly dayOf: (ts: number) => string,
  ) {
    this.today = empty("");
  }

  private day(now: number): ShameDay {
    const d = this.dayOf(now);
    if (this.today.day === d) return this.today;
    try {
      const raw = this.store.kvGet(`shame.${d}`);
      this.today = raw ? (JSON.parse(raw) as ShameDay) : empty(d);
    } catch {
      this.today = empty(d);
    }
    return this.today;
  }

  private wait(sessionId: string, person: string, now: number) {
    const w = this.waiting.get(sessionId);
    if (!w) return;
    this.waiting.delete(sessionId);
    const t = this.day(now);
    t.longestWaitMs[person] = Math.max(t.longestWaitMs[person] ?? 0, now - w.since);
  }

  /** Feed one commit's events. `prev` is the state before them (for contexts). */
  record(events: readonly ViewerEvent[], prev: OfficeState, now: number): void {
    let dirty = false;
    const before = new Map<string, number | undefined>();
    for (const p of prev.people) for (const s of p.sessions) before.set(s.sessionId, s.context);
    for (const e of events) {
      switch (e.type) {
        case "session.started": {
          const person = e.data.personId;
          const ended = this.lastEnd.get(person);
          if (ended !== undefined && now - ended <= CLEAR_WINDOW_MS) {
            bump(this.day(now).clears, person);
            this.lastEnd.delete(person);
            dirty = true;
          }
          if (e.data.session.activity === "waiting")
            this.waiting.set(e.data.session.sessionId, { person, since: now });
          break;
        }
        case "session.ended":
          this.lastEnd.set(e.data.personId, now);
          this.wait(e.data.sessionId, e.data.personId, now);
          dirty = true;
          break;
        case "session.activityChanged":
          if (e.data.activity === "waiting")
            this.waiting.set(e.data.sessionId, { person: e.data.personId, since: now });
          else if (e.data.previous === "waiting") {
            this.wait(e.data.sessionId, e.data.personId, now);
            dirty = true;
          }
          break;
        case "session.contextChanged": {
          const was = before.get(e.data.sessionId) ?? 0;
          if (was < FIRE_AT && (e.data.context ?? 0) >= FIRE_AT) {
            bump(this.day(now).fires, e.data.personId);
            dirty = true;
          }
          break;
        }
      }
    }
    if (dirty) this.store.kvPut(`shame.${this.today.day}`, JSON.stringify(this.today));
  }

  /** Today's numbers, with waits still running counted up to `now`. */
  snapshot(now: number): ShameDay {
    const t = this.day(now);
    const out: ShameDay = {
      day: t.day,
      clears: { ...t.clears },
      longestWaitMs: { ...t.longestWaitMs },
      fires: { ...t.fires },
    };
    for (const w of this.waiting.values())
      out.longestWaitMs[w.person] = Math.max(out.longestWaitMs[w.person] ?? 0, now - w.since);
    return out;
  }
}
