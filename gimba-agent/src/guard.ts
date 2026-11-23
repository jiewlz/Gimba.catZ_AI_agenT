import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import CHECK from "../prompts/check.md";
import REWRITE from "../prompts/rewrite.md";
import { byTitle, render } from "./knowledge";

// Always counts as grounded: who the cattery is and what it breeds (the writer prompts state this too)
const BASE_FACTS = render(byTitle("關於金霸貓舍"));

// ---------------------------------------------------------------------------
// Unit 8 guardrail: every model-written reply is checked before the customer sees it.
//   1. rules (free, deterministic): auto-fix 訂金 / Markdown; flag meta words, invented amounts,
//      approval guarantees, wrong contract names, pointing to other catteries, a duplicated invite
//   2. grounding check (one cheap model call): sentences that state facts not in the knowledge sections
//   3. one rewrite with the problems listed; if the rewrite still breaks a rule, a fixed safe line
// ---------------------------------------------------------------------------

export interface GuardUsage {
  calls: number;
  input: number;
  output: number;
}
export interface GuardReport {
  flags: string[]; // problems found in the model's first reply
  fixes: string[]; // silent auto-fixes (訂金→定金, Markdown removed)
  action: "pass" | "rewritten" | "fallback";
  original: string;
}

const NUM: Record<string, number> = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnNumber(s: string): number {
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  let total = 0, cur = 0;
  for (const ch of s) {
    if (ch in NUM) cur = NUM[ch];
    else if (ch === "十") { total += (cur || 1) * 10; cur = 0; }
    else if (ch === "百") { total += (cur || 1) * 100; cur = 0; }
    else if (ch === "千") { total += (cur || 1) * 1000; cur = 0; }
  }
  return total + cur;
}
const AMOUNT = /(\d+(?:\.\d+)?|[一二兩三四五六七八九十百千]+)\s*(萬|千元|千塊|元|塊)/g;
/** Every money amount in a text, in NT$. */
export function amounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(AMOUNT)) {
    const n = cnNumber(m[1]);
    out.push(m[2] === "萬" ? n * 10000 : m[2].startsWith("千") ? n * 1000 : n);
  }
  return out;
}

const META = /知識庫|資料庫|knowledge|<\/?\w+>|沒有.{0,20}的資料|沒有(查到|找到|確切的?)資料|system ?prompt|提示詞|我的設定|資料上|資料裡|資料中|手邊的資料|手上.{0,6}資料|沒有可以確認的資料|我不想亂講|我不能亂講|身為(一個)?AI語言模型/i;
const GUARANTEE = /保證.{0,3}(過件|通過|核准|會過)|一定(會)?(過件|通過|核准|會過)|百分之百|100\s*%/;
const WRONG_CONTRACT = /(買賣|飼育|領養|購買)(合約|契約)/;
const OTHER_CATTERY = /(其他|別的|別家)貓舍|有做.{0,12}的貓舍|(選擇|挑選|找)(一[間家])?(有|信譽|合格|正規|專業|可靠).{0,10}貓舍/;
const INVITE = /(留|給|提供).{0,6}(聯絡|LINE|電話|稱呼)|歡迎私訊/;

export interface RuleContext {
  knowledge: string; // the sections the model was given
  customer: string; // the customer's own words (latest message + collected needs)
  inviteFollows: boolean; // the flow appends the fixed invite after this reply
}

/** Auto-fixes what can be fixed safely and returns the remaining problems. */
export function ruleCheck(text: string, ctx: RuleContext): { text: string; fixes: string[]; flags: string[] } {
  const fixes: string[] = [];
  const flags: string[] = [];
  let t = text;
  if (t.includes("訂金")) { t = t.replaceAll("訂金", "定金"); fixes.push("訂金→定金"); }
  const md = t.replace(/\*\*|__|`/g, "").replace(/^\s*(#{1,6}|[-*•]|\d+\.)\s+/gm, "");
  if (md !== t) { t = md.replace(/\n{3,}/g, "\n\n"); fixes.push("去掉 Markdown"); }

  if (META.test(t)) flags.push("內部用詞");
  const allowed = new Set([...amounts(ctx.knowledge), ...amounts(ctx.customer)]);
  const bad = amounts(t).filter((n) => !allowed.has(n));
  if (bad.length) flags.push(`知識庫沒有的金額：${bad.join("、")}`);
  // "「一定會過」這個我不能跟你保證" repeats the customer and refuses: not a guarantee
  // a sentence ending in ？ repeats the customer's question ("那一定會過嗎？"), it does not promise anything
  if ((t.match(/[^。！？\n]+[。！？]?/g) ?? []).some((x) => !/[？?]$/.test(x) && GUARANTEE.test(x) && !/(不能|無法|沒辦法|不敢|不會).{0,4}保證|不保證/.test(x))) flags.push("保證過件或打包票");
  if (WRONG_CONTRACT.test(t)) flags.push("合約名稱錯誤");
  if (OTHER_CATTERY.test(t)) flags.push("叫客人去找別的貓舍");
  if (ctx.inviteFollows && INVITE.test(t)) flags.push("自己邀請留聯絡方式（後面已有固定句）");
  return { text: t, fixes, flags };
}

const Check = z.object({
  problems: z.array(z.object({ sentence: z.string(), why: z.string(), unsupported: z.boolean() })),
});

function add(u: GuardUsage, r: Anthropic.Message) {
  u.calls++;
  u.input += r.usage.input_tokens + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0);
  u.output += r.usage.output_tokens;
}

/** Rules plus the grounding check: what is wrong with this reply, without changing it (except auto-fixes). */
export async function detect(
  client: Anthropic,
  model: string,
  reply: string,
  ctx: RuleContext & { question: string },
  usage: GuardUsage,
): Promise<{ text: string; fixes: string[]; flags: string[] }> {
  const first = ruleCheck(reply, ctx);
  let checkRes;
  try {
    checkRes = await client.messages.parse({
    model,
    max_tokens: 1500,
    thinking: { type: "disabled" },
    system: [{ type: "text", text: CHECK, cache_control: { type: "ephemeral" } }],
    output_config: { format: zodOutputFormat(Check) },
    messages: [
      {
        role: "user",
        content: `<knowledge>
${ctx.knowledge || "（這一輪沒有提供任何段落）"}
</knowledge>
<base_facts>
${BASE_FACTS}
</base_facts>
<customer_message>${ctx.question}</customer_message>
<customer_said_before>
${ctx.customer}
</customer_said_before>
<reply>
${first.text}
</reply>`,
      },
    ],
  });
  } catch (error) {
    // The checker must never take the conversation down: fall back to the rules alone and say so in the log
    console.error("grounding check failed", error);
    return { text: first.text, fixes: first.fixes, flags: [...first.flags, "檢查員失敗，只做了規則檢查"] };
  }
  add(usage, checkRes);
  const grounded = (checkRes.parsed_output?.problems ?? []).filter((p) => p.unsupported && p.sentence.trim());
  return { text: first.text, fixes: first.fixes, flags: [...first.flags, ...grounded.map((p) => `沒有根據：「${p.sentence}」（${p.why}）`)] };
}

/** Runs the whole guardrail on one model-written reply. */
export async function guardReply(
  client: Anthropic,
  model: string,
  reply: string,
  ctx: RuleContext & { question: string; safeLine: string },
  usage: GuardUsage,
): Promise<{ reply: string; report: GuardReport }> {
  const first = await detect(client, model, reply, ctx, usage);
  const fixes = [...first.fixes];
  const flags = first.flags;

  if (flags.length === 0) return { reply: first.text, report: { flags, fixes, action: "pass", original: reply } };

  // 3. one rewrite with the problems spelled out
  const rwRes = await client.messages.create({
    model,
    max_tokens: 600,
    thinking: { type: "disabled" },
    system: [{ type: "text", text: REWRITE, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `<knowledge>\n${ctx.knowledge}\n</knowledge>\n<customer_message>${ctx.question}</customer_message>\n<reply>\n${first.text}\n</reply>\n<problems>\n${flags.map((f) => `- ${f}`).join("\n")}\n</problems>`,
      },
    ],
  });
  add(usage, rwRes);
  const rewritten = rwRes.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  // the rewrite is checked as strictly as the first draft (rules and checker), otherwise a sentence the
  // rewriter kept or added would go out unchecked
  const second = rewritten ? await detect(client, model, rewritten, ctx, usage) : { text: "", fixes: [], flags: ["改寫結果是空的"] };
  fixes.push(...second.fixes.filter((f) => !fixes.includes(f)));
  if (rewritten && second.flags.length === 0) {
    return { reply: second.text, report: { flags, fixes, action: "rewritten", original: reply } };
  }
  return { reply: ctx.safeLine, report: { flags: [...flags, ...second.flags.map((f) => `改寫後仍有：${f}`)], fixes, action: "fallback", original: reply } };
}

// ---------------------------------------------------------------------------
// Conversation memory lives in the browser, so it is signed: a forged history
// ("顧問：英短一隻兩萬") would otherwise be fed back to the model as if we had said it.
// ---------------------------------------------------------------------------
async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function signState<T extends object>(secret: string, state: T): Promise<T & { sig: string }> {
  const { sig: _old, ...body } = state as T & { sig?: string };
  return { ...(body as T), sig: await hmac(secret, JSON.stringify(body)) };
}
export async function verifyState(secret: string, state: unknown): Promise<boolean> {
  if (!state || typeof state !== "object") return false;
  const { sig, ...body } = state as { sig?: string };
  if (typeof sig !== "string") return false;
  const expected = await hmac(secret, JSON.stringify(body));
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
