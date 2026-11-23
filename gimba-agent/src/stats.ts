import type { Result } from "./agent";
import { costUsd } from "./log";

// ---------------------------------------------------------------------------
// Unit 9 weekly numbers. Every turn (web and LINE) adds to this week's counters in KV;
// the Monday cron pushes last week's summary to the owner's LINE.
// KV read-modify-write is not atomic: two turns in the same second can lose one count.
// Fine at a cattery's volume; the Google Sheet stays the full record.
// ---------------------------------------------------------------------------

export interface WeekStats {
  week: string; // Monday of the week, Taiwan date (YYYY-MM-DD)
  sessions: number; // new conversations
  channels: Record<string, number>; // new conversations per channel
  turns: number;
  recommends: number; // conversations that reached a recommendation
  leads: number;
  breeds: Record<string, number>; // what people asked for when they got a recommendation
  guard: Record<string, number>; // pass / rewritten / fallback / blocked
  cost: number; // USD
}

const TW = 8 * 3600_000;
const DAY = 24 * 3600_000;

/** Monday of the week containing `d`, as a Taiwan calendar date. */
export function weekKey(d = new Date()): string {
  const t = new Date(d.getTime() + TW);
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
}
export function lastWeekKey(d = new Date()): string {
  return weekKey(new Date(d.getTime() - 7 * DAY));
}

function empty(week: string): WeekStats {
  return { week, sessions: 0, channels: {}, turns: 0, recommends: 0, leads: 0, breeds: {}, guard: {}, cost: 0 };
}

export async function readWeek(kv: KVNamespace, week: string): Promise<WeekStats> {
  return { ...empty(week), ...((await kv.get<WeekStats>(`stats:${week}`, "json")) ?? {}) };
}

function bump(m: Record<string, number>, k: string) {
  if (k) m[k] = (m[k] ?? 0) + 1;
}

export async function recordTurn(kv: KVNamespace, channel: string, r: Result, now = new Date()) {
  const s = await readWeek(kv, weekKey(now));
  s.turns++;
  if (r.state.turn === 1) {
    s.sessions++;
    bump(s.channels, channel);
  }
  if (r.path === "recommend") {
    s.recommends++;
    bump(s.breeds, r.state.slots.breed.slice(0, 12));
  }
  if (r.path === "lead_saved") s.leads++;
  if (r.path === "blocked_input") bump(s.guard, "blocked");
  else if (r.guard) bump(s.guard, r.guard.action);
  s.cost += costUsd(r);
  await kv.put(`stats:${s.week}`, JSON.stringify(s), { expirationTtl: 180 * 24 * 3600 });
}

const CHANNEL_NAME: Record<string, string> = { web: "網頁", line: "LINE" };
const WEEKDAY = "日一二三四五六";
function md(iso: string, plusDays = 0): string {
  const d = new Date(Date.parse(iso) + plusDays * DAY);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEKDAY[d.getUTCDay()]}）`;
}
function top(m: Record<string, number>, n: number): string {
  return Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${v}`)
    .join("、");
}

/** The text pushed to the owner. Plain text: LINE does not render Markdown. */
export function formatReport(s: WeekStats, title: string): string {
  const lines = [title, `${md(s.week)} 到 ${md(s.week, 6)}`, ""];
  if (s.sessions === 0 && s.turns === 0) {
    lines.push("這段期間沒有新的對話。");
    return lines.join("\n");
  }
  const ch = Object.entries(s.channels).map(([k, v]) => `${CHANNEL_NAME[k] ?? k} ${v}`).join("、");
  lines.push(`新對話 ${s.sessions} 段${ch ? `（${ch}）` : ""}，共 ${s.turns} 則訊息`);
  const rate = s.sessions ? `，是新對話的 ${Math.round((s.leads / s.sessions) * 100)}%` : "";
  lines.push(`問到推薦 ${s.recommends} 段，留下聯絡方式 ${s.leads} 位${rate}`);
  if (Object.keys(s.breeds).length) lines.push(`推薦時客人想要的：${top(s.breeds, 3)}`);
  const g = s.guard;
  lines.push("");
  lines.push(`回覆檢查：通過 ${g.pass ?? 0}、改寫 ${g.rewritten ?? 0}、換成安全句 ${g.fallback ?? 0}、擋下可疑訊息 ${g.blocked ?? 0}`);
  // a quiet week costs fractions of a cent: show enough digits that it does not read as 0
  lines.push(`模型費用：${s.cost.toFixed(s.cost < 0.01 ? 4 : 3)} 美元（約台幣 ${(s.cost * 32).toFixed(s.cost * 32 < 0.1 ? 2 : 1)} 元）`);
  lines.push("");
  lines.push("每位客人的對話和名單在紀錄試算表。");
  return lines.join("\n");
}
