import { CAT_CSS, CAT_JS } from "./cat";

export const PAGE = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#efe4d4">
<title>金霸貓舍 AI 選種顧問</title>
<style>
  :root {
    --bg:#efe4d4; --wall:#f6ede1; --wall2:#ecdcc6; --floor:#dcc4a3; --plinth:#cfb48f;
    --panel:#fffaf3; --ink:#2f2924; --muted:#8a7d70; --line:#e6d8c5;
    --brand:#a8692f; --brand-dark:#7d4c22; --gold-soft:#f6e6cf;
  }
  * { box-sizing:border-box; margin:0; padding:0; }
  html, body { height:100%; }
  body { background:var(--bg); color:var(--ink); font-family:-apple-system, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif; -webkit-font-smoothing:antialiased; }
  .app { max-width:980px; height:100%; margin:0 auto; display:flex; flex-direction:column; background:var(--panel); box-shadow:0 0 0 1px var(--line); }
  header { display:flex; align-items:center; gap:10px; padding:10px 14px; background:var(--brand-dark); color:#fff8ee; }
  header h1 { font-size:15px; font-weight:700; letter-spacing:.04em; }
  header p { font-size:11px; opacity:.8; }
  header .sp { flex:1; }
  header button { font:inherit; font-size:12px; color:#fff8ee; background:rgba(255,255,255,.12); border:1px solid rgba(255,255,255,.25); border-radius:999px; padding:5px 11px; cursor:pointer; }

  /* stage: the cat takes shape as the customer talks */
  .stage { position:relative; flex:0 0 auto; height:min(44vh, 400px); min-height:260px; overflow:hidden;
    background:linear-gradient(180deg, var(--wall) 0%, var(--wall2) 72%, var(--floor) 72%, #d3b994 100%); }
  .shelf { position:absolute; left:6%; right:6%; height:6px; border-radius:3px; background:#d9c2a2; opacity:.7; }
  .shelf.s1 { top:22%; } .shelf.s2 { top:44%; left:62%; }
  .frame { position:absolute; top:9%; left:7%; width:68px; height:52px; border:4px solid #c9a77a; border-radius:4px; background:#f9f1e5; display:grid; place-items:center; font-size:10px; color:#a1855f; letter-spacing:.1em; }
  .catwrap { position:absolute; left:50%; bottom:6%; transform:translateX(-50%); width:min(230px, 52vw); }
  .catwrap::after { content:""; position:absolute; left:14%; right:14%; bottom:1%; height:16px; border-radius:50%; background:var(--plinth); opacity:.55; z-index:0; }
  .catwrap svg { position:relative; z-index:1; width:100%; height:auto; display:block; transition:filter .8s ease, opacity .8s ease; }
  .catwrap.unknown svg { filter:grayscale(1) brightness(1.18); opacity:.42; }
  .nametag { position:absolute; left:50%; top:5%; transform:translateX(-50%); background:rgba(255,250,243,.92); border:1px solid var(--line); border-radius:999px; padding:6px 14px; font-size:13px; font-weight:700; white-space:nowrap; max-width:92%; overflow:hidden; text-overflow:ellipsis; color:var(--brand-dark); }
  .nametag small { font-weight:500; color:var(--muted); margin-right:6px; }

  /* advisor's notes */
  .notes { position:absolute; right:12px; top:12px; width:190px; background:rgba(255,250,243,.95); border:1px solid var(--line); border-radius:10px; padding:10px 12px; font-size:12.5px; }
  .notes h2 { font-size:12px; color:var(--brand-dark); letter-spacing:.08em; margin-bottom:6px; }
  .notes li { list-style:none; display:flex; gap:8px; padding:3px 0; border-top:1px dashed var(--line); align-items:flex-start; }
  .notes li:first-of-type { border-top:none; }
  .notes .k { flex:none; width:16px; height:16px; border-radius:4px; border:1.5px solid #cdb79a; display:grid; place-items:center; font-size:11px; color:#fff; margin-top:2px; }
  .notes li.done .k { background:var(--brand); border-color:var(--brand); }
  .notes .t { color:var(--muted); min-width:0; }
  .notes li.done .t { color:var(--ink); }
  .notes .v { display:block; font-size:11.5px; color:var(--brand-dark); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:140px; }
  @media (max-width:640px) {
    .notes { left:8px; right:8px; top:auto; bottom:8px; width:auto; padding:6px 8px; display:flex; gap:4px; flex-wrap:wrap; background:rgba(255,250,243,.88); }
    .notes h2, .notes .v { display:none; }
    .notes ul { display:flex; gap:4px; flex-wrap:wrap; }
    .notes li { border:none; padding:2px 6px; border-radius:999px; background:#fff; font-size:11.5px; }
    .catwrap { bottom:72px; width:min(170px, 46vw); }
    .frame { display:none; }
  }

  /* dialogue box */
  .dlg { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; background:var(--panel); border-top:3px solid var(--brand); }
  .who { display:flex; align-items:center; gap:8px; padding:10px 16px 0; }
  .who b { background:var(--brand); color:#fff; font-size:12.5px; padding:3px 12px; border-radius:6px; letter-spacing:.05em; }
  .who .sp { flex:1; }
  .who button { font:inherit; font-size:12px; color:var(--muted); background:none; border:1px solid var(--line); border-radius:999px; padding:4px 10px; cursor:pointer; }
  .say { flex:1 1 auto; min-height:0; overflow-y:auto; padding:10px 16px 6px; }
  .you { font-size:13px; color:var(--muted); margin-bottom:6px; }
  .you::before { content:"你："; }
  .line { font-size:16px; line-height:1.7; white-space:pre-wrap; word-break:break-word; }
  .dbg { display:none; font-size:11px; color:var(--muted); font-family:ui-monospace, Menlo, Consolas, monospace; margin-top:8px; }
  .show-dbg .dbg { display:block; }
  .chips { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
  .chip { font:inherit; font-size:14px; color:var(--brand-dark); background:var(--gold-soft); border:1px solid #ead2b2; border-radius:999px; padding:8px 14px; cursor:pointer; }
  .chip:hover { background:#f1dbbd; }
  .dots { display:inline-flex; gap:4px; padding:6px 0; }
  .dots i { width:7px; height:7px; border-radius:50%; background:var(--muted); animation:b 1.2s infinite ease-in-out; }
  .dots i:nth-child(2) { animation-delay:.15s; } .dots i:nth-child(3) { animation-delay:.3s; }
  @keyframes b { 0%,60%,100% { opacity:.3; transform:translateY(0); } 30% { opacity:1; transform:translateY(-3px); } }
  @media (prefers-reduced-motion:reduce) { .dots i { animation:none; opacity:.6; } }
  form { display:flex; gap:8px; padding:10px 12px calc(10px + env(safe-area-inset-bottom)); border-top:1px solid var(--line); background:var(--panel); }
  input { flex:1; min-width:0; font:inherit; font-size:16px; padding:11px 16px; border:1px solid var(--line); border-radius:999px; outline:none; background:#fff; color:var(--ink); }
  input:focus { border-color:var(--brand); }
  form button { font:inherit; font-size:15px; font-weight:600; padding:0 18px; border:none; border-radius:999px; background:var(--brand); color:#fff; cursor:pointer; }
  form button:disabled { opacity:.4; cursor:default; }
  .note { font-size:10.5px; color:var(--muted); text-align:center; padding:0 12px 8px; background:var(--panel); }

  /* full history */
  .hist { position:fixed; inset:0; background:rgba(47,41,36,.45); display:none; align-items:flex-end; justify-content:center; z-index:9; }
  .hist.open { display:flex; }
  .hist .sheet { width:100%; max-width:640px; max-height:80vh; overflow-y:auto; background:var(--panel); border-radius:16px 16px 0 0; padding:16px; display:flex; flex-direction:column; gap:10px; }
  .hist h2 { font-size:15px; display:flex; justify-content:space-between; align-items:center; }
  .hist h2 button { font:inherit; font-size:13px; border:1px solid var(--line); background:none; border-radius:999px; padding:4px 12px; cursor:pointer; }
  .msg { max-width:85%; padding:9px 13px; border-radius:16px; font-size:14.5px; line-height:1.6; white-space:pre-wrap; word-break:break-word; }
  .me { align-self:flex-end; background:var(--brand); color:#fff; border-bottom-right-radius:5px; }
  .bot { align-self:flex-start; background:#fff; border:1px solid var(--line); border-bottom-left-radius:5px; }
  ${CAT_CSS}
</style>
</head>
<body>
<div class="app" id="app">
  <header>
    <div><h1>金霸貓舍 GIMBA CATZ</h1><p>AI 選種顧問・新竹新豐・TICA 註冊貓舍</p></div>
    <div class="sp"></div>
    <button id="resetBtn" type="button">重新開始</button>
  </header>

  <section class="stage" aria-label="依你的偏好畫出的貓咪">
    <div class="shelf s1"></div><div class="shelf s2"></div>
    <div class="frame">GIMBA</div>
    <div class="nametag" id="nametag"><small>你的理想寶寶</small>說說你的喜好，牠會慢慢成形</div>
    <div class="catwrap unknown" id="catwrap"></div>
    <aside class="notes" aria-label="顧問筆記">
      <h2>顧問筆記</h2>
      <ul id="notes"></ul>
    </aside>
  </section>

  <section class="dlg">
    <div class="who"><b>金霸顧問</b><div class="sp"></div><button id="histBtn" type="button">對話紀錄</button></div>
    <div class="say" id="say" aria-live="polite"></div>
    <form id="f"><input id="m" maxlength="500" placeholder="想問什麼都可以…" autocomplete="off" aria-label="輸入訊息"><button id="send">送出</button></form>
    <p class="note">AI 測試版，對話會記錄用於改進。價格與可訂的寶寶以貓舍主人回覆為準。</p>
  </section>
</div>

<div class="hist" id="hist" role="dialog" aria-label="對話紀錄"><div class="sheet" id="histSheet"></div></div>

<script>
${CAT_JS}
var KEY = "gimba-chat-v3";
var GREETING = "你好！我是金霸貓舍的 AI 選種顧問。\\n跟我聊聊你喜歡什麼樣的貓、家裡的狀況，上面這隻貓會慢慢變成你心目中的樣子。";
var STARTERS = ["我想養貓，幫我挑適合的品種", "我喜歡短腿、藍色的", "英短大概多少錢？", "可以去貓舍看貓嗎？"];
var NOTES = [["breed","喜歡的類型"],["color","喜歡的毛色"],["budget","預算"],["home","居住環境"],["experience","養貓經驗"]];
var app = document.getElementById("app"), say = document.getElementById("say");
if (new URLSearchParams(location.search).has("debug")) app.classList.add("show-dbg");
var saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) {}
var newId = function () { return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random(); };
var sessionId = saved.sessionId || newId();
var state = saved.state || null;
var turns = saved.turns || [];
var lastLook = "";
function persist() { try { localStorage.setItem(KEY, JSON.stringify({ sessionId: sessionId, state: state, turns: turns })); } catch (e) {} }

document.getElementById("catwrap").innerHTML = catSVG();
var catSvg = document.querySelector("#catwrap svg");

function slots() { return (state && state.slots) || {}; }
function drawCat(hop) {
  var s = slots(), wrap = document.getElementById("catwrap");
  var known = !!(s.breed || s.color);
  wrap.classList.toggle("unknown", !known);
  var look = JSON.stringify([s.breed, s.color]);
  paint(catSvg, lookFromSlots(s), hop && look !== lastLook);
  lastLook = look;
  document.getElementById("nametag").innerHTML = known
    ? "<small>你的理想寶寶</small>" + esc(lookName(s))
    : "<small>你的理想寶寶</small>說說你的喜好，牠會慢慢成形";
  document.getElementById("notes").innerHTML = NOTES.map(function (n) {
    var v = s[n[0]] || "";
    return '<li class="' + (v ? "done" : "") + '"><span class="k">' + (v ? "✓" : "") + '</span><span class="t">' + n[1] + '<span class="v">' + esc(v) + "</span></span></li>";
  }).join("");
}
function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

function showLine(you, text, dbg, chips) {
  say.innerHTML = "";
  if (you) { var y = document.createElement("div"); y.className = "you"; y.textContent = you; say.appendChild(y); }
  var l = document.createElement("div"); l.className = "line"; l.textContent = text; say.appendChild(l);
  if (dbg) { var d = document.createElement("div"); d.className = "dbg"; d.textContent = dbg; say.appendChild(d); }
  if (chips) {
    var box = document.createElement("div"); box.className = "chips";
    STARTERS.forEach(function (q) { var b = document.createElement("button"); b.type = "button"; b.className = "chip"; b.textContent = q; b.onclick = function () { send(q); }; box.appendChild(b); });
    say.appendChild(box);
  }
  say.scrollTop = 0;
}
function restore() {
  var lastBot = null, lastMe = null;
  for (var i = turns.length - 1; i >= 0; i--) {
    if (!lastBot && turns[i].r === "bot") { lastBot = turns[i]; }
    else if (lastBot && turns[i].r === "me") { lastMe = turns[i]; break; }
  }
  if (lastBot) showLine(lastMe && lastMe.t, lastBot.t, lastBot.d, false);
  else showLine(null, GREETING, null, true);
  drawCat(false);
}
restore();

document.getElementById("resetBtn").onclick = function () { sessionId = newId(); state = null; turns = []; persist(); lastLook = ""; restore(); };
document.getElementById("histBtn").onclick = function () {
  var sh = document.getElementById("histSheet");
  sh.innerHTML = '<h2>對話紀錄<button type="button" id="closeHist">關閉</button></h2>';
  var g = document.createElement("div"); g.className = "msg bot"; g.textContent = GREETING; sh.appendChild(g);
  turns.forEach(function (h) { var d = document.createElement("div"); d.className = "msg " + h.r; d.textContent = h.t; sh.appendChild(d); });
  document.getElementById("hist").classList.add("open");
  document.getElementById("closeHist").onclick = function () { document.getElementById("hist").classList.remove("open"); };
};
document.getElementById("hist").onclick = function (e) { if (e.target.id === "hist") e.currentTarget.classList.remove("open"); };

function send(message) {
  message = message.trim(); if (!message) return;
  var btn = document.getElementById("send"); btn.disabled = true;
  turns.push({ r: "me", t: message });
  say.innerHTML = '<div class="you"></div><span class="dots"><i></i><i></i><i></i></span>';
  say.querySelector(".you").textContent = message;
  fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sessionId, state: state, message: message }) })
    .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
    .then(function (res) {
      var data = res.data;
      if (!res.ok) {
        var why = { session_limit: "這段對話已經很長了，請按「重新開始」。", message_too_long: "訊息太長了，請精簡到 500 字內。", rate_limited: "目前人比較多，請稍後再試。", no_api_key: "顧問暫時休息中，請稍後再試。" }[data.error] || "系統暫時出了點問題，請稍後再試。";
        showLine(message, why, null, false);
      } else {
        state = data.state;
        var d = data.debug, s = d.slots;
        var dbg = "意圖 " + d.intent + "｜流程 " + d.path + "｜" + d.usage.calls + " 次呼叫 " + (d.usage.input + d.usage.output) + " tokens ≈ US$" + d.cost_usd.toFixed(5);
        turns.push({ r: "bot", t: data.reply, d: dbg });
        showLine(message, data.reply, dbg, false);
        drawCat(true);
      }
    })
    .catch(function () { showLine(message, "連線失敗，請檢查網路後再試。", null, false); })
    .then(function () { persist(); btn.disabled = false; });
}
document.getElementById("f").onsubmit = function (e) { e.preventDefault(); var input = document.getElementById("m"); var v = input.value; input.value = ""; send(v); input.focus(); };
</script>
</body>
</html>`;
