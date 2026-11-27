import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import ANALYZE from "../prompts/analyze.md";
import ASK from "../prompts/ask.md";
import RECOMMEND from "../prompts/recommend.md";
import VISIT from "../prompts/visit.md";
import EXISTING from "../prompts/existing.md";
import FOLLOWUP from "../prompts/followup.md";
import MEMBER from "../prompts/member.md";
import ANSWER from "../prompts/answer.md";
import { byTitle, render, sectionsForNeeds, sectionsForQuestion } from "./knowledge";
import { detect, guardReply, type GuardReport } from "./guard";

// Fallback lines when a reply still breaks a rule after one rewrite (unit 8 guardrail)
const SAFE_ASK: Record<string, string> = {
  breed: "想先請教一下，您喜歡哪一種類型的寶寶呢？長腿、短腿、長毛、短毛，或是喜歡的毛色都可以說說看。",
  budget: "方便說一下您大概的預算嗎？這樣我們比較好幫您配對。",
  home: "想了解一下您的居住環境，例如房型、空間大小，家裡有沒有小孩或其他寵物呢？",
  experience: "之前有養過貓嗎？還是這次是第一次養呢？",
};
const SAFE_SIDE = "您問的這部分我請貓舍老闆跟您聊。";
const SAFE_RECOMMEND = "依您的需求，我請貓舍老闆直接幫您挑選比較適合的寶寶，也會跟您說明價格區間和照護重點。";
const SAFE_VISIT =
  "看貓採全預約制，我們會先傳目前可看的貓咪資料與價格區間給您，再約時間，看了不喜歡完全沒關係。貓舍地址是新竹縣新豐鄉明新八街 9 號，週一到週日下午 2 點到晚上 10 點都可以預約看貓。";
const SAFE_EXISTING = "您的問題我已經轉給貓舍老闆。";
const SAFE_FOLLOWUP = "收到，這部分老闆聯繫您時會一起說明。";
const SAFE_MEMBER = "收到，這部分我請老闆直接跟您聯繫。";

// Fixed lines: the flow decides when they appear, never the model.
export const INTRO =
  "您好！我是金霸貓舍的 AI 選種顧問，可以介紹英短、英長、曼赤肯、長毛曼赤肯、小步舞曲的個性、價格區間和看貓流程。想養貓的話跟我說說吧！";
export const LEAD_INVITE =
  "如果想看看目前有哪些寶寶，方便留個稱呼跟聯絡方式嗎？貓舍老闆會直接跟您聯繫。";
export const EXISTING_NOTE = "接貓的實際日期和安排，貓舍老闆會直接跟您聯繫確認。";
export const BLOCKED =
  "這個我沒辦法幫忙喔。我是金霸貓舍的 AI 選種顧問，可以陪您了解英短血系五個品種、價格區間和看貓流程，想養貓的話跟我說說您的狀況吧！";
export const THANKS =
  "收到，謝謝您！我已經把您的需求整理好交給貓舍老闆，老闆會盡快用您留的方式聯繫您。";

const SLOT_KEYS = ["breed", "budget", "home", "experience"] as const;
type SlotKey = (typeof SLOT_KEYS)[number];
const SLOT_LABEL: Record<SlotKey, string> = {
  breed: "想要的品種或類型",
  budget: "預算",
  home: "居住環境（房型、空間、家裡有沒有小孩或其他寵物）",
  experience: "養貓經驗",
};

const Analysis = z.object({
  intent: z.enum(["choose_cat", "other"]),
  breed: z.string(),
  budget: z.string(),
  home: z.string(),
  experience: z.string(),
  name: z.string(),
  contact: z.string(),
  color: z.string(),
  wants_visit: z.boolean(),
  existing_customer: z.boolean(),
  already_home: z.boolean(),
  side_question: z.string(),
  attack: z.boolean(),
});
type Analysis = z.infer<typeof Analysis>;

export type Stage = "idle" | "interview" | "invited" | "done";
export interface Turn {
  role: "user" | "assistant";
  content: string;
}
export interface State {
  stage: Stage;
  slots: Record<SlotKey | "name" | "contact" | "color", string>;
  history: Turn[];
  turn: number;
  member?: boolean; // bought a cat from us: after-sales tone, never sell again (owner's 成交 command or the customer saying so)
  asked?: { slot: string; n: number }; // the need asked last turn and how many turns in a row
  invitedAt?: number; // the turn the lead invite was last added
}
export function newState(): State {
  return { stage: "idle", slots: { breed: "", budget: "", home: "", experience: "", name: "", contact: "", color: "" }, history: [], turn: 0 };
}

export interface Usage {
  calls: number;
  input: number;
  output: number;
}
export interface Result {
  reply: string;
  state: State;
  path: string;
  intent: string;
  usage: Usage;
  guard: GuardReport | null;
  audit?: { flags: string[]; usage: Usage }; // eval only: an independent re-check of what the customer finally sees
}
export interface Options {
  guard?: boolean; // default on; the eval script turns it off to measure the raw replies
  audit?: boolean; // eval only
  quietOk?: boolean; // LINE: the turn may end with no reply (the chat is probably with the owner)
}
// The same need is asked at most twice in a row; then only questions are answered
const ASK_MAX = 2;
// The fixed lead invite comes back at most every few turns, not under every answer
const INVITE_GAP = 3;

const HISTORY_TURNS = 6;
// "bought here" needs words pointing at the cattery, not just "my cat"
const BOUGHT_HERE = /你們|妳們|您們|貴|金霸|這邊|這裡|你家|妳家|貓舍|跟你|跟妳|在你|在妳/;

function addUsage(u: Usage, r: Anthropic.Message) {
  u.calls++;
  u.input += r.usage.input_tokens + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0);
  u.output += r.usage.output_tokens;
}

function textOf(r: Anthropic.Message): string {
  if (r.stop_reason === "refusal") return "這個問題我請貓舍老闆直接回覆您。";
  return r.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
}

function transcript(history: Turn[]): string {
  return history.map((t) => `${t.role === "user" ? "客人" : "顧問"}：${t.content}`).join("\n");
}

export async function handleMessage(client: Anthropic, model: string, prev: State, message: string, opts: Options = {}): Promise<Result> {
  const state: State = structuredClone(prev);
  const usage: Usage = { calls: 0, input: 0, output: 0 };
  state.turn++;

  // 1. Intent + slot extraction in one structured call
  const analysisRes = await client.messages.parse({
    model,
    max_tokens: 1024,
    thinking: { type: "disabled" },
    system: [{ type: "text", text: ANALYZE, cache_control: { type: "ephemeral" } }],
    output_config: { format: zodOutputFormat(Analysis) },
    messages: [
      {
        role: "user",
        content: `<recent_conversation>\n${transcript(state.history)}\n</recent_conversation>\n<current_slots>\n${JSON.stringify(state.slots)}\n</current_slots>\n<latest_message>\n${message}\n</latest_message>`,
      },
    ],
  });
  addUsage(usage, analysisRes);
  const a: Analysis = analysisRes.parsed_output ?? { ...state.slots, intent: "other", wants_visit: false, existing_customer: false, already_home: false, side_question: "", attack: false };
  let guard: GuardReport | null = null;
  let audit: Result["audit"];
  const useGuard = opts.guard !== false;
  /** Unit 8: every model-written reply goes through the guardrail before it is sent. */
  async function checked(draft: string, kb: string, inviteFollows: boolean, safeLine: string): Promise<string> {
    const customer = `${message}\n${Object.values(state.slots).join("\n")}`;
    let out = draft;
    if (useGuard) {
      const g = await guardReply(client, model, draft, { knowledge: kb, customer, inviteFollows, question: message, safeLine }, usage);
      guard = g.report;
      out = g.reply;
    }
    if (opts.audit) {
      const au: Usage = { calls: 0, input: 0, output: 0 };
      const d = await detect(client, model, out, { knowledge: kb, customer, inviteFollows, question: message }, au);
      audit = { flags: [...d.flags, ...d.fixes.map((f) => `需要自動修正：${f}`)], usage: au };
    }
    return out;
  }

  /** Answers this message from the knowledge base with the given prompt; nothing appended. */
  async function answerOnly(system: string, safeLine: string): Promise<string> {
    const kb = render(sectionsForQuestion(a.side_question || message, 3));
    const res = await client.messages.create({
      model,
      max_tokens: 500,
      thinking: { type: "disabled" },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `<recent_conversation>
${transcript(state.history)}
</recent_conversation>
<knowledge>
${kb}
</knowledge>
<latest_message>${message}</latest_message>`,
        },
      ],
    });
    addUsage(usage, res);
    return checked(textOf(res), kb, false, safeLine);
  }

  // Input guardrail: injection, role-play or "I am the owner" tricks get a fixed line and change nothing
  if (a.attack && useGuard) {
    state.history = [...state.history, { role: "user" as const, content: message }, { role: "assistant" as const, content: BLOCKED }].slice(-HISTORY_TURNS * 2);
    return { reply: BLOCKED, state, path: "blocked_input", intent: a.intent, usage, guard: null };
  }

  // Code-level merge: a blank never erases what was already collected; a new value replaces the old one.
  for (const k of [...SLOT_KEYS, "name", "contact", "color"] as const) {
    if (a[k].trim()) state.slots[k] = a[k].trim();
  }

  let reply: string;
  let path: string;

  if (state.stage === "invited" && state.slots.contact) {
    reply = THANKS;
    path = "lead_saved";
    state.stage = "done";
  } else if (state.member || (a.already_home && BOUGHT_HERE.test(message))) {
    // already_home wins over existing_customer: a cat that is already home is after-sales, not a pickup question.
    // The model alone sometimes calls any cat owner "ours": the message has to point at us too.
    // Already part of the family: after-sales tone, no selling, no invite
    state.member = true;
    reply = await answerOnly(MEMBER, SAFE_MEMBER);
    path = "member";
  } else if (a.existing_customer) {
    // Already ordered: answer from the knowledge base, never restart the sales interview
    const exKb = render(sectionsForQuestion(a.side_question || message, 3));
    const exRes = await client.messages.create({
      model,
      max_tokens: 500,
      thinking: { type: "disabled" },
      system: [{ type: "text", text: EXISTING, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `<knowledge>
${exKb}
</knowledge>
<latest_message>${message}</latest_message>`,
        },
      ],
    });
    addUsage(usage, exRes);
    reply = `${await checked(textOf(exRes), exKb, false, SAFE_EXISTING)}

${EXISTING_NOTE}`;
    path = "existing_customer";
  } else if (a.wants_visit && (state.stage === "idle" || state.stage === "interview")) {
    // Wanting to visit is the strongest buying signal: skip the interview and invite right away
    const visitKb = render(byTitle("看貓流程"));
    const visitRes = await client.messages.create({
      model,
      max_tokens: 400,
      thinking: { type: "disabled" },
      system: [{ type: "text", text: VISIT, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `<knowledge>\n${visitKb}\n</knowledge>\n<latest_message>${message}</latest_message>`,
        },
      ],
    });
    addUsage(usage, visitRes);
    reply = `${await checked(textOf(visitRes), visitKb, true, SAFE_VISIT)}\n\n${LEAD_INVITE}`;
    path = "visit";
    state.stage = "invited";
    state.invitedAt = state.turn;
  } else if (state.stage === "done") {
    // Contact already left: answer the question, never interview or invite again
    reply = await answerOnly(FOLLOWUP, SAFE_FOLLOWUP);
    path = "followup";
  } else if (a.intent === "other" && state.stage === "idle") {
    reply = INTRO;
    path = "intro";
  } else if (opts.quietOk && a.intent === "other" && !a.side_question && state.stage === "invited") {
    // Small talk after the invite: on LINE that is usually a chat with the owner
    reply = "";
    path = "quiet_chat";
  } else {
    if (state.stage === "idle") state.stage = "interview";
    const missing = SLOT_KEYS.filter((k) => !state.slots[k]);
    const next = missing[0];
    const askedEnough = state.stage === "interview" && !!next && state.asked?.slot === next && state.asked.n >= ASK_MAX;

    if (askedEnough && !a.side_question && opts.quietOk) {
      // Asked twice already and the customer is talking about something else: stop asking, leave it to the owner
      reply = "";
      path = "quiet_chat";
    } else if (askedEnough && a.side_question) {
      // Asked twice already: answer the question and ask nothing
      reply = await answerOnly(ANSWER, SAFE_SIDE);
      path = "answer_only";
    } else if (missing.length > 0 && state.stage === "interview") {
      // 2. Ask for the first missing need
      const kb = render(sectionsForQuestion(a.side_question));
      const askRes = await client.messages.create({
        model,
        max_tokens: 400,
        thinking: { type: "disabled" },
        system: [{ type: "text", text: ASK, cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: `<recent_conversation>\n${transcript(state.history)}\n客人：${message}\n</recent_conversation>\n<ask_about>${SLOT_LABEL[next]}</ask_about>\n<side_question>${a.side_question}</side_question>\n<knowledge>\n${kb}\n</knowledge>`,
          },
        ],
      });
      addUsage(usage, askRes);
      reply = await checked(textOf(askRes), kb, false, (a.side_question ? SAFE_SIDE : "") + SAFE_ASK[next]);
      path = `ask_${next}`;
      state.asked = { slot: next, n: state.asked?.slot === next ? state.asked.n + 1 : 1 };
    } else {
      // 3. All needs known: recommend from the knowledge base, then the fixed invite
      const kb = render([...new Set([...sectionsForNeeds(state.slots.breed), ...sectionsForQuestion(a.side_question)])]);
      const needs = SLOT_KEYS.map((k) => `${SLOT_LABEL[k]}：${state.slots[k]}`).join("\n");
      const recRes = await client.messages.create({
        model,
        max_tokens: 800,
        thinking: { type: "disabled" },
        system: [{ type: "text", text: RECOMMEND, cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: `<needs>\n${needs}\n</needs>\n<side_question>${a.side_question}</side_question>\n<knowledge>\n${kb}\n</knowledge>\n<latest_message>${message}</latest_message>`,
          },
        ],
      });
      addUsage(usage, recRes);
      // the invite follows the first recommendation; after that it comes back only every few turns
      const invite = state.stage === "interview" || state.invitedAt === undefined || state.turn - state.invitedAt >= INVITE_GAP;
      reply = await checked(textOf(recRes), kb, invite, SAFE_RECOMMEND);
      if (invite) {
        reply += `\n\n${LEAD_INVITE}`;
        state.invitedAt = state.turn;
      }
      path = state.stage === "interview" ? "recommend" : "recommend_again";
      if (state.stage === "interview") state.stage = "invited";
    }
  }

  state.history = [...state.history, { role: "user" as const, content: message }, { role: "assistant" as const, content: reply }].slice(-HISTORY_TURNS * 2);
  return { reply, state, path, intent: a.intent, usage, guard, audit };
}
