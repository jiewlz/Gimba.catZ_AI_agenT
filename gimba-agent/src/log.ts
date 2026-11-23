import type { Result } from "./agent";

// Claude Haiku 5.5, prompts under 100K tokens: $0.10 input / $0.50 output per million tokens
const USD_PER_INPUT = 0.1 / 1e6;
const USD_PER_OUTPUT = 0.5 / 1e6;

export function costUsd(r: Result): number {
  return r.usage.input * USD_PER_INPUT + r.usage.output * USD_PER_OUTPUT;
}

/** Sends one row (and a lead row when contact was just saved) to the Apps Script that writes the Google Sheet. */
export async function logTurn(url: string, secret: string, channel: string, sessionId: string, message: string, r: Result) {
  const s = r.state.slots;
  const payload = {
    secret,
    turn: {
      time: new Date().toISOString(),
      channel,
      session: sessionId,
      turn: r.state.turn,
      message,
      intent: r.intent,
      path: r.path,
      stage: r.state.stage,
      breed: s.breed,
      budget: s.budget,
      home: s.home,
      experience: s.experience,
      reply: r.reply,
      calls: r.usage.calls,
      input_tokens: r.usage.input,
      output_tokens: r.usage.output,
      cost_usd: Number(costUsd(r).toFixed(6)),
      guard_action: r.guard ? r.guard.action : "",
      guard_flags: r.guard ? [...r.guard.flags, ...r.guard.fixes].join("；") : "",
      original_reply: r.guard && r.guard.action !== "pass" ? r.guard.original : "",
    },
    lead:
      r.path === "lead_saved"
        ? { time: new Date().toISOString(), channel, session: sessionId, name: s.name, contact: s.contact, breed: s.breed, budget: s.budget, home: s.home, experience: s.experience }
        : null,
  };
  await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}
