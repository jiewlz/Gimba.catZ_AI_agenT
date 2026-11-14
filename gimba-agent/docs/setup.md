# 上線步驟

## 一、你要先準備的帳號

1. Anthropic API 金鑰：到 https://platform.claude.com 註冊、綁卡，建一把 API key。建議在 Console 設每月花費上限（例如 5 美元）。
2. Cloudflare 帳號：到 https://dash.cloudflare.com 免費註冊，不用綁卡。

## 二、接上紀錄試算表（約 3 分鐘）

試算表「金霸貓舍 AI 顧問紀錄」已經建好，有「對話紀錄」和「名單」兩個分頁。

1. 打開試算表，上方選單「擴充功能 → Apps Script」。
2. 把 `apps-script/Code.gs` 的內容整段貼進去，取代原本的程式，存檔。
3. 左邊齒輪「專案設定」→ 最下面「指令碼屬性」→ 新增屬性：名稱 `LOG_SECRET`，值是 `.dev.vars` 裡 `LOG_SECRET=` 後面那串。
4. 右上「部署 → 新增部署作業」→ 類型選「網頁應用程式」→ 執行身分「我」、誰可以存取「所有人」→ 部署，照提示授權。
5. 複製「網頁應用程式網址」給 Claude，它會填進 `LOG_URL`。

## 三、本機測試

API 金鑰交給 Claude 的方式：自己打開 `.dev.vars`，把金鑰貼在 `ANTHROPIC_API_KEY=` 後面存檔（不要貼在對話裡）。之後 `npm run dev` 就能在 http://localhost:8787 試聊。

## 四、部署

本機測過沒問題，Claude 會在你同意後執行 `wrangler login`（開瀏覽器登入 Cloudflare）、把三個 secret 傳上去、`npm run deploy`，拿到一個 `https://gimba-agent.<你的帳號>.workers.dev` 網址，老師和同學點開就能試。
