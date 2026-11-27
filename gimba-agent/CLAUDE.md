# 金霸貓舍 AI 選種顧問

這個專案是金霸貓舍（GIMBA CATZ，新竹新豐的 TICA 註冊貓舍）的 AI 選種顧問，也是中央大學「AI 導論」的期末專題（repo：jiewlz/Gimba.catZ_AI_agenT）。客人多半從 Meta 廣告點進來私訊，常在問到價格前後就沒有下文。這個 agent 要照貓舍的業務順序陪客人把需求問清楚、用貓舍自己的資料回答，最後一定邀請客人留下稱呼和聯絡方式，交給貓舍老闆本人接手。

## 架構

一個大腦、多個入口。選貓流程只寫一次（`src/agent.ts`），入口各自轉接：

- 網頁聊天室：`GET /` 與 `POST /api/chat`（單元 6–7，給老師和同學試用）
- LINE 官方帳號：`POST /line/webhook`（單元 9，`src/line.ts`）。先驗 LINE 簽章，馬上回 200，再在背景跑同一個 `handleMessage`、用 reply API 回覆。LINE 沒有瀏覽器存記憶，對話記憶存在 KV（`line:<userId>`，30 天沒講話就忘記）。LINE 沒有「重新開始」按鈕，客人傳 16 字以內、含「重新開始／重來／清除／刪除／忘記我」的訊息就清掉記憶。LINE 上很多是已經買過貓、在跟老闆聊天的老客人，所以：自我介紹只說一次（KV `intro:<userId>`，加好友時也算），之後再聊選貓以外的事就不回、留給老闆；沒在選貓訪談中時，只傳「好／謝謝／辛苦了／👌」這類客套話不回；客人連續快速傳好幾句，等 2.5 秒合成一句只回一次（KV `pend:<userId>`；同一個 webhook 裡的多句也先合併）。
- IG、FB 私訊：之後要接的話照 LINE 的做法加一個入口，不改大腦

執行環境是 Cloudflare Workers，模型是 Claude Haiku 5.5（`claude-haiku-5-5`）。線上網址：https://gimba-agent.gimba-agent.workers.dev（2026-11-14 首次部署）。紀錄試算表：https://docs.google.com/spreadsheets/d/1DXihL4tnGZrNCU0LMCz_3n2l4ZevicRdxRvY_gBKr3Y/edit 。每一輪對話、抽到的需求、token 用量和留下的名單，都透過 `apps-script/Code.gs` 寫進 Google 試算表。

## 業務順序（每一輪）

1. 分析：一次模型呼叫同時做意圖判斷和參數抽取（品種、預算、居住環境、養貓經驗、稱呼、聯絡方式），結構化輸出。
2. 不是來選貓、也不在訪談中：回固定的自我介紹，不呼叫模型。
3. 需求有缺：一次只追問缺的第一項；客人順便問的問題先用一句話回答。
4. 需求問齊：依需求挑出知識庫的相關段落，產生推薦，再由程式接上固定的導流句。
5. 客人留下聯絡方式：寫進名單，回固定的感謝句。
6. 留過聯絡方式之後（stage done）：只回答問題（`prompts/followup.md`），不再訪談、不再邀請。
7. 已經買過的客人（`state.member`）：老客人口吻（`prompts/member.md`），回答照顧問題、健康問題請就醫並由老闆聯繫、不推銷、想再養一隻就轉給老闆。兩種方式標記：客人自己說貓是在金霸買的（分析欄位 already_home），或老闆在 LINE 傳「成交 名字」或「成交 代碼」（KV `member:<userId>`，不會過期）。

Guardrail（單元 8，`src/guard.ts`）：分析時多判斷 attack，注入直接回固定句；模型寫的每一則回覆送出前先過規則、再由檢查員（`prompts/check.md`）逐句比對知識庫，有問題交給修正員（`prompts/rewrite.md`）改寫一次，改寫後再完整檢查一次，還不過就換成該步驟的安全句。網頁的對話記憶用 `STATE_SECRET` 簽章。改 prompt、知識庫或流程後跑 `npm run eval`（本機 `.dev.vars` 要有 `ALLOW_EVAL=1`），被攔下的回覆要人工看過。

排程與通知（單元 9，`src/stats.ts`）：網頁和 LINE 每一輪都把數字累加進 KV 的本週計數（新對話、推薦、名單、檢查結果、費用）。有人留下聯絡方式，馬上 LINE 推播給貓舍老闆（`LINE_OWNER_ID`）；每週一早上 9 點（cron `0 1 * * MON`，UTC）推播上週週報。老闆在 LINE 傳「本週」或「上週」可以隨時看數字。老闆指令（只認 `LINE_OWNER_ID`，按鈕的 postback 也一樣檢查）：「接手 名字」讓顧問對這位客人安靜 3 天（KV `quiet:<userId>`，值是安靜到的時間；客人在 LINE 留下聯絡方式時也會自動安靜 3 天，因為老闆的手動回覆不會送到 webhook，顧問看不到）、「交回 名字」恢復、「成交 名字」標記已購買。名字是客人的 LINE 名稱（Get Profile API，存在 KV `prof:<userId>`，30 天沒講話跟對話一起忘記，7 天重新取一次；取不到就顯示代碼），比對前統一全形半形、大小寫、空白，完全相同優先、再找包含；一位直接執行，多位或找不到就回 Quick Reply 按鈕。只傳「接手」「交回」「成交」列出最近 5 位客人（「交回」只列已接手的），清單在 KV `recent:line`（最多 20 位，不含老闆，客人清除資料時移除）。也可以用代碼：新名單通知裡的 `line-` 開頭雜湊（KV `sess:<code>` 對回 userId）。客人的 LINE 名稱只存在 KV，不寫進試算表。花費警告：單日模型費用第一次超過 `DAILY_COST_ALERT_USD`（wrangler.toml，預設 0.5 美元）就推播 LINE 給老闆（KV `cost:<日期>`）。

導流句和自我介紹是程式裡的固定文字，不交給模型決定，這是前五週測試的結論（模型有內容可講時常忘記導流）。

## 規則（改 prompt、知識庫或程式時都要遵守）

- 在籍名單（目前可訂的貓）和個別售價永遠不放進 repo 或知識庫，repo 是公開的。價格只講公開區間：長腿（英短、英長）4 到 7 萬，短腿（曼赤肯、長毛曼赤肯、小步舞曲）5 到 10 萬，個別報價由貓舍老闆本人回覆。
- 對客人一律稱「貓舍老闆」，不叫「主人」，也不用他／她代稱（性別不在資料裡，`guard.ts` 有規則抓）。
- 合約一律叫「寵物定型化契約書」；寫「定金」，不寫「訂金」。
- 分期不保證過件，只能說「通常都能通過審核」，細節由真人回覆。
- 模型只能用 `knowledge/` 裡的資料替貓舍說話；外部資料和一般常識不能用「我們」的口氣講。
- LINE 的 Channel secret、access token、老闆的 user ID 也一樣只放 Cloudflare secrets。
- API 金鑰和試算表網址只放在 Cloudflare secrets 或本機 `.dev.vars`，絕不寫進程式或 commit。
- 只有使用者明確要求時才推 GitHub 或部署。

## 檔案

- `prompts/`：三個模型呼叫的 system prompt（analyze、ask、recommend），改 prompt 就改這裡。
- `knowledge/`：貓舍知識庫，`##` 一節一個主題。
- `src/`：Worker 程式。`agent.ts` 是業務流程，`knowledge.ts` 挑段落，`log.ts` 寫試算表，`page.ts` 是聊天室網頁。
- `apps-script/Code.gs`：貼進紀錄試算表的 Apps Script，接收紀錄。
- `tests/scenarios.md`：單元 6–7 的測試題。
- `tests/eval.mjs`：單元 8 Guardrail 評測。`tests/line.mjs`：單元 9 LINE 入口的本機測試（用 `.dev.vars` 的 LINE_CHANNEL_SECRET 簽假事件，沒有 access token 時回覆存在 `/api/dev/outbox`，不會真的送出）。`tests/takeover.mjs`：老闆用名字和按鈕接手的本機測試（假名字，profile 由 `/api/dev/profile` 假裝）。`tests/chatter.mjs`：老客人閒聊（自我介紹一次、客套話不回）和連發合併的本機測試。

## 指令

```bash
npm install
npm run dev      # 本機測試，金鑰放在 .dev.vars
npm run check    # TypeScript 型別檢查
npm run deploy   # 部署到 Cloudflare（使用者同意後才跑）
npm run eval     # Guardrail 評測：18 題，關／開各跑兩次（先 npm run dev）
npm run test:line  # LINE 入口、記憶、名單推播、週報排程的本機測試（先 npm run dev）
npm run test:takeover  # 老闆用名字／按鈕接手、交回、成交的本機測試（先 npm run dev）
npm run test:chatter   # 老客人閒聊、客套話、連發合併的本機測試（先 npm run dev）
```
