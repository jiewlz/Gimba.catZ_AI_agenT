/**
 * 金霸貓舍 AI 選種顧問：對話紀錄接收端
 * 貼進紀錄試算表的「擴充功能 → Apps Script」，在「專案設定 → 指令碼屬性」新增 LOG_SECRET，
 * 再「部署 → 新增部署作業 → 網頁應用程式」，執行身分選「我」，存取權選「所有人」。
 */
const TURN_HEADERS = ['時間', '通路', '對話編號', '第幾輪', '客人訊息', '意圖', '流程', '階段', '品種', '預算', '居住環境', '養貓經驗', '回覆', '模型呼叫次數', '輸入 tokens', '輸出 tokens', '成本 USD'];
const TURN_KEYS = ['time', 'channel', 'session', 'turn', 'message', 'intent', 'path', 'stage', 'breed', 'budget', 'home', 'experience', 'reply', 'calls', 'input_tokens', 'output_tokens', 'cost_usd'];
const LEAD_HEADERS = ['時間', '通路', '對話編號', '稱呼', '聯絡方式', '品種', '預算', '居住環境', '養貓經驗'];
const LEAD_KEYS = ['time', 'channel', 'session', 'name', 'contact', 'breed', 'budget', 'home', 'experience'];

function sheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) sh.appendRow(headers).setFrozenRows(1);
  return sh;
}

// Strings that look like numbers (phone numbers, "8") would lose leading zeros or units; keep them as text.
function asText_(v) {
  return typeof v === 'string' && /^[0-9+\-\s().]+$/.test(v) ? "'" + v : v;
}

function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  const secret = PropertiesService.getScriptProperties().getProperty('LOG_SECRET');
  if (!secret || data.secret !== secret) {
    return ContentService.createTextOutput('forbidden');
  }
  if (data.turn) sheet_('對話紀錄', TURN_HEADERS).appendRow(TURN_KEYS.map(k => asText_(data.turn[k])));
  if (data.lead) sheet_('名單', LEAD_HEADERS).appendRow(LEAD_KEYS.map(k => asText_(data.lead[k])));
  return ContentService.createTextOutput('ok');
}
