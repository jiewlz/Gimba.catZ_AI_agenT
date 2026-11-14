import Anthropic from "@anthropic-ai/sdk";
import { handleMessage, newState, type State } from "./agent";
import { logTurn, costUsd } from "./log";
import { PAGE } from "./page";

export interface Env {
  ANTHROPIC_API_KEY: string;
  MODEL: string;
  LOG_URL?: string;
  LOG_SECRET?: string;
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
      let body: { sessionId?: string; state?: State; message?: string };
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad_json" }, 400);
      }
      const message = (body.message ?? "").trim();
      const sessionId = (body.sessionId ?? "").slice(0, 64) || crypto.randomUUID();
      if (!message) return json({ error: "empty_message" }, 400);
      if (message.length > MAX_MESSAGE_CHARS) return json({ error: "message_too_long", limit: MAX_MESSAGE_CHARS }, 400);
      const state = body.state ?? newState();
      if (state.turn >= MAX_TURNS_PER_SESSION) return json({ error: "session_limit", limit: MAX_TURNS_PER_SESSION }, 429);

      if (!env.ANTHROPIC_API_KEY) return json({ error: "no_api_key" }, 503);
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      try {
        const result = await handleMessage(client, env.MODEL, state, message);
        if (env.LOG_URL && env.LOG_SECRET) {
          ctx.waitUntil(logTurn(env.LOG_URL, env.LOG_SECRET, "web", sessionId, message, result).catch(() => {}));
        }
        return json({
          sessionId,
          reply: result.reply,
          state: result.state,
          debug: { intent: result.intent, path: result.path, slots: result.state.slots, usage: result.usage, cost_usd: costUsd(result) },
        });
      } catch (error) {
        if (error instanceof Anthropic.RateLimitError) return json({ error: "rate_limited" }, 429);
        if (error instanceof Anthropic.AuthenticationError) return json({ error: "bad_api_key" }, 500);
        if (error instanceof Anthropic.APIError) return json({ error: "api_error", status: error.status }, 502);
        console.error(error);
        return json({ error: "internal" }, 500);
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
