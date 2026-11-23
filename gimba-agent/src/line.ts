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
const OWNER_HELP = "老闆您好！可以傳這些指令：\n「本週」看這週到目前的數字\n「上週」看上週週報\n「成交 代碼」把這位客人標成已購買，之後顧問用老客人的口吻、不再推銷\n「接手 代碼」顧問對這位客人安靜 3 天，讓您自己回（客人留下聯絡方式時會自動安靜 3 天）\n「交回 代碼」顧問恢復回覆\n代碼在新名單通知裡（line- 開頭）。其他訊息會當成一般客人回答，可以拿來測試。";
const QUIET_TTL = 3 * 24 * 3600; // 接手: the advisor stays out of this chat for 3 days
const SESSION_TTL = 180 * 24 * 3600;
const OWNER_CMD = /^(成交|接手|交回)\s*(line-[0-9a-f]{10})$/i;

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
export function leadText(channel: string, r: Result, lineName = "", code = ""): string {
  const s = r.state.slots;
  const want = [s.breed, s.color, s.budget && `預算 ${s.budget}`, s.home, s.experience].filter(Boolean).join("／");
  return [
    `新名單（${channel}）${twTime()}`,
    `稱呼：${s.name || "沒留"}`,
    `聯絡方式：${s.contact}`,
    ...(lineName ? [`LINE 名稱：${lineName}`] : []),
    `需求：${want || "還沒問到"}`,
    "",
    ...(code ? [`代碼：${code}`] : []),
    "",
    channel === "LINE" ? `請直接在 LINE 官方帳號的聊天裡回覆他，顧問接下來 3 天不會插話。想讓顧問繼續陪他聊，傳「交回 ${code}」；成交後傳「成交 ${code}」。` : "完整對話在紀錄試算表。",
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
    if (/^(老闆|說明|help|指令)$/i.test(text)) return reply(env, ev.replyToken, userId, OWNER_HELP);
    const cmd = text.match(OWNER_CMD);
    if (cmd) return reply(env, ev.replyToken, userId, await ownerCommand(env, cmd[1], cmd[2].toLowerCase()));
  }

  // The owner took this chat over (接手): stay quiet, the owner answers in the LINE OA chat
  if (await env.KV.get(`quiet:${userId}`)) return;

  if (text.length > MAX_MESSAGE_CHARS) return reply(env, ev.replyToken, userId, TOO_LONG);
  const key = `line:${userId}`;
  if (text.length <= RESET_MAX_CHARS && RESET.test(text)) {
    await env.KV.delete(key);
    return reply(env, ev.replyToken, userId, RESET_DONE);
  }
  const session = await sessionOf(userId);
  await env.KV.put(`sess:${session}`, userId, { expirationTtl: SESSION_TTL });
  const state: State = (await env.KV.get<State>(key, "json")) ?? newState();
  if (await env.KV.get(`member:${userId}`)) state.member = true;
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

  const after: Promise<unknown>[] = [afterTurn(env, "line", result)];
  // no access token = local test: keep test turns out of the real sheet
  if (env.LOG_URL && env.LOG_SECRET && env.LINE_CHANNEL_ACCESS_TOKEN) after.push(logTurn(env.LOG_URL, env.LOG_SECRET, "line", session, text, result));
  if (result.path === "lead_saved") {
    // the owner usually answers by hand from here: the advisor steps back for 3 days on its own
    after.push(env.KV.put(`quiet:${userId}`, "1", { expirationTtl: QUIET_TTL }));
    after.push(displayName(env, userId).then((n) => notifyOwner(env, leadText("LINE", result, n, session))));
  }
  await Promise.allSettled(after);
}

/** 成交 / 接手 / 交回 + the code from the lead push. */
async function ownerCommand(env: Env, verb: string, code: string): Promise<string> {
  let target = await env.KV.get(`sess:${code}`);
  if (!target) {
    // customers from before codes were saved: find them among the saved conversations
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
  if (!target) return `找不到 ${code} 這位客人，請確認代碼（在新名單通知裡）。`;
  if (verb === "成交") {
    await env.KV.put(`member:${target}`, "1"); // no expiry: a buyer stays family
    const st = await env.KV.get<State>(`line:${target}`, "json");
    if (st) await env.KV.put(`line:${target}`, JSON.stringify({ ...st, member: true }), { expirationTtl: STATE_TTL });
    return `已把 ${code} 標成已購買。之後這位客人來問，顧問會用老客人的口吻回答照顧問題，不再推銷或請他留聯絡方式；健康問題會請他就醫並由您聯繫。`;
  }
  if (verb === "接手") {
    await env.KV.put(`quiet:${target}`, "1", { expirationTtl: QUIET_TTL });
    return `好的，接下來 3 天顧問不會回覆 ${code}，請您直接在官方帳號聊天裡回他。要提早交回，傳「交回 ${code}」。`;
  }
  await env.KV.delete(`quiet:${target}`);
  return `好的，顧問恢復回覆 ${code}。`;
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
