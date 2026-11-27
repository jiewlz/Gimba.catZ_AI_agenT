// Local test: existing customers chatting with the owner, and quick bursts (run `npm run dev` first).
// - the self-introduction is said once; more off-topic chat is left to the owner
// - "ok / thanks / 👌" outside an interview gets no answer
// - several quick messages (separate webhooks, or one webhook) get one answer
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
let ok = 0, fail = 0;
const check = (name, cond, extra = "") => { cond ? ok++ : fail++; console.log(`${cond ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`); };

const sign = (body) => createHmac("sha256", SECRET).update(body).digest("base64");
async function post(events) {
  const body = JSON.stringify({ destination: "Utestbot", events });
  return fetch(`${BASE}/line/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-line-signature": sign(body) }, body });
}
const outbox = async () => (await fetch(`${BASE}/api/dev/outbox`)).json();
const base = (userId) => ({ webhookEventId: randomUUID(), replyToken: randomUUID(), source: { type: "user", userId } });
const textEvent = (userId, text) => ({ type: "message", ...base(userId), message: { type: "text", id: "1", text } });
const followEvent = (userId) => ({ type: "follow", ...base(userId) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Posts each batch (one webhook each, `gap` ms apart) and collects the replies to that user for `wait` ms. */
async function replies(userId, batches, wait = 15_000, gap = 300) {
  const before = (await outbox()).length;
  for (const b of batches) { await post(b); await sleep(gap); }
  await sleep(wait);
  return (await outbox()).slice(before).filter((m) => m.kind === "reply" && m.to === userId);
}
const id = (who) => `Utest${who}${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

// 1. an existing customer who added the account long ago and chats with the owner
const OLD = id("oldfriend");
const f = await replies(OLD, [[followEvent(OLD)]], 1500);
check("加好友時自我介紹一次", f.length === 1 && f[0].text.includes("AI 選種顧問"));
const off = await replies(OLD, [[textEvent(OLD, "禮拜一我們剛從香港回來")]]);
check("之後聊別的事 → 不再自我介紹（留給老闆）", off.length === 0, `${off.length} 則`);
for (const t of ["好", "謝謝👌", "好的！辛苦了", "沒問題～", "😂"]) {
  const r = await replies(OLD, [[textEvent(OLD, t)]], 4000);
  check(`客套話「${t}」不回`, r.length === 0, `${r.length} 則`);
}

// 2. someone who never got the intro: the first off-topic message gets it, the next one does not
const NEW = id("newcomer");
const n1 = await replies(NEW, [[textEvent(NEW, "哈囉，請問老闆在嗎")]]);
check("第一次聊別的事 → 自我介紹", n1.length === 1 && n1[0].text.includes("AI 選種顧問"), n1[0]?.text.slice(0, 20));
const n2 = await replies(NEW, [[textEvent(NEW, "那張照片我發過脆了")]]);
check("第二次聊別的事 → 不回", n2.length === 0, `${n2.length} 則`);

// 3. a quick burst in separate webhooks: one answer that covers both messages
const BUY = id("burst");
const b = await replies(BUY, [[textEvent(BUY, "我想養英短")], [textEvent(BUY, "預算大概六萬")]], 20_000);
check("連發兩句（分開送）→ 只回一則", b.length === 1, `${b.length} 則`);
console.log(`  顧問：${b[0]?.text ?? "（沒有）"}`);
check("那一則有接住兩句（不再問品種或預算）", !!b[0] && !/哪一種|哪一類|預算大概(是|落在|多少)|預算範圍|預算是多少|預算多少/.test(b[0].text), b[0]?.text.slice(0, 40));

// 4. in the middle of choosing a cat, "好" is still answered
const mid = await replies(BUY, [[textEvent(BUY, "好")]]);
check("選貓訪談中說「好」→ 照常回覆（不會把自己的想法寫出來）", mid.length === 1 && !/客人(回|說)了/.test(mid[0].text), mid[0]?.text.slice(0, 30));

// 5. LINE puts two quick messages in one webhook
const ONE = id("batch");
const one = await replies(ONE, [[textEvent(ONE, "我想養曼赤肯"), textEvent(ONE, "住公寓")]], 20_000);
check("同一個 webhook 兩句 → 只回一則", one.length === 1, `${one.length} 則`);

// 5b. the same need is asked at most twice in a row; then off-topic chat gets nothing, a question gets only an answer
const ASK = id("asktwice");
const a1 = await replies(ASK, [[textEvent(ASK, "想看可預訂的寶寶")]]);
const a2 = await replies(ASK, [[textEvent(ASK, "我現在在上班")]]);
check("問需求的回覆夠短（60 字左右）", [...a1, ...a2].every((m) => [...m.text].length <= 80), [...a1, ...a2].map((m) => [...m.text].length).join("、") + " 字");
console.log(`  顧問：${a1[0]?.text}\n  顧問：${a2[0]?.text}`);
const a3 = await replies(ASK, [[textEvent(ASK, "晚點再說，先去開會")]]);
check("同一個問題問過兩次、客人聊別的 → 不回", a3.length === 0, a3[0]?.text.slice(0, 30) ?? "0 則");
const a4 = await replies(ASK, [[textEvent(ASK, "請問可以分期嗎")]]);
check("之後問問題 → 只回答、不再追問品種", a4.length === 1 && !/哪一種|哪一類|類型|品種|長腿|短腿|？|\?/.test(a4[0].text), a4[0]?.text);

// 6. photos and stickers: the "text only" note at most once, nothing for stickers, nothing while taken over
const imageEvent = (userId) => ({ type: "message", ...base(userId), message: { type: "image", id: "2" } });
const stickerEvent = (userId) => ({ type: "message", ...base(userId), message: { type: "sticker", id: "3" } });
const PIC = id("photos");
const p1 = await replies(PIC, [[imageEvent(PIC), imageEvent(PIC), imageEvent(PIC)]], 3000);
check("一次傳三張照片 → 只說一次「只看得懂文字」", p1.length === 1 && p1[0].text.includes("文字"), `${p1.length} 則`);
const p2 = await replies(PIC, [[imageEvent(PIC)]], 3000);
check("之後再傳照片 → 不回", p2.length === 0, `${p2.length} 則`);
const STK = id("sticker");
const s1 = await replies(STK, [[stickerEvent(STK)]], 3000);
check("傳貼圖 → 不回", s1.length === 0, `${s1.length} 則`);
const OWNER = vars.LINE_OWNER_ID;
if (OWNER) {
  const TAKEN = id("taken");
  await replies(TAKEN, [[textEvent(TAKEN, "我想養英短")]], 12_000);
  const code = "line-" + createHash("sha256").update(TAKEN).digest("hex").slice(0, 10);
  const taken = await replies(OWNER, [[textEvent(OWNER, `接手 ${code}`)]], 3000);
  check("老闆接手", taken.length === 1 && taken[0].text.startsWith("已接手"), taken[0]?.text.slice(0, 20));
  const quietPic = await replies(TAKEN, [[imageEvent(TAKEN)], [stickerEvent(TAKEN)]], 3000);
  check("接手中客人只傳照片／貼圖 → 不回", quietPic.length === 0, `${quietPic.length} 則`);
  await replies(OWNER, [[textEvent(OWNER, `交回 ${code}`)]], 3000);
} else console.log("（.dev.vars 沒有 LINE_OWNER_ID，略過接手中傳照片的測試）");


console.log(`\n${ok} 通過、${fail} 沒過`);
process.exit(fail ? 1 : 0);
