import Anthropic from "@anthropic-ai/sdk";
import { handleMessage, INTRO, newState, type Result, type State } from "./agent";
import { logTurn } from "./log";
import { formatReport, lastWeekKey, readWeek, recordTurn, weekKey } from "./stats";
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
const OWNER_HELP = "老闆您好！傳「本週」看這週到目前的數字，傳「上週」看上週週報。其他訊息會當成一般客人回答，可以拿來測試。";

// When no access token is set (local dev), outgoing messages are kept here instead of sent to LINE.
export const OUTBOX: { kind: "reply" | "push" | "loading"; to: string; text: string }[] = [];

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

async function reply(env: Env, replyToken: string, to: string, text: string) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    OUTBOX.push({ kind: "reply", to, text });
    return;
  }
  await lineApi(env, "/message/reply", { replyToken, messages: [{ type: "text", text }] });
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

async function displayName(env: Env, userId: string): Promise<string> {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return "（本機測試）";
  const res = await fetch(`${API}/profile/${userId}`, { headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` } });
  if (!res.ok) return "";
  return ((await res.json()) as { displayName?: string }).displayName ?? "";
}

/** Short, stable id for the sheet: the raw LINE user id stays out of the log. */
async function sessionOf(userId: string): Promise<string> {
  return "line-" + hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId))).slice(0, 10);
}

function twTime(d = new Date()): string {
  const t = new Date(d.getTime() + 8 * 3600_000);
  return `${t.getUTCMonth() + 1}/${t.getUTCDate()} ${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`;
}

/** The push the owner gets when someone leaves their contact, from any channel. */
export function leadText(channel: string, r: Result, lineName = ""): string {
  const s = r.state.slots;
  const want = [s.breed, s.color, s.budget && `預算 ${s.budget}`, s.home, s.experience].filter(Boolean).join("／");
  return [
    `新名單（${channel}）${twTime()}`,
    `稱呼：${s.name || "沒留"}`,
    `聯絡方式：${s.contact}`,
    ...(lineName ? [`LINE 名稱：${lineName}`] : []),
    `需求：${want || "還沒問到"}`,
    "",
    channel === "LINE" ? "可以直接在 LINE 官方帳號的聊天裡回覆他。" : "完整對話在紀錄試算表。",
  ].join("\n");
}

interface LineEvent {
  type: string;
  replyToken?: string;
  webhookEventId?: string;
  source?: { type: string; userId?: string };
  message?: { type: string; text?: string };
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

  if (ev.type === "follow") return reply(env, ev.replyToken, userId, INTRO);
  if (ev.type !== "message") return;
  if (ev.message?.type !== "text") return reply(env, ev.replyToken, userId, NOT_TEXT);
  const text = (ev.message.text ?? "").trim();
  if (!text) return;

  // The owner can ask for the numbers at any time; everything else they send is treated like a customer
  if (env.LINE_OWNER_ID && userId === env.LINE_OWNER_ID) {
    if (/^(本週|這週|本周|這周)/.test(text)) return reply(env, ev.replyToken, userId, formatReport(await readWeek(env.KV, weekKey()), "本週到目前的數字"));
    if (/^(上週|上周|週報|周報)/.test(text)) return reply(env, ev.replyToken, userId, formatReport(await readWeek(env.KV, lastWeekKey()), "金霸貓舍 AI 顧問週報"));
    if (/^(老闆|說明|help)$/i.test(text)) return reply(env, ev.replyToken, userId, OWNER_HELP);
  }

  if (text.length > MAX_MESSAGE_CHARS) return reply(env, ev.replyToken, userId, TOO_LONG);
  const key = `line:${userId}`;
  const state: State = (await env.KV.get<State>(key, "json")) ?? newState();
  if (state.turn >= MAX_TURNS) return reply(env, ev.replyToken, userId, AT_LIMIT);

  // "typing" dots while the model and the guardrail work (one-on-one chats only)
  if (env.LINE_CHANNEL_ACCESS_TOKEN) await lineApi(env, "/chat/loading/start", { chatId: userId, loadingSeconds: 20 });
  else OUTBOX.push({ kind: "loading", to: userId, text: "" });

  let result: Result;
  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    result = await handleMessage(client, env.MODEL, state, text);
  } catch (error) {
    console.error("LINE turn failed", error);
    return reply(env, ev.replyToken, userId, BUSY);
  }
  await env.KV.put(key, JSON.stringify(result.state), { expirationTtl: STATE_TTL });
  await reply(env, ev.replyToken, userId, result.reply);

  const session = await sessionOf(userId);
  const after: Promise<unknown>[] = [recordTurn(env.KV, "line", result)];
  // no access token = local test: keep test turns out of the real sheet
  if (env.LOG_URL && env.LOG_SECRET && env.LINE_CHANNEL_ACCESS_TOKEN) after.push(logTurn(env.LOG_URL, env.LOG_SECRET, "line", session, text, result));
  if (result.path === "lead_saved") after.push(displayName(env, userId).then((n) => notifyOwner(env, leadText("LINE", result, n))));
  await Promise.allSettled(after);
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
