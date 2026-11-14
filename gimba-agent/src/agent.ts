import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import ANALYZE from "../prompts/analyze.md";
import ASK from "../prompts/ask.md";
import RECOMMEND from "../prompts/recommend.md";
import VISIT from "../prompts/visit.md";
import EXISTING from "../prompts/existing.md";
import { byTitle, render, sectionsForNeeds, sectionsForQuestion } from "./knowledge";

// Fixed lines: the flow decides when they appear, never the model.
export const INTRO =
  "你好！我是金霸貓舍的 AI 選種顧問，可以幫你了解英短血系五個品種（英短、英長、曼赤肯、長毛曼赤肯、小步舞曲）的個性、價格區間和看貓流程。想養貓的話，跟我說說你的狀況吧！";
export const LEAD_INVITE =
  "如果想看看目前有哪些寶寶，方便留個稱呼跟聯絡方式嗎？貓舍主人會直接跟你聯繫。";
export const EXISTING_NOTE = "接貓的實際日期和安排，貓舍主人會直接跟你聯繫確認。";
export const THANKS =
  "收到，謝謝你！我已經把你的需求整理好交給貓舍主人，他會盡快用你留的方式聯繫你。";

const SLOT_KEYS = ["breed", "budget", "home", "experience"] as const;
type SlotKey = (typeof SLOT_KEYS)[number];
const SLOT_LABEL: Record<SlotKey, string> = {
  breed: "想要的品種或類型（長腿、短腿、長毛、短毛都可以，喜歡的毛色也可以一起說）",
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
  side_question: z.string(),
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
}

const HISTORY_TURNS = 6;

function addUsage(u: Usage, r: Anthropic.Message) {
  u.calls++;
  u.input += r.usage.input_tokens + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0);
  u.output += r.usage.output_tokens;
}

function textOf(r: Anthropic.Message): string {
  if (r.stop_reason === "refusal") return "這個問題我請貓舍主人直接回覆你。";
  return r.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
}

function transcript(history: Turn[]): string {
  return history.map((t) => `${t.role === "user" ? "客人" : "顧問"}：${t.content}`).join("\n");
}

export async function handleMessage(client: Anthropic, model: string, prev: State, message: string): Promise<Result> {
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
  const a: Analysis = analysisRes.parsed_output ?? { ...state.slots, intent: "other", wants_visit: false, existing_customer: false, side_question: "" };

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
  } else if (a.existing_customer) {
    // Already ordered: answer from the knowledge base, never restart the sales interview
    const exRes = await client.messages.create({
      model,
      max_tokens: 500,
      thinking: { type: "disabled" },
      system: [{ type: "text", text: EXISTING, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `<knowledge>
${render(sectionsForQuestion(a.side_question || message, 3))}
</knowledge>
<latest_message>${message}</latest_message>`,
        },
      ],
    });
    addUsage(usage, exRes);
    reply = `${textOf(exRes)}

${EXISTING_NOTE}`;
    path = "existing_customer";
  } else if (a.wants_visit && (state.stage === "idle" || state.stage === "interview")) {
    // Wanting to visit is the strongest buying signal: skip the interview and invite right away
    const visitRes = await client.messages.create({
      model,
      max_tokens: 400,
      thinking: { type: "disabled" },
      system: [{ type: "text", text: VISIT, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `<knowledge>\n${render(byTitle("看貓流程"))}\n</knowledge>\n<latest_message>${message}</latest_message>`,
        },
      ],
    });
    addUsage(usage, visitRes);
    reply = `${textOf(visitRes)}\n\n${LEAD_INVITE}`;
    path = "visit";
    state.stage = "invited";
  } else if (a.intent === "other" && state.stage === "idle") {
    reply = INTRO;
    path = "intro";
  } else {
    if (state.stage === "idle") state.stage = "interview";
    const missing = SLOT_KEYS.filter((k) => !state.slots[k]);

    if (missing.length > 0 && state.stage === "interview") {
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
            content: `<recent_conversation>\n${transcript(state.history)}\n客人：${message}\n</recent_conversation>\n<ask_about>${SLOT_LABEL[missing[0]]}</ask_about>\n<side_question>${a.side_question}</side_question>\n<knowledge>\n${kb}\n</knowledge>`,
          },
        ],
      });
      addUsage(usage, askRes);
      reply = textOf(askRes);
      path = `ask_${missing[0]}`;
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
      reply = `${textOf(recRes)}\n\n${LEAD_INVITE}`;
      path = state.stage === "interview" ? "recommend" : "recommend_again";
      if (state.stage === "interview") state.stage = "invited";
    }
  }

  state.history = [...state.history, { role: "user" as const, content: message }, { role: "assistant" as const, content: reply }].slice(-HISTORY_TURNS * 2);
  return { reply, state, path, intent: a.intent, usage };
}
