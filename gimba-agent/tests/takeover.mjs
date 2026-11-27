// Local test of the owner's 接手 / 交回 / 成交 by LINE name and by button (run `npm run dev` first).
// Every customer here is a fake LINE user with a made-up name (the repo is public: no real names or codes).
// With no access token the worker answers the profile API from /api/dev/profile and keeps what it
// would have sent to LINE in /api/dev/outbox.
import { readFileSync } from "node:fs";
import { createHash, createHmac, randomUUID } from "node:crypto";

const BASE = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "http://127.0.0.1:8787";
const vars = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const SECRET = vars.LINE_CHANNEL_SECRET;
const OWNER = vars.LINE_OWNER_ID;
let ok = 0, fail = 0;
const check = (name, cond, extra = "") => { cond ? ok++ : fail++; console.log(`${cond ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`); };

const sign = (body) => createHmac("sha256", SECRET).update(body).digest("base64");
const codeOf = (uid) => "line-" + createHash("sha256").update(uid).digest("hex").slice(0, 10);
async function post(events) {
  const body = JSON.stringify({ destination: "Utestbot", events });
  return fetch(`${BASE}/line/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-line-signature": sign(body) }, body });
}
const outbox = async () => (await fetch(`${BASE}/api/dev/outbox`)).json();
const base = (userId) => ({ webhookEventId: randomUUID(), replyToken: randomUUID(), source: { type: "user", userId } });
const textEvent = (userId, text) => ({ type: "message", ...base(userId), message: { type: "text", id: "1", text } });
const followEvent = (userId) => ({ type: "follow", ...base(userId) });
const postbackEvent = (userId, data) => ({ type: "postback", ...base(userId), postback: { data } });
const profile = (userId, name) => fetch(`${BASE}/api/dev/profile`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId, name }) });

/** Sends one event and returns the first reply to `to`, or null after `wait` ms. */
async function send(ev, wait = 60_000) {
  const to = ev.source.userId;
  const before = (await outbox()).length;
  await post([ev]);
  const t0 = Date.now();
  while (Date.now() - t0 < wait) {
    const hit = (await outbox()).slice(before).find((m) => m.kind === "reply" && m.to === to);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}
const owner = (text) => send(textEvent(OWNER, text));
const codesIn = (msg) => (msg?.buttons ?? []).map((b) => new URLSearchParams(b.data).get("code"));

// a different set of fake names on every run, so earlier runs in the local KV never collide
const tag = Date.now().toString(36).slice(-4);
const id = (who) => `Utest${who}${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const A = id("ming"), B1 = id("xm1"), B2 = id("xm2"), X = id("stranger"), F = id("noprofile"), W = id("amy");
const NAME_A = `王小明${tag}`, NAME_B = `小明${tag}`;
const full = (s) => [...s].map((c) => (c >= "!" && c <= "~" ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c)).join("");
const NAME_W = full(`Amy${tag}`); // stored full-width: Ａｍｙ…
await profile(A, NAME_A);
await profile(B1, NAME_B);
await profile(B2, NAME_B);
await profile(X, `路人${tag}`);
await profile(F, "!fail");
await profile(W, NAME_W);

// 1 + 5. a new customer writes: the name is kept and they are at the top of the recent list (never the owner)
const a1 = await send(textEvent(A, "你好，想了解英短"));
check("新客人收到顧問回覆", !!a1?.text, a1?.text.slice(0, 30));
const list = await owner("接手");
console.log((list?.text ?? "").replace(/^/gm, "    "));
check("1. 新客人出現在最近清單最前面（顯示名字）", (list?.text.split("\n")[1] ?? "").startsWith(`1. ${NAME_A}｜`));
check("5. 只傳「接手」→ 最多 5 顆按鈕", list?.buttons?.length >= 1 && list.buttons.length <= 5, `${list?.buttons?.length} 顆`);
check("5. 清單不包含老闆自己", !codesIn(list).includes(codeOf(OWNER)));
check("按鈕的 displayText 看得懂", list?.buttons?.[0]?.displayText === `接手 ${NAME_A}`, list?.buttons?.[0]?.displayText);

// 2. take over by name: one match -> done, the advisor stops answering this customer
const t2 = await owner(`接手 ${NAME_A}`);
check("2. 「接手 名字」只有一位 → 直接接手", t2?.text.startsWith(`已接手 ${NAME_A}（${codeOf(A)}），顧問會安靜到 `) && t2.text.includes(`交回 ${NAME_A}`), t2?.text);
const q2 = await send(textEvent(A, "老闆在嗎"), 6000);
check("2. 接手後客人傳訊，顧問不回", q2 === null);

// 6. hand back by name
const t6 = await owner(`交回 ${NAME_A}`);
check("6. 「交回 名字」", t6?.text === `已交回 ${NAME_A}，顧問恢復回覆。`, t6?.text);
const a6 = await send(textEvent(A, "謝謝"));
check("6. 交回後顧問恢復回覆", !!a6?.text, a6?.text.slice(0, 30));

// 3. two customers with the same name: buttons, and the tapped one is the only one taken over
await send(followEvent(B1));
await send(followEvent(B2));
const t3 = await owner(`接手 ${NAME_B}`);
console.log((t3?.text ?? "").replace(/^/gm, "    "));
const labels = (t3?.buttons ?? []).map((b) => b.label);
check("3. 兩位同名 → 回兩顆按鈕（王小明不算，完全相同的優先）", t3?.buttons?.length === 2 && codesIn(t3).includes(codeOf(B1)) && codesIn(t3).includes(codeOf(B2)), labels.join(" / "));
check("3. 同名的按鈕標籤不一樣、都在 20 字內", new Set(labels).size === labels.length && labels.every((l) => [...l].length <= 20));
const picked = t3?.buttons?.find((b) => b.data.includes(codeOf(B1)));
const tap = await send(postbackEvent(OWNER, picked?.data ?? ""));
check("3. 點按鈕 → 接手那一位", tap?.text.startsWith(`已接手 ${NAME_B}（${codeOf(B1)}）`), tap?.text);
const handing = await owner("交回");
check("3. 只有點的那一位被接手（「交回」清單）", codesIn(handing).includes(codeOf(B1)) && !codesIn(handing).includes(codeOf(B2)));
check("「交回」只列出已接手的客人", (handing?.text ?? "").split("\n").slice(1).every((l) => l.includes("已接手")), handing?.buttons?.length + " 位");
await send(postbackEvent(OWNER, `action=handback&code=${codeOf(B1)}`));

// 4. no such name
const t4 = await owner(`接手 不存在${tag}`);
check("4. 找不到 → 找不到訊息＋最近 5 位按鈕", t4?.text.startsWith(`找不到叫「不存在${tag}」的客人。`) && t4.buttons?.length >= 1 && t4.buttons.length <= 5, t4?.text.split("\n")[0]);

// 7. someone who is not the owner sends the command, or forges the button
const x7 = await send(textEvent(X, `接手 ${NAME_A}`));
check("7. 非老闆傳「接手 名字」→ 當一般客人回答", !!x7?.text && !x7.text.startsWith("已接手"), x7?.text.slice(0, 30));
const forged = await send(postbackEvent(X, `action=takeover&code=${codeOf(A)}`), 4000);
check("7. 非老闆偽造 postback → 不回、不觸發", forged === null);
const h7 = await owner("交回");
check("7. 那位客人沒有被接手", !codesIn(h7).includes(codeOf(A)));

// 8. the profile API fails: the customer still gets an answer, the list shows the code instead
const f8 = await send(textEvent(F, "請問曼赤肯好養嗎"));
check("8. Profile API 失敗，客人照常收到回覆", !!f8?.text, f8?.text.slice(0, 30));
const l8 = await owner("接手");
check("8. 清單改顯示代碼", (l8?.text.split("\n")[1] ?? "").startsWith(`1. ${codeOf(F)}｜`), l8?.text.split("\n")[1]);

// 9. "clear my data": the name and the list entry go too
const r9 = await send(textEvent(A, "清除我的資料"));
check("9. 客人傳「清除我的資料」→ 清掉記憶", r9?.text.includes("重新開始"), r9?.text.slice(0, 20));
const n9 = await owner(`接手 ${NAME_A}`);
check("9. 名字查不到了", n9?.text.startsWith("找不到叫"), n9?.text.split("\n")[0]);
check("9. 最近清單裡那一筆也不見了", !codesIn(n9).includes(codeOf(A)));

// 10. the code still works
const t10 = await owner(`接手 ${codeOf(B2)}`);
check("10. 舊用法「接手 line-xxxx」", t10?.text.startsWith(`已接手 ${NAME_B}（${codeOf(B2)}）`), t10?.text);
const b10 = await owner(`交回 ${codeOf(B2)}`);
check("10. 舊用法「交回 line-xxxx」", b10?.text === `已交回 ${NAME_B}，顧問恢復回覆。`, b10?.text);

// 11. full-width / half-width, upper / lower case, spaces around
await send(followEvent(W));
const t11 = await owner(`接手 　 AMY${tag.toUpperCase()}  `);
check("11. 名字比對不分全形半形、大小寫、前後空白", t11?.text.startsWith(`已接手 ${NAME_W}（${codeOf(W)}）`), t11?.text);
const b11 = await owner(`交回 ${full("amy")}`); // part of the name, typed full-width
check("11. 打一部分名字（全形）也找得到", b11?.text === `已交回 ${NAME_W}，顧問恢復回覆。`, b11?.text);

console.log(`\n${ok} 通過、${fail} 沒過`);
process.exit(fail ? 1 : 0);
