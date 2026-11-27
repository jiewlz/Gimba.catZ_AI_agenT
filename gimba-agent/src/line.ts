import Anthropic from "@anthropic-ai/sdk";
import { handleMessage, INTRO, newState, type Result, type State } from "./agent";
import { costUsd, logTurn } from "./log";
import { addDayCost, formatReport, lastWeekKey, readWeek, recordTurn, weekKey } from "./stats";
import type { Env } from "./index";

// ---------------------------------------------------------------------------
// Unit 9: LINE Official Account entry. Same brain as the web chat (handleMessage);
// only the way messages come in and go out is different.
//   - LINE signs every webhook with the channel secret: unsigned requests are dropped
//   - LINE has no browser to keep the memory, so it lives in KV per LINE user
//   - the reply is sent after we answer LINE with 200 (the guardrail can take ~10 s)
// ---------------------------------------------------------------------------

const API = "https://api.line.me/v2/bot";
const STATE_TTL = 30 * 24 * 3600; // a conversation is forgotten after 30 quiet days
const MAX_MESSAGE_CHARS = 500;
const MAX_TURNS = 30;

const NOT_TEXT = "我目前只看得懂文字訊息喔。想養貓的話，跟我說說您喜歡的品種、預算和家裡的狀況吧！";
const TOO_LONG = "訊息有點長，可以分成幾句短一點的再傳一次嗎？";
const AT_LIMIT = "我們聊了很多了，接下來我請貓舍老闆直接跟您聊，老闆看到會盡快回覆您。";
const BUSY = "系統暫時出了點問題，請過一下再傳一次，或等貓舍老闆直接回覆您。";
const RESET_DONE = "好的，剛剛聊的內容我都清掉了，我們重新開始。想養貓的話，跟我說說您喜歡的品種、預算和家裡的狀況吧！";
// LINE has no "start over" button like the web chat: a short message asking to start over or forget wipes the memory
const RESET = /重新開始|重來|從頭開始|從頭來|重新來過|清除|清掉|刪除|忘記我|忘掉/;
const RESET_MAX_CHARS = 16; // only a short message is a request to start over, not a sentence that happens to contain the word
const OWNER_HELP = "老闆您好！可以傳這些指令：\n「本週」看這週到目前的數字\n「上週」看上週週報\n「接手 名字」顧問對這位客人安靜 3 天，讓您自己回（客人留下聯絡方式時會自動安靜 3 天）\n「交回 名字」顧問恢復回覆\n「成交 名字」把這位客人標成已購買，之後顧問用老客人的口吻、不再推銷\n名字打客人的 LINE 名稱就好，打一部分也可以；只傳「接手」「交回」「成交」會列出最近的客人，點按鈕就好。也可以用新名單通知裡的代碼（line- 開頭）。\n其他訊息會當成一般客人回答，可以拿來測試。";
const QUIET_TTL = 3 * 24 * 3600; // 接手: the advisor stays out of this chat for 3 days
const SESSION_TTL = 180 * 24 * 3600;
const OWNER_CMD = /^(成交|接手|交回)\s*(line-[0-9a-f]{10})$/i;
const OWNER_NAME_CMD = /^(成交|接手|交回)(?:[\s　]+(.+))?$/;
const PROFILE_REFRESH_MS = 7 * 24 * 3600_000; // customers can rename themselves: ask LINE again after a week
const RECENT_KEY = "recent:line";
const RECENT_MAX = 20;
const PICK_MAX = 5;
// "ok / thanks / hard work / 👌": closes a chat, it is not a question
const ACK =
  /^(?:好的|好喔|好哦|好唷|好呀|好啊|好滴|好|okay|okok|ok|收到|了解|瞭解|知道了|謝謝你|謝謝您|謝謝|謝啦|感謝|感恩|辛苦你了|辛苦您了|辛苦了|沒問題|沒事|不會的|不會|嗯嗯|恩恩|嗯|恩|哈+|笑死|[\s!！~～。.,，]|\p{Extended_Pictographic}|\p{Emoji_Modifier}|️|‍)+$/iu;
const ACK_MAX_CHARS = 12;
const SETTLE_MS = 2500; // how long to wait for the next message of a quick burst
type Verb = "接手" | "交回" | "成交";
const ACTION: Record<Verb, string> = { 接手: "takeover", 交回: "handback", 成交: "deal" };
const VERB_OF: Record<string, Verb> = { takeover: "接手", handback: "交回", deal: "成交" };

// When no access token is set (local dev), outgoing messages are kept here instead of sent to LINE.
export const OUTBOX: { kind: "reply" | "push" | "loading"; to: string; text: string; buttons?: QuickButton[] }[] = [];
// Local tests only: fake LINE profiles (userId -> displayName; "!fail" = the profile API errors)
export const DEV_PROFILES = new Map<string, string>();

interface QuickButton {
  label: string;
  data: string;
  displayText: string;
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** X-Line-Signature is base64(HMAC-SHA256(channel secret, raw body)). */
export async function verifyLineSignature(secret: string, body: string, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function lineApi(env: Env, path: string, payload: unknown): Promise<void> {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return;
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error("LINE API", path, res.status, await res.text());
}

async function reply(env: Env, replyToken: string, to: string, text: string, buttons: QuickButton[] = []) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    OUTBOX.push({ kind: "reply", to, text, ...(buttons.length ? { buttons } : {}) });
    return;
  }
  const message: Record<string, unknown> = { type: "text", text };
  if (buttons.length) {
    message.quickReply = {
      items: buttons.map((b) => ({ type: "action", action: { type: "postback", label: b.label, data: b.data, displayText: b.displayText } })),
    };
  }
  await lineApi(env, "/message/reply", { replyToken, messages: [message] });
}

/** Push a message to the cattery owner (new leads, weekly report). */
export async function notifyOwner(env: Env, text: string) {
  if (!env.LINE_OWNER_ID) {
    console.log("[owner]", text);
    return;
  }
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    OUTBOX.push({ kind: "push", to: "owner", text });
    return;
  }
  await lineApi(env, "/message/push", { to: env.LINE_OWNER_ID, messages: [{ type: "text", text }] });
}

/** LINE Get Profile. Throws when LINE says no (blocked, API down): callers carry on without a name. */
async function fetchDisplayName(env: Env, userId: string): Promise<string> {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    const fake = DEV_PROFILES.get(userId) ?? "";
    if (fake === "!fail") throw new Error("profile API failed (local test)");
    return fake;
  }
  const res = await fetch(`${API}/profile/${userId}`, { headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` } });
  if (!res.ok) throw new Error(`profile ${res.status}`);
  return ((await res.json()) as { displayName?: string }).displayName ?? "";
}

interface Profile {
  name: string;
  at: number;
}

/** The customer's LINE name, kept next to the conversation (same 30-day expiry) and asked again after 7 days. Never throws. */
async function lineName(env: Env, userId: string): Promise<string> {
  const key = `prof:${userId}`;
  const now = Date.now();
  let prof: Profile | null = null;
  try {
    prof = await env.KV.get<Profile>(key, "json");
  } catch {}
  if (!prof || now - prof.at > PROFILE_REFRESH_MS) {
    try {
      prof = { name: (await fetchDisplayName(env, userId)).trim(), at: now };
    } catch (error) {
      console.error("LINE profile", error);
      // keep the old name if there was one, and try again in a day instead of a week
      prof = { name: prof?.name ?? "", at: now - PROFILE_REFRESH_MS + 24 * 3600_000 };
    }
  }
  try {
    await env.KV.put(key, JSON.stringify(prof), { expirationTtl: STATE_TTL });
  } catch {}
  return prof.name;
}

// --- recent customers: what the owner picks from when taking a chat over ---------------------

interface Recent {
  code: string;
  name: string;
  last: string;
  at: number;
}

async function readRecent(env: Env): Promise<Recent[]> {
  const list = (await env.KV.get<Recent[]>(RECENT_KEY, "json")) ?? [];
  const cutoff = Date.now() - STATE_TTL * 1000; // the name is forgotten after 30 quiet days, so is the entry
  return list.filter((r) => r.at > cutoff);
}

async function touchRecent(env: Env, entry: Recent) {
  const list = (await readRecent(env)).filter((r) => r.code !== entry.code);
  list.unshift(entry);
  await env.KV.put(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
}

async function dropRecent(env: Env, code: string) {
  const list = await readRecent(env);
  const rest = list.filter((r) => r.code !== code);
  if (rest.length !== list.length) await env.KV.put(RECENT_KEY, JSON.stringify(rest));
}

/** Records who just wrote: the code -> userId lookup, the LINE name and the recent list. Never breaks the turn. */
async function noteCustomer(env: Env, userId: string, session: string, last: string) {
  try {
    await env.KV.put(`sess:${session}`, userId, { expirationTtl: SESSION_TTL });
    const name = await lineName(env, userId);
    await touchRecent(env, { code: session, name, last: [...last].slice(0, 20).join(""), at: Date.now() });
  } catch (error) {
    console.error("recent list", error);
  }
}

/** null = the advisor is answering; otherwise until when it stays quiet (ms; 0 = unknown, set by an older version). */
async function quietUntil(env: Env, userId: string): Promise<number | null> {
  const v = await env.KV.get(`quiet:${userId}`);
  if (!v) return null;
  const n = Number(v);
  return n > 1e12 ? n : 0;
}

async function setQuiet(env: Env, userId: string): Promise<number> {
  const until = Date.now() + QUIET_TTL * 1000;
  await env.KV.put(`quiet:${userId}`, String(until), { expirationTtl: QUIET_TTL });
  return until;
}

/** Same normalisation on both sides: full-width -> half-width (NFKC), trimmed, lower case. */
function norm(s: string): string {
  return s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Short, stable id for the sheet: the raw LINE user id stays out of the log. */
async function sessionOf(userId: string): Promise<string> {
  return "line-" + hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId))).slice(0, 10);
}

function twTime(d = new Date()): string {
  return `${twDate(d)} ${twClock(d)}`;
}

function twDate(d: Date): string {
  const t = new Date(d.getTime() + 8 * 3600_000);
  return `${t.getUTCMonth() + 1}/${t.getUTCDate()}`;
}

function twClock(d: Date): string {
  const t = new Date(d.getTime() + 8 * 3600_000);
  return `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`;
}

/** "10:05" today, "11/26 10:05" before today (Taiwan time). */
function twWhen(ms: number): string {
  const d = new Date(ms);
  return twDate(d) === twDate(new Date()) ? twClock(d) : twTime(d);
}

/** The push the owner gets when someone leaves their contact, from any channel. */
export function leadText(channel: string, r: Result, lineName = "", code = ""): string {
  const s = r.state.slots;
  const want = [s.breed, s.color, s.budget && `預算 ${s.budget}`, s.home, s.experience].filter(Boolean).join("／");
  const who = lineName || code; // what the owner types for 交回 / 成交
  return [
    code ? `新名單（${channel}）：${lineName ? `${lineName}（${code}）` : code}` : `新名單（${channel}）`,
    `時間：${twTime()}`,
    `稱呼：${s.name || "沒留"}`,
    `聯絡方式：${s.contact}`,
    `需求：${want || "還沒問到"}`,
    "",
    channel === "LINE"
      ? `請直接在 LINE 官方帳號的聊天裡回覆這位客人，顧問接下來 3 天不會插話。想讓顧問繼續陪客人聊，傳「交回 ${who}」；成交後傳「成交 ${who}」。`
      : "完整對話在紀錄試算表。",
  ].join("\n");
}

interface LineEvent {
  type: string;
  replyToken?: string;
  webhookEventId?: string;
  source?: { type: string; userId?: string };
  message?: { type: string; text?: string };
  postback?: { data?: string };
}

async function handleEvent(env: Env, ev: LineEvent) {
  const userId = ev.source?.userId;
  if (!userId || ev.source?.type !== "user" || !ev.replyToken) return; // groups and rooms are ignored
  // LINE may deliver the same event twice (redelivery): handle each one once
  if (ev.webhookEventId) {
    const seen = `seen:${ev.webhookEventId}`;
    if (await env.KV.get(seen)) return;
    await env.KV.put(seen, "1", { expirationTtl: 3600 });
  }
  const isOwner = !!env.LINE_OWNER_ID && userId === env.LINE_OWNER_ID;

  // A tapped owner button. The buttons are only ever shown to the owner, but check the sender anyway.
  if (ev.type === "postback") {
    if (!isOwner) return;
    const data = new URLSearchParams(ev.postback?.data ?? "");
    const verb = VERB_OF[data.get("action") ?? ""];
    const code = (data.get("code") ?? "").toLowerCase();
    if (!verb || !/^line-[0-9a-f]{10}$/.test(code)) return;
    return reply(env, ev.replyToken, userId, await ownerCommand(env, verb, code));
  }

  if (ev.type === "follow") {
    if (!isOwner) await noteCustomer(env, userId, await sessionOf(userId), "（加了好友）");
    await env.KV.put(`intro:${userId}`, "1", { expirationTtl: STATE_TTL });
    return reply(env, ev.replyToken, userId, INTRO);
  }
  if (ev.type !== "message") return;
  if (ev.message?.type !== "text") return reply(env, ev.replyToken, userId, NOT_TEXT);
  const text = (ev.message.text ?? "").trim();
  if (!text) return;

  // The owner can ask for the numbers at any time; everything else they send is treated like a customer
  if (isOwner) {
    if (/^(本週|這週|本周|這周)/.test(text)) return reply(env, ev.replyToken, userId, formatReport(await readWeek(env.KV, weekKey()), "本週到目前的數字"));
    if (/^(上週|上周|週報|周報)/.test(text)) return reply(env, ev.replyToken, userId, formatReport(await readWeek(env.KV, lastWeekKey()), "金霸貓舍 AI 顧問週報"));
    if (/^(老闆|說明|help|指令)$/i.test(text)) return reply(env, ev.replyToken, userId, OWNER_HELP);
    const byCode = text.match(OWNER_CMD);
    if (byCode) return reply(env, ev.replyToken, userId, await ownerCommand(env, byCode[1] as Verb, byCode[2].toLowerCase()));
    const byName = text.match(OWNER_NAME_CMD);
    if (byName) {
      const out = await ownerByName(env, byName[1] as Verb, byName[2] ?? "");
      return reply(env, ev.replyToken, userId, out.text, out.buttons);
    }
  }

  const key = `line:${userId}`;
  const session = await sessionOf(userId);
  const quiet = (await quietUntil(env, userId)) !== null;

  // "start over / forget me": wipe the memory, the LINE name and the recent-list entry. Done even while the
  // owner has the chat (it is a data request), but then without a reply that would talk over the owner.
  if (text.length <= RESET_MAX_CHARS && RESET.test(text)) {
    await Promise.allSettled([env.KV.delete(key), env.KV.delete(`prof:${userId}`), env.KV.delete(`intro:${userId}`), dropRecent(env, session)]);
    if (!quiet) return reply(env, ev.replyToken, userId, RESET_DONE);
    return;
  }

  if (!isOwner) await noteCustomer(env, userId, session, text);

  // The owner took this chat over (接手): stay quiet, the owner answers in the LINE OA chat
  if (quiet) return;

  if (text.length > MAX_MESSAGE_CHARS) return reply(env, ev.replyToken, userId, TOO_LONG);
  // A short "ok / thanks / 👌" outside an interview closes a chat (usually with the owner): nothing to answer
  if ([...text].length <= ACK_MAX_CHARS && ACK.test(text)) {
    const st = await env.KV.get<State>(key, "json");
    if (!st || st.stage === "idle") return;
  }
  // Several quick messages in a row get one answer: only the last one waits through and answers them all
  const merged = await settle(env, userId, ev.webhookEventId ?? crypto.randomUUID(), text);
  if (merged === null) return;

  const state: State = (await env.KV.get<State>(key, "json")) ?? newState();
  if (await env.KV.get(`member:${userId}`)) state.member = true;
  if (state.turn >= MAX_TURNS) return reply(env, ev.replyToken, userId, AT_LIMIT);

  // "typing" dots while the model and the guardrail work (one-on-one chats only)
  if (env.LINE_CHANNEL_ACCESS_TOKEN) await lineApi(env, "/chat/loading/start", { chatId: userId, loadingSeconds: 20 });
  else OUTBOX.push({ kind: "loading", to: userId, text: "" });

  let result: Result;
  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    result = await handleMessage(client, env.MODEL, state, merged);
  } catch (error) {
    console.error("LINE turn failed", error);
    return reply(env, ev.replyToken, userId, BUSY);
  }
  await env.KV.put(key, JSON.stringify(result.state), { expirationTtl: STATE_TTL });
  // The self-introduction is said once. Someone who keeps chatting about other things (often an
  // existing customer talking to the owner) is left to the owner instead of hearing it again.
  const introAgain = result.path === "intro" && !!(await env.KV.get(`intro:${userId}`));
  if (!introAgain) await reply(env, ev.replyToken, userId, result.reply);
  if (result.path === "intro" && !introAgain) await env.KV.put(`intro:${userId}`, "1", { expirationTtl: STATE_TTL });

  const after: Promise<unknown>[] = [afterTurn(env, "line", result)];
  // no access token = local test: keep test turns out of the real sheet
  const logged = introAgain ? { ...result, reply: "（沒有回覆：自我介紹說過了，留給老闆）" } : result;
  if (env.LOG_URL && env.LOG_SECRET && env.LINE_CHANNEL_ACCESS_TOKEN) after.push(logTurn(env.LOG_URL, env.LOG_SECRET, "line", session, merged, logged));
  if (result.path === "lead_saved") {
    // the owner usually answers by hand from here: the advisor steps back for 3 days on its own
    after.push(setQuiet(env, userId));
    after.push(lineName(env, userId).then((n) => notifyOwner(env, leadText("LINE", result, n, session))));
  }
  await Promise.allSettled(after);
}

/**
 * Quick bursts ("哈囉" "想問一下…" "謝謝") used to get one answer each, worked on at the same time.
 * Each message joins a short pending list and waits; only the last one of the burst carries on and
 * answers the whole burst. null = a newer message will answer.
 */
async function settle(env: Env, userId: string, id: string, text: string): Promise<string | null> {
  const key = `pend:${userId}`;
  type Pending = { id: string; text: string }[];
  const pend = (await env.KV.get<Pending>(key, "json")) ?? [];
  pend.push({ id, text });
  await env.KV.put(key, JSON.stringify(pend.slice(-5)), { expirationTtl: 60 });
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const now = (await env.KV.get<Pending>(key, "json")) ?? pend;
  if (now.length && now[now.length - 1].id !== id) return null;
  await env.KV.delete(key);
  return (now.length ? now : pend).map((p) => p.text).join("\n");
}

/** The LINE user behind a code: sess:<code>, or a scan of the saved conversations for older customers. */
async function userOfCode(env: Env, code: string): Promise<string | null> {
  let target = await env.KV.get(`sess:${code}`);
  if (!target) {
    let cursor: string | undefined;
    do {
      const page = await env.KV.list({ prefix: "line:", cursor });
      for (const k of page.keys) {
        const uid = k.name.slice(5);
        if ((await sessionOf(uid)) === code) target = uid;
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor && !target);
    if (target) await env.KV.put(`sess:${code}`, target, { expirationTtl: SESSION_TTL });
  }
  return target;
}

/** 成交 / 接手 / 交回 for one customer, by code (typed, from a name match, or from a tapped button). */
async function ownerCommand(env: Env, verb: Verb, code: string): Promise<string> {
  const target = await userOfCode(env, code);
  if (!target) return `找不到 ${code} 這位客人，請確認代碼（在新名單通知裡），或直接傳「${verb}」從最近的客人裡點選。`;
  const name = (await env.KV.get<Profile>(`prof:${target}`, "json"))?.name || "";
  const who = name ? `${name}（${code}）` : code;
  if (verb === "成交") {
    await env.KV.put(`member:${target}`, "1"); // no expiry: a buyer stays family
    const st = await env.KV.get<State>(`line:${target}`, "json");
    if (st) await env.KV.put(`line:${target}`, JSON.stringify({ ...st, member: true }), { expirationTtl: STATE_TTL });
    return `已把 ${who} 標成已購買。之後這位客人來問，顧問會用老客人的口吻回答照顧問題，不再推銷或請客人留聯絡方式；健康問題會請客人就醫並由您聯繫。`;
  }
  if (verb === "接手") {
    const until = await setQuiet(env, target);
    return `已接手 ${who}，顧問會安靜到 ${twTime(new Date(until))}。要提早交回請傳：交回 ${name || code}`;
  }
  await env.KV.delete(`quiet:${target}`);
  return `已交回 ${name || code}，顧問恢復回覆。`;
}

/** One numbered line per customer, for the text above the buttons. */
async function describe(env: Env, list: Recent[]): Promise<string[]> {
  return Promise.all(
    list.map(async (r, i) => {
      const uid = await env.KV.get(`sess:${r.code}`);
      const q = uid ? await quietUntil(env, uid) : null;
      const status = q === null ? "" : q ? `（已接手到 ${twDate(new Date(q))}）` : "（已接手）";
      return `${i + 1}. ${r.name || r.code}｜${twWhen(r.at)}｜${r.last}${status}`;
    }),
  );
}

/** Quick Reply buttons (label ≤ 20 characters): the name, plus the time when two customers share a name. */
function buttonsFor(verb: Verb, list: Recent[]): QuickButton[] {
  const count = new Map<string, number>();
  for (const r of list) count.set(r.name || r.code, (count.get(r.name || r.code) ?? 0) + 1);
  const used = new Set<string>();
  return list.map((r) => {
    const base = r.name || r.code;
    let suffix = (count.get(base) ?? 0) > 1 ? ` ${twClock(new Date(r.at))}` : "";
    if (used.has([...base].slice(0, 20 - suffix.length).join("") + suffix)) suffix += ` ${r.code.slice(-4)}`; // same name, same minute
    const label = [...base].slice(0, 20 - suffix.length).join("") + suffix;
    used.add(label);
    return { label, data: `action=${ACTION[verb]}&code=${r.code}`, displayText: `${verb} ${base}` };
  });
}

/** Who a verb can apply to: 交回 only makes sense for chats the owner has taken over. */
async function candidates(env: Env, verb: Verb): Promise<Recent[]> {
  const list = await readRecent(env);
  if (verb !== "交回") return list;
  const out: Recent[] = [];
  for (const r of list) {
    const uid = await env.KV.get(`sess:${r.code}`);
    if (uid && (await quietUntil(env, uid)) !== null) out.push(r);
  }
  return out;
}

/** 接手 / 交回 / 成交 followed by a LINE name, part of one, or nothing (= pick from the recent customers). */
async function ownerByName(env: Env, verb: Verb, query: string): Promise<{ text: string; buttons: QuickButton[] }> {
  const pool = await candidates(env, verb);
  const picker = async (head: string, list: Recent[]) => {
    const pick = list.slice(0, PICK_MAX);
    if (!pick.length) return { text: `${head}${verb === "交回" ? "目前沒有已接手的客人。" : "最近還沒有客人傳訊息。"}`, buttons: [] };
    const title = `${head}${verb === "交回" ? "已接手的客人" : "最近的客人"}（點下面的按鈕${verb}）：`;
    return { text: [title, ...(await describe(env, pick))].join("\n"), buttons: buttonsFor(verb, pick) };
  };
  const q = norm(query);
  if (!q) return picker("", pool);

  const exact = pool.filter((r) => r.name && norm(r.name) === q);
  const found = exact.length ? exact : pool.filter((r) => r.name && norm(r.name).includes(q));
  if (found.length === 1) return { text: await ownerCommand(env, verb, found[0].code), buttons: [] };
  if (found.length > 1) {
    const list = found.slice(0, 13); // LINE shows at most 13 Quick Reply buttons
    const title = `有 ${found.length} 位客人符合「${query.trim()}」，請點選要${verb}的是哪一位：`;
    return { text: [title, ...(await describe(env, list))].join("\n"), buttons: buttonsFor(verb, list) };
  }
  return picker(`找不到叫「${query.trim()}」的客人。\n`, pool);
}

/** After every turn (web and LINE): weekly counters, and a LINE alert the first time today's model cost passes the limit. */
export async function afterTurn(env: Env, channel: string, r: Result) {
  await recordTurn(env.KV, channel, r);
  const { before, after } = await addDayCost(env.KV, costUsd(r));
  const limit = Number(env.DAILY_COST_ALERT_USD ?? "0.5");
  if (before < limit && after >= limit) {
    await notifyOwner(
      env,
      `提醒：今天的模型費用已經到 ${after.toFixed(3)} 美元（約台幣 ${Math.round(after * 32)} 元），超過設定的 ${limit} 美元。如果不是客人變多，可能有人在大量測試或洗訊息，可以看紀錄試算表。`,
    );
  }
}

/** POST /line/webhook */
export async function lineWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.LINE_CHANNEL_SECRET) return new Response("LINE not configured", { status: 503 });
  const body = await request.text();
  if (!(await verifyLineSignature(env.LINE_CHANNEL_SECRET, body, request.headers.get("x-line-signature")))) {
    return new Response("bad signature", { status: 401 });
  }
  let events: LineEvent[] = [];
  try {
    events = (JSON.parse(body) as { events?: LineEvent[] }).events ?? [];
  } catch {
    return new Response("bad json", { status: 400 });
  }
  // Answer LINE right away; the turns run after the response (one by one, so two quick
  // messages from the same person do not overwrite each other's memory)
  // LINE sometimes sends a customer's quick messages in one webhook: join them into the last one,
  // so the burst gets one answer (owner messages stay separate, they may be commands)
  const lastText = new Map<string, LineEvent>();
  for (const ev of events) {
    const uid = ev.source?.userId;
    if (ev.type !== "message" || ev.message?.type !== "text" || !uid || uid === env.LINE_OWNER_ID) continue;
    const prev = lastText.get(uid);
    if (prev?.message) {
      ev.message.text = `${prev.message.text ?? ""}\n${ev.message.text ?? ""}`;
      (prev as { merged?: boolean }).merged = true;
    }
    lastText.set(uid, ev);
  }
  events = events.filter((ev) => !(ev as { merged?: boolean }).merged);

  ctx.waitUntil(
    (async () => {
      for (const ev of events) {
        try {
          await handleEvent(env, ev);
        } catch (error) {
          console.error("LINE event failed", error);
        }
      }
    })(),
  );
  return new Response("ok");
}

/** Monday 09:00 Taiwan: last week's numbers to the owner. */
export async function weeklyReport(env: Env, now = new Date()) {
  await notifyOwner(env, formatReport(await readWeek(env.KV, lastWeekKey(now)), "金霸貓舍 AI 顧問週報"));
}
