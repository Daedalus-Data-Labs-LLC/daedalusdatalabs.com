// Keeps every AI use inside Cloudflare's free daily allowance (10,000 Neurons).
//
// Each Workers AI call is counted, in estimated Neurons, by kind:
//   answer   people asking @Daedalus          may use up to 100% of the budget
//   summary  thread summaries                 stops at 90%, so answers always have room
//   index    knowledge index (embeddings)     stops at 60%, then waits for tomorrow
//   embed    searching the index for an answer, counted with answers
//
// Estimates come from Cloudflare's published per-token prices, at
// $0.011 per 1,000 Neurons. Cloudflare's own count is the one that's enforced;
// these are only used to decide what to skip before hitting it.

export const NEURONS_PER_DOLLAR = 1000 / 0.011;

// $ per million tokens [input, output]. Unknown models use the default.
const PRICES = {
  "@cf/zai-org/glm-4.7-flash": [0.0605, 0.4],
  "@cf/baai/bge-small-en-v1.5": [0.0202, 0],
  default: [0.0605, 0.4],
};

export const PRIORITY_SHARE = { answer: 1, embed: 1, summary: 0.9, index: 0.6 };

export function estimateNeurons(model, inputTokens, outputTokens = 0) {
  const [inp, out] = PRICES[model] ?? PRICES.default;
  return ((inputTokens * inp + outputTokens * out) / 1e6) * NEURONS_PER_DOLLAR;
}

export const estimateTokens = (text) => Math.ceil(String(text ?? "").length / 4);

export const dailyBudget = (env) => Number(env.AI_DAILY_NEURONS ?? 9000);

export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

// Runs a Workers AI model and records what it cost. `record(kind, neurons)`
// defaults to the Brain; code running inside the Brain passes its own.
export async function aiRun(env, model, input, { kind, record } = {}) {
  const out = await env.AI.run(model, input);
  const usage = out?.usage;
  const inputTokens = usage?.prompt_tokens ?? estimateTokens(JSON.stringify(input.messages ?? input.text ?? ""));
  const outputTokens = usage?.completion_tokens ?? estimateTokens(out?.choices?.[0]?.message?.content ?? out?.response ?? "");
  const neurons = estimateNeurons(model, inputTokens, outputTokens);
  const save = record ?? ((k, n) => env.BRAIN && brainCall(env, "usage.record", { kind: k, neurons: n }));
  try {
    await save(kind ?? "answer", neurons);
  } catch (err) {
    console.error("usage record failed:", err);
  }
  return out;
}

// ---------- Brain RPC client ----------

export async function brainCall(env, method, args = {}) {
  if (!env.BRAIN) throw new Error("The Brain isn't configured.");
  const stub = env.BRAIN.get(env.BRAIN.idFromName("brain"));
  const res = await stub.fetch("https://brain/rpc", { method: "POST", body: JSON.stringify({ method, args }) });
  const body = await res.json();
  if (body.error) throw new Error(body.error);
  return body.result;
}
