/** Authoritative, persisted turn machine. A single KV envelope atomically commits results/budget. */
import {
  ARENA_RULES,
  type ArenaAction,
  ArenaMatch,
  ArenaMutation,
  ArenaStanding,
  type ArenaState,
  type PersonView,
} from "@agent-office/protocol";
import { z } from "zod";
import type { FetchLike } from "../genui.ts";
import { ArenaBudget, type ArenaStore, emptyBudget } from "./budget.ts";
import { prepare, resolveTurn } from "./engine.ts";
import {
  type ArenaEnv,
  chooseAction,
  createDecisionProvider,
  type DecisionProvider,
} from "./provider.ts";

const KEY = "arena.v1";
const Strings = z.record(z.string().max(64), z.string().max(1600));
const Journal = z
  .array(z.object({ turn: z.number().int(), actions: z.record(z.string(), z.unknown()) }))
  .max(40);
const Stored = z.object({
  match: ArenaMatch.nullable(),
  prompts: Strings,
  recent: z
    .array(z.object({ match: ArenaMatch, prompts: Strings, journal: Journal.default([]) }))
    .max(20),
  leaderboard: z.array(ArenaStanding).max(1000),
  budget: z.object({
    day: z.string(),
    calls: z.number().int().nonnegative(),
    reservations: z.record(z.string(), z.number().int().nonnegative()),
  }),
  job: z.string().nullable(),
  failures: z.number().int().nonnegative(),
  journal: Journal,
});
type Data = z.infer<typeof Stored>;
export class ArenaService {
  readonly enabled: boolean;
  readonly provider: DecisionProvider | null;
  readonly budget: ArenaBudget;
  private data: Data;
  private storageError = false;
  private readonly now: () => number;
  constructor(
    env: ArenaEnv,
    private store: ArenaStore,
    private hooks: {
      publish: (state: ArenaState) => void;
      schedule: (at: number) => void;
      background: (p: Promise<unknown>) => void;
      now?: () => number;
      fetch?: FetchLike;
      provider?: DecisionProvider;
    },
  ) {
    this.enabled = env.ARENA_ENABLED === "1";
    this.provider = hooks.provider ?? createDecisionProvider(env, hooks.fetch);
    this.budget = new ArenaBudget(env);
    this.now = hooks.now ?? Date.now;
    const empty: Data = {
      match: null,
      prompts: {},
      recent: [],
      leaderboard: [],
      budget: emptyBudget(),
      job: null,
      failures: 0,
      journal: [],
    };
    try {
      const raw = store.kvGet(KEY);
      const parsed = Stored.safeParse(JSON.parse(raw ?? "null"));
      this.data = parsed.success ? parsed.data : empty;
      this.storageError = raw !== null && !parsed.success;
    } catch {
      this.data = empty;
      this.storageError = true;
    }
  }
  state(): ArenaState {
    return structuredClone({
      enabled: this.enabled,
      available: this.enabled && !!this.provider && !this.storageError,
      model: this.provider?.model ?? "not configured",
      match: this.enabled ? this.data.match : null,
      leaderboard: this.enabled ? this.data.leaderboard : [],
      recent: this.enabled ? this.data.recent.map((r) => r.match) : [],
    });
  }
  ownPrompt(personId: string): string | null {
    return Object.hasOwn(this.data.prompts, personId) ? this.data.prompts[personId]! : null;
  }
  deadline(): number | null {
    return this.enabled ? (this.data.match?.deadline ?? null) : null;
  }
  private commit(): void {
    this.store.kvPut(KEY, JSON.stringify(this.data));
    this.hooks.publish(this.state());
    const at = this.deadline();
    if (at !== null) this.hooks.schedule(at);
  }
  private lobby(hostId: string): void {
    const previous = this.data.match;
    if (previous) {
      this.data.recent.unshift({
        match: previous,
        prompts: this.data.prompts,
        journal: this.data.journal,
      });
      this.data.recent = this.data.recent.slice(0, 20);
    }
    this.data.match = {
      id: crypto.randomUUID(),
      hostId,
      seed: crypto.getRandomValues(new Uint32Array(1))[0]!,
      phase: "lobby",
      turn: 0,
      fighters: [],
      pickups: [],
      obstacles: [],
      events: [],
      winners: [],
      deadline: null,
      startedAt: null,
      endedAt: null,
      revealedPrompts: {},
    };
    this.data.prompts = {};
    this.data.job = null;
    this.data.failures = 0;
    this.data.journal = [];
  }
  mutate(
    input: unknown,
    personId: string,
    person: PersonView | undefined,
  ): { status: number; body: unknown } {
    const fail = (status: number, error: string) => ({ status, body: { error } });
    if (!this.enabled) return fail(404, "Arena is disabled");
    if (this.storageError)
      return fail(503, "Arena storage needs operator recovery; spending is disabled");
    const parsed = ArenaMutation.safeParse(input);
    if (!parsed.success) return fail(400, "Invalid arena action");
    const a = parsed.data;
    let m = this.data.match;
    if (a.kind === "reveal") {
      const entry =
        m?.id === a.matchId
          ? { match: m, prompts: this.data.prompts }
          : this.data.recent.find((r) => r.match.id === a.matchId);
      if (!entry || !["finished", "aborted"].includes(entry.match.phase))
        return fail(409, "That match is not finished");
      if (!Object.hasOwn(entry.prompts, personId))
        return fail(403, "Only a participant can reveal their own tactics");
      entry.match.revealedPrompts[personId] = entry.prompts[personId]!;
      this.commit();
      return { status: 200, body: this.state() };
    }
    if (!person) return fail(409, "Connect your coding agent to enter the arena");
    if (a.kind === "rematch") {
      if (!m || !["finished", "aborted"].includes(m.phase))
        return fail(409, "Finish the current match first");
      if (!m.fighters.some((f) => f.personId === personId))
        return fail(403, "Only participants can open a rematch");
      this.lobby(personId);
      this.commit();
      return { status: 200, body: this.state() };
    }
    if (a.kind === "join" && !m) {
      this.lobby(personId);
      m = this.data.match;
    }
    if (!m) return fail(409, "Join the arena first");
    if (a.kind === "cancel") {
      if (m.hostId !== personId) return fail(403, "Only the host can cancel");
      if (m.phase !== "lobby" && m.phase !== "countdown")
        return fail(409, "Started matches cannot be cancelled");
      this.finish("aborted", "Cancelled by host");
      return { status: 200, body: this.state() };
    }
    if (m.phase !== "lobby")
      return fail(409, "Tactics and participants are locked until the next lobby");
    const fighter = m.fighters.find((f) => f.personId === personId);
    if (a.kind === "join") {
      if (!fighter && m.fighters.length >= 8) return fail(409, "Arena is full (8 fighters)");
      if (fighter) {
        fighter.loadout = a.loadout;
        fighter.ready = false;
      } else
        m.fighters.push({
          personId,
          name: person.name,
          avatar: person.avatar,
          loadout: a.loadout,
          ready: false,
          x: 0,
          y: 0,
          hp: 100,
          shield: 0,
          boost: 0,
          cooldown: 0,
          knockouts: 0,
          eliminatedTurn: null,
        });
      this.data.prompts[personId] = a.prompt;
    } else if (a.kind === "leave") {
      if (!fighter) return fail(409, "You have not joined");
      m.fighters = m.fighters.filter((f) => f.personId !== personId);
      delete this.data.prompts[personId];
      if (m.hostId === personId) m.hostId = m.fighters[0]?.personId ?? personId;
      if (m.fighters.length === 0) this.data.match = null;
    } else if (a.kind === "ready") {
      if (!fighter) return fail(403, "Join before readying");
      fighter.ready = a.ready;
    } else if (a.kind === "start") {
      if (m.hostId !== personId || !fighter) return fail(403, "Only the host can start");
      if (m.fighters.length < 2 || !m.fighters.every((f) => f.ready))
        return fail(409, "Need 2–8 ready fighters");
      if (!this.provider) return fail(503, "Arena model is not configured");
      const newcomers = m.fighters.filter(
        (f) => !this.data.leaderboard.some((r) => r.personId === f.personId),
      );
      if (this.data.leaderboard.length + newcomers.length > 1000)
        return fail(409, "Arena leaderboard is full");
      const reserved = this.budget.reserve(this.data.budget, m.id, m.fighters.length, this.now());
      if (!reserved) return fail(429, "Arena match or daily inference budget exhausted");
      this.data.budget = reserved;
      this.data.match = prepare(m);
      m = this.data.match;
      m.phase = "countdown";
      m.startedAt = this.now();
      m.deadline = this.now() + ARENA_RULES.countdownMs;
    }
    this.commit();
    return { status: 200, body: this.state() };
  }
  /** Called by alarms AND restore. Never reruns a persisted paid decision job. */
  tick(): void {
    if (!this.enabled || this.storageError) return;
    const m = this.data.match;
    if (!m || m.deadline === null) return;
    if (m.deadline > this.now()) {
      this.hooks.schedule(m.deadline);
      return;
    }
    if (m.phase === "deciding") {
      // A crashed/stalled job uses defense. Its callbacks are invalidated by settle().
      this.settle(m.id, this.data.job, {});
      return;
    }
    if (m.phase !== "countdown" && m.phase !== "resolving") return;
    if (!this.provider) {
      this.finish("aborted", "Arena model unavailable");
      return;
    }
    m.phase = "deciding";
    m.deadline = this.now() + ARENA_RULES.decisionMs + 250;
    const job = crypto.randomUUID();
    this.data.job = job;
    const id = m.id;
    const snapshot = structuredClone(m);
    const provider = this.provider;
    this.commit();
    const p = Promise.all(
      snapshot.fighters
        .filter((f) => f.hp > 0)
        .map(
          async (f) =>
            [
              f.personId,
              await chooseAction(
                provider,
                snapshot,
                f.personId,
                this.data.prompts[f.personId] ?? "",
              ),
            ] as const,
        ),
    )
      .then((entries) => this.settle(id, job, Object.fromEntries(entries)))
      .catch(() => this.settle(id, job, {}));
    this.hooks.background(p);
  }
  private settle(
    id: string,
    job: string | null,
    actions: Record<string, ArenaAction | null>,
  ): void {
    const m = this.data.match;
    if (!m || m.id !== id || m.phase !== "deciding" || this.data.job !== job) return;
    // Validate the persisted lease too: a recovered instance may have completed this job.
    const persisted = JSON.parse(this.store.kvGet(KEY) ?? "null") as Data | null;
    if (
      persisted?.job !== job ||
      persisted?.match?.id !== id ||
      persisted.match.phase !== "deciding"
    )
      return;
    this.data.job = null;
    const valid = Object.values(actions).some(Boolean);
    this.data.failures = valid ? 0 : this.data.failures + 1;
    if (this.data.failures >= 3) {
      this.finish("aborted", "Model unavailable for three consecutive turns");
      return;
    }
    this.data.journal.push({ turn: m.turn + 1, actions });
    this.data.match = resolveTurn(m, actions);
    if (this.data.match.phase === "finished") {
      this.finish("finished");
      return;
    }
    this.data.match.deadline = this.now() + ARENA_RULES.animationMs;
    this.commit();
  }
  private finish(phase: "finished" | "aborted", reason?: string): void {
    const m = this.data.match;
    if (!m) return;
    m.phase = phase;
    m.deadline = null;
    m.endedAt = this.now();
    if (reason) m.reason = reason;
    this.data.job = null;
    if (phase === "finished")
      for (const f of m.fighters) {
        let row = this.data.leaderboard.find((r) => r.personId === f.personId);
        if (!row) {
          row = { personId: f.personId, name: f.name, wins: 0, knockouts: 0, matches: 0 };
          this.data.leaderboard.push(row);
        }
        row.name = f.name;
        row.matches++;
        row.knockouts += f.knockouts;
        if (m.winners.includes(f.personId)) row.wins++;
      }
    this.data.leaderboard.sort(
      (a, b) =>
        b.wins - a.wins || b.knockouts - a.knockouts || a.personId.localeCompare(b.personId),
    );
    this.commit();
  }
}
