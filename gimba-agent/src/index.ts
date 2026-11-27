import Anthropic from "@anthropic-ai/sdk";
import { handleMessage, newState, type State } from "./agent";
import { logTurn, costUsd } from "./log";
import { PAGE } from "./page";
import { signState, verifyState } from "./guard";
import { afterTurn, DEV_PROFILES, leadText, lineWebhook, notifyOwner, OUTBOX, weeklyReport } from "./line";

export interface Env {
  ANTHROPIC_API_KEY: string;
  MODEL: string;
  LOG_URL?: string;
  LOG_SECRET?: string;
  STATE_SECRET?: string; // signs the conversation memory kept in the browser
  ALLOW_EVAL?: string; // "1" only in local .dev.vars: lets the eval script switch the guardrail off
  KV: KVNamespace; // LINE conversation memory and weekly counters
  LINE_CHANNEL_SECRET?: string; // checks that a webhook really comes from LINE
  LINE_CHANNEL_ACCESS_TOKEN?: string; // sends replies and pushes; without it (local dev) messages go to OUTBOX
  LINE_OWNER_ID?: string; // the owner's LINE user id: gets new leads and the Monday report
  DAILY_COST_ALERT_USD?: string; // push a LINE alert the first time a day's model cost passes this (wrangler.toml)
}

const MAX_MESSAGE_CHARS = 500;
const MAX_TURNS_PER_SESSION = 30;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      let body: { sessionId?: string; state?: State; message?: string; options?: { guard?: boolean; audit?: boolean; log?: boolean } };
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad_json" }, 400);
      }
      const message = (body.message ?? "").trim();
      const sessionId = (body.sessionId ?? "").slice(0, 64) || crypto.randomUUID();
      if (!message) return json({ error: "empty_message" }, 400);
      if (message.length > MAX_MESSAGE_CHARS) return json({ error: "message_too_long", limit: MAX_MESSAGE_CHARS }, 400);
      // Memory guardrail: a state that was not signed by us (edited or forged in the browser) starts over
      let state = newState();
      let tampered = false;
      if (body.state) {
        if (!env.STATE_SECRET || (await verifyState(env.STATE_SECRET, body.state))) state = body.state;
        else tampered = true;
      }
      if (state.turn >= MAX_TURNS_PER_SESSION) return json({ error: "session_limit", limit: MAX_TURNS_PER_SESSION }, 429);

      if (!env.ANTHROPIC_API_KEY) return json({ error: "no_api_key" }, 503);
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      try {
        const evalMode = env.ALLOW_EVAL === "1";
        const guardOn = !(evalMode && body.options?.guard === false);
        const result = await handleMessage(client, env.MODEL, state, message, { guard: guardOn, audit: evalMode && body.options?.audit === true });
        if (tampered) {
          const g = result.guard ?? { flags: [], fixes: [], action: "pass" as const, original: "" };
          result.guard = { ...g, flags: ["對話記憶簽章不符，已重新開始", ...g.flags] };
        }
        const outState = env.STATE_SECRET ? await signState(env.STATE_SECRET, result.state) : result.state;
        if (!(evalMode && body.options?.log === false)) {
          if (env.LOG_URL && env.LOG_SECRET) ctx.waitUntil(logTurn(env.LOG_URL, env.LOG_SECRET, "web", sessionId, message, result).catch(() => {}));
          ctx.waitUntil(afterTurn(env, "web", result).catch((e) => console.error("stats", e)));
          if (result.path === "lead_saved") ctx.waitUntil(notifyOwner(env, leadText("網頁", result)).catch((e) => console.error("owner push", e)));
        }
        return json({
          sessionId,
          reply: result.reply,
          state: outState,
          debug: { intent: result.intent, path: result.path, slots: result.state.slots, usage: result.usage, cost_usd: costUsd(result), guard: result.guard, audit: result.audit },
        });
      } catch (error) {
        if (error instanceof Anthropic.RateLimitError) return json({ error: "rate_limited" }, 429);
        if (error instanceof Anthropic.AuthenticationError) return json({ error: "bad_api_key" }, 500);
        if (error instanceof Anthropic.APIError) return json({ error: "api_error", status: error.status }, 502);
        console.error(error);
        return json({ error: "internal" }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/line/webhook") return lineWebhook(request, env, ctx);

    // local tests only: what would have been sent to LINE
    if (env.ALLOW_EVAL === "1" && url.pathname === "/api/dev/outbox") {
      if (request.method === "DELETE") OUTBOX.length = 0;
      return json(OUTBOX);
    }
    // local tests only: what LINE's profile API would answer for a fake user ("!fail" = an API error)
    if (env.ALLOW_EVAL === "1" && request.method === "POST" && url.pathname === "/api/dev/profile") {
      const { userId, name } = (await request.json()) as { userId: string; name: string };
      DEV_PROFILES.set(userId, name);
      return json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  },

  // Cron (wrangler.toml): Monday 01:00 UTC = 09:00 Taiwan
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(weeklyReport(env));
  },
};
