// Unit 9 local test of the LINE webhook (run `npm run dev` first).
// Uses the local LINE_CHANNEL_SECRET from .dev.vars to sign fake LINE events; with no access token
// the worker keeps what it would have sent in /api/dev/outbox instead of calling LINE.
import { readFileSync } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";

const BASE = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "http://127.0.0.1:8787";
const vars = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const SECRET = vars.LINE_CHANNEL_SECRET;
const OWNER = vars.LINE_OWNER_ID;
const CUSTOMER = "Utestcustomer" + Date.now();
let ok = 0, fail = 0;
const check = (name, cond, extra = "") => { cond ? ok++ : fail++; console.log(`${cond ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`); };

const sign = (body, secret = SECRET) => createHmac("sha256", secret).update(body).digest("base64");
async function post(events, secret) {
  const body = JSON.stringify({ destination: "Utestbot", events });
  return fetch(`${BASE}/line/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-line-signature": sign(body, secret) }, body });
}
const outbox = async () => (await fetch(`${BASE}/api/dev/outbox`)).json();
const textEvent = (userId, text, id = randomUUID()) => ({ type: "message", webhookEventId: id, replyToken: randomUUID(), source: { type: "user", userId }, message: { type: "text", id: "1", text } });

/** Sends events and waits until `n` new outbox entries of the given kinds appear. */
async function send(events, n = 1, kinds = ["reply"]) {
  const before = (await outbox()).length;
  const res = await post(events);
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    const box = await outbox();
    const fresh = box.slice(before).filter((m) => kinds.includes(m.kind));
    if (fresh.length >= n) return { res, fresh, ms: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 400));
  }
  return { res, fresh: (await outbox()).slice(before).filter((m) => kinds.includes(m.kind)), ms: 60_000 };
}

await fetch(`${BASE}/api/dev/outbox`, { method: "DELETE" });

// 1. a request not signed with our channel secret is refused
const bad = await post([textEvent(CUSTOMER, "你好")], "not-the-secret");
check("偽造簽章被拒絕", bad.status === 401, `HTTP ${bad.status}`);
const none = await fetch(`${BASE}/line/webhook`, { method: "POST", body: "{}" });
check("沒有簽章被拒絕", none.status === 401, `HTTP ${none.status}`);

// 2. LINE's "Verify" button sends an empty event list
const verify = await post([]);
check("Verify（空事件）回 200", verify.status === 200);

// 3. adding the account as a friend gets the intro
const f = await send([{ type: "follow", webhookEventId: randomUUID(), replyToken: randomUUID(), source: { type: "user", userId: CUSTOMER } }]);
check("加好友回自我介紹", f.fresh[0]?.text.includes("AI 選種顧問"), f.fresh[0]?.text.slice(0, 30));

// 4. a sticker is answered with a fixed line
const st = await send([{ type: "message", webhookEventId: randomUUID(), replyToken: randomUUID(), source: { type: "user", userId: CUSTOMER }, message: { type: "sticker", id: "2" } }]);
check("貼圖回固定句", st.fresh[0]?.text.includes("文字訊息"));

// 5. a whole conversation: memory must carry over between webhooks (KV)
const talk = ["想養曼赤肯，喜歡奶油色的", "預算大概六萬", "住公寓，家裡沒有其他寵物", "第一次養貓"];
for (const msg of talk) {
  const r = await send([textEvent(CUSTOMER, msg)]);
  console.log(`  客人：${msg}\n  顧問（${(r.ms / 1000).toFixed(1)} 秒）：${r.fresh[0]?.text ?? "（沒有回覆）"}`);
  check(`有回覆：${msg}`, !!r.fresh[0]?.text);
}
const lead = await send([textEvent(CUSTOMER, "我姓林，電話 0912000000")], 2, ["reply", "push"]);
const thanks = lead.fresh.find((m) => m.kind === "reply");
const push = lead.fresh.find((m) => m.kind === "push");
check("留聯絡方式回感謝句", thanks?.text.includes("謝謝"), thanks?.text.slice(0, 20));
check("老闆收到新名單推播", push?.text.includes("新名單（LINE）") && push.text.includes("0912000000"));
if (push) console.log(push.text.replace(/^/gm, "    "));

const code = push?.text.match(/line-[0-9a-f]{10}/)?.[0] ?? "";
check("新名單通知附上代碼", !!code, code);
const silent = async (text) => { const before = (await outbox()).length; await post([textEvent(CUSTOMER, text)]); await new Promise((r) => setTimeout(r, 6000)); return (await outbox()).slice(before).filter((m) => m.kind === "reply" && m.to === CUSTOMER).length; };

// 5a. right after the lead the owner answers by hand: the advisor steps back on its own
const auto = await silent("那週六可以去看嗎");
check("留下聯絡方式後顧問自動安靜", auto === 0, `${auto} 則`);
await send([textEvent(OWNER, `交回 ${code}`)]);

// 5b. after leaving contact: answer only, never invite again
const fu = await send([textEvent(CUSTOMER, "看可預訂的寶寶")]);
check("留過聯絡方式後不再邀請", !!fu.fresh[0] && !/稱呼跟聯絡方式|留個稱呼/.test(fu.fresh[0].text), fu.fresh[0]?.text.slice(0, 40));

// 5c. owner marks the sale: after-sales tone from now on
const deal = await send([textEvent(OWNER, `成交 ${code}`)]);
check("老闆傳「成交 代碼」", deal.fresh[0]?.text.includes("已購買"), deal.fresh[0]?.text.slice(0, 30));
const mem = await send([textEvent(CUSTOMER, "貓咪接回家後一直躲在床底下怎麼辦")]);
check("成交後用老客人口吻、不推銷", !!mem.fresh[0] && !/預算|稱呼跟聯絡方式|品種/.test(mem.fresh[0].text), mem.fresh[0]?.text.slice(0, 60));

// 5d. owner takes over: the advisor stays quiet until handed back
await send([textEvent(OWNER, `接手 ${code}`)]);
const quiet = await silent("老闆在嗎");
check("接手後顧問不回覆", quiet === 0, `${quiet} 則`);
await send([textEvent(OWNER, `交回 ${code}`)]);
const back = await send([textEvent(CUSTOMER, "謝謝")]);
check("交回後顧問恢復回覆", !!back.fresh[0], back.fresh[0]?.text.slice(0, 30));

// 5e. a customer who says the cat is already home is treated as family without any command
const OLD = "Utestoldbuyer" + Date.now();
const old = await send([textEvent(OLD, "我去年在你們這買的英短最近不太吃飯")]);
check("說貓是在這裡買的 → 老客人口吻（不是自我介紹）", !!old.fresh[0] && !old.fresh[0].text.includes("AI 選種顧問"), old.fresh[0]?.text.slice(0, 60));

// 6. LINE redelivers the same event: it must be answered only once
const dupId = randomUUID();
const d1 = await send([textEvent(CUSTOMER, "謝謝", dupId)]);
const d2 = await send([textEvent(CUSTOMER, "謝謝", dupId)], 1);
check("重送的同一事件只處理一次", d1.fresh.length === 1 && d2.fresh.length === 0, `${d1.fresh.length} / ${d2.fresh.length}`);

// 6b. LINE has no "start over" button: asking in words wipes the memory
const rs = await send([textEvent(CUSTOMER, "清除我的資料再問一次")]);
check("說「清除我的資料」會清掉記憶", rs.fresh[0]?.text.includes("重新開始"), rs.fresh[0]?.text.slice(0, 20));
const after = await send([textEvent(CUSTOMER, "我想買貓")]);
check("清掉後從頭問（不是回感謝句）", !!after.fresh[0] && !after.fresh[0].text.includes("謝謝"), after.fresh[0]?.text.slice(0, 30));

// 6c. spend alert: the first turn of the day that passes DAILY_COST_ALERT_USD pushes a warning
const alert = (await outbox()).find((m) => m.kind === "push" && m.text.includes("今天的模型費用"));
check("單日費用超過門檻推播警告", !!alert, alert ? alert.text.slice(0, 30) : "（本機 .dev.vars 要設很低的 DAILY_COST_ALERT_USD，並先清掉今天的累計）");

// 7. the owner asks for this week's numbers
const rep = await send([textEvent(OWNER, "本週")]);
check("老闆傳「本週」拿到數字", rep.fresh[0]?.text.includes("新對話"), "");
if (rep.fresh[0]) console.log(rep.fresh[0].text.replace(/^/gm, "    "));

// 8. the Monday cron pushes last week's report
const before = (await outbox()).length;
const cron = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent("0 1 * * MON")}`);
await new Promise((r) => setTimeout(r, 1500));
const cronPush = (await outbox()).slice(before).find((m) => m.kind === "push");
check("週一排程推播週報", cron.ok && cronPush?.text.includes("週報"), `HTTP ${cron.status}`);
if (cronPush) console.log(cronPush.text.replace(/^/gm, "    "));

console.log(`\n${ok} 通過、${fail} 沒過`);
process.exit(fail ? 1 : 0);
