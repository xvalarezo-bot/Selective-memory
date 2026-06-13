// server.ts — the brain's MCP surface. One server, any backend, any AI.
//
// RENTED COGNITION: the brain owns storage, math, time, and decay — it has NO
// LLM key. Thinking is done by whichever AI is connected: tools that need
// extraction/consolidation return a PROMPT for the connected model to execute,
// plus a *_commit tool to submit the JSON back. Claude, GPT, Gemini — whoever
// is plugged in does the dreaming. Your memory doesn't care who the cortex is.
//
// Run:  npx tsx server.ts            (HTTP on $PORT, default 3111 — for
//                                      Claude/GPT custom connectors)
//       MCP_HTTP=stdio npx tsx server.ts  (stdio, for local MCP clients)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";
import { loadConfig, brainFor, type BrainStore } from "./store.js";
import { embed, cosine } from "./embeddings.js";
import { oauthRouter } from "./oauth.js";

const cfg = loadConfig();
const FIRE_THRESHOLD = 0.78, MAX_FIRES = 5, MATURITY = 2000, MIN_PLASTICITY = 0.15;
const PAIN_VALENCE = -0.5, PAIN_FLOOR = 0.4, DECAY = 0.98, DELETE_FLOOR = 0.1;

const sessionWarmth = new Map<string, number>(); // nodeId -> threshold drop

async function plasticity(store: BrainStore) {
  return Math.max(MIN_PLASTICITY, 1 - (await store.countActive()) / MATURITY);
}
function age(iso: string) {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
  return d > 60 ? `${Math.floor(d / 30)} months ago` : d > 13 ? `${Math.floor(d / 7)} weeks ago`
       : d > 1 ? `${d} days ago` : "recently";
}
function freshness(conf: number, iso: string, vol?: number | null) {
  if (!vol) return { eff: conf, stale: false };
  const eff = conf * Math.pow(0.5, ((Date.now() - new Date(iso).getTime()) / 864e5) / vol);
  return { eff, stale: eff < conf * 0.5 };
}

function createServer(): McpServer {
const server = new McpServer({ name: "selective-memory-brain", version: "1.0.0" });

// ---------- WAKE ----------
server.tool("brain_wake",
  "Call ONCE at the start of every conversation. Grounds the brain in time " +
  "(date, gap since last session) and returns the self-model. actor = your platform name.",
  { actor: z.string() },
  async ({ actor }) => {
    const store = await brainFor(actor, cfg);
    const { gapSeconds, sessionCount } = await store.pulse(actor);
    const selfNodes = await store.listNodes({ type: ["self"], status: "active", limit: 1 });
    const gapH = gapSeconds / 3600;
    const gap = gapH > 48 ? `${Math.round(gapH / 24)} days` : `${Math.round(gapH)} hours`;
    return { content: [{ type: "text", text:
      `now: ${new Date().toISOString()} | last awake: ${gap} ago | session #${sessionCount} (${actor})\n` +
      `self-model:\n${selfNodes[0]?.body ?? "(newborn — no self-model yet)"}` }] };
  });

// ---------- SWEEP (recall) ----------
server.tool("brain_sweep",
  "Call with each user message. Passive cue sweep: returns memories the message " +
  "REMINDS the brain of (associative, includes clock-fired deadlines). Cheap; call liberally.",
  { actor: z.string(), message: z.string() },
  async ({ actor, message }) => {
    const store = await brainFor(actor, cfg);
    const p = await plasticity(store);
    const fireAt = FIRE_THRESHOLD - p * 0.15;
    const qe = await embed(message);

    const cues = await store.allSemanticCues();
    const fired = new Map<string, any>();
    for (const c of cues) {
      if (!c.embedding) continue;
      const warmth = sessionWarmth.get(c.node_id) ?? 0;
      const score = cosine(qe, c.embedding) * (c.weight ?? 1) * c.strength;
      if (score > fireAt - warmth && (!fired.has(c.node_id) || fired.get(c.node_id).score < score))
        fired.set(c.node_id, { node_id: c.node_id, summary: c.summary, type: c.node_type, score });
    }
    const top = [...fired.values()].sort((a, b) => b.score - a.score).slice(0, MAX_FIRES);

    for (const d of await store.dueTemporalCues(new Date()))
      if (!top.find(f => f.node_id === d.node_id))
        top.push({ ...d, score: 1, prospective: true });

    if (!top.length) return { content: [{ type: "text", text: "(nothing recalled)" }] };

    // spreading activation + reconsolidation + dream-link confirmation
    const ids = top.map(f => f.node_id);
    for (const l of await store.linksFrom(ids))
      sessionWarmth.set(l.to_node, Math.max(sessionWarmth.get(l.to_node) ?? 0, l.link_strength * 0.1));
    await store.bumpRecall(ids);
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) await store.confirmLink(ids[i], ids[j]);

    const lines = await Promise.all(top.map(async f => {
      const n = await store.getNode(f.node_id);
      if (!n) return "";
      let tag = ` (${age(n.created_at)}`;
      if (n.type === "semantic") {
        const fr = freshness(n.confidence, n.created_at, n.volatility_days);
        tag += `, confidence ${fr.eff.toFixed(2)}${fr.stale ? ", STALE — verify" : ""}`;
      }
      tag += `, via ${n.actor})`;
      return `- [${n.type}]${f.prospective ? " [DUE]" : ""} ${n.summary}${tag}`;
    }));
    return { content: [{ type: "text", text: lines.filter(Boolean).join("\n") }] };
  });

// ---------- DEEP RECALL ----------
server.tool("brain_recall_deep",
  "Load the full body of a recalled memory (use the summary text to find it).",
  { actor: z.string(), node_id: z.string() },
  async ({ actor, node_id }) => {
    const store = await brainFor(actor, cfg);
    const n = await store.getNode(node_id);
    if (!n) return { content: [{ type: "text", text: "(not found)" }] };
    const drift = n.origin_body && n.body !== n.origin_body
      ? `\n--- ORIGINAL (immutable) ---\n${n.origin_body}` : "";
    return { content: [{ type: "text", text: `${n.body ?? n.summary}${drift}` }] };
  });

// ---------- WRITE (two-phase: brain rents the AI's cognition) ----------
server.tool("brain_write_begin",
  "Call at the END of a conversation. Returns the extraction prompt: YOU perform " +
  "the extraction on the conversation, then submit the JSON via brain_write_commit.",
  { actor: z.string() },
  async ({ actor }) => {
    const store = await brainFor(actor, cfg);
    const p = await plasticity(store);
    return { content: [{ type: "text", text:
      `Extract memories from this conversation. Keep items with salience >= ${(0.5 * (1 - p * 0.8)).toFixed(2)}.\n` +
      `Rules: cues = 3-6 DISTINCTIVE phrases (proper nouns, rare terms, dates — never generic words). ` +
      `valence -1..1 (failures/burned-hand lessons <= -0.7). volatility_days = fact half-life or null if timeless. ` +
      `temporal = {fires_after, fires_until} ISO dates for any deadline/intention. ` +
      `type = episodic|semantic|procedural.\n` +
      `Then call brain_write_commit with JSON:\n` +
      `{"memories":[{"summary":"","body":"","type":"","salience":0.0,"valence":0.0,` +
      `"volatility_days":null,"cues":[""],"links":[0],"temporal":null}]}` }] };
  });

server.tool("brain_write_commit",
  "Submit extracted memories (JSON string from brain_write_begin's instructions).",
  { actor: z.string(), memories_json: z.string() },
  async ({ actor, memories_json }) => {
    const store = await brainFor(actor, cfg);
    let ms: any[] = [];
    try { ms = JSON.parse(memories_json).memories ?? []; }
    catch { return { content: [{ type: "text", text: "invalid JSON" }] }; }
    const ids: string[] = [];
    for (const m of ms) {
      const id = await store.insertNode({
        summary: m.summary, body: m.body || null,
        type: ["episodic","semantic","procedural"].includes(m.type) ? m.type : "episodic",
        strength: m.salience ?? 0.5, valence: m.valence ?? 0,
        volatility_days: m.volatility_days ?? null, actor,
        evidence_count: 1, confidence: 0.5,
      });
      ids.push(id);
      for (const cue of (m.cues ?? []).slice(0, 6))
        await store.insertCue({ node_id: id, cue_kind: "semantic", cue_text: cue, embedding: await embed(cue) });
      if (m.temporal?.fires_after)
        await store.insertCue({ node_id: id, cue_kind: "temporal", cue_text: `due: ${m.summary}`,
          fires_after: m.temporal.fires_after, fires_until: m.temporal.fires_until ?? null });
    }
    for (let i = 0; i < ms.length; i++)
      for (const j of ms[i].links ?? [])
        if (ids[i] && ids[j] && i !== j)
          await store.upsertLink({ from_node: ids[i], to_node: ids[j],
            link_strength: 0.5, speculative: false, confirmed_count: 0 });
    return { content: [{ type: "text", text: `stored ${ids.length} memories (actor: ${actor})` }] };
  });

// ---------- SLEEP (decay here; dreaming rented from the connected AI) ----------
server.tool("brain_sleep",
  "Run the maintenance cycle (decay, pain floors, tombstones, speculative-link decay). " +
  "Returns a DREAM prompt: you may perform it and submit via brain_dream_commit.",
  { actor: z.string() },
  async ({ actor }) => {
    const store = await brainFor(actor, cfg);
    const nodes = await store.listNodes({ status: "active", limit: 10000 });
    const weekAgo = Date.now() - 7 * 864e5;
    let decayed = 0, deleted = 0;
    for (const n of nodes) {
      if (n.type === "self" || n.type === "folder") continue;
      if (n.last_fired && new Date(n.last_fired).getTime() > weekAgo) continue;
      const persistence = Math.min(n.fire_count, 50) / 50;
      let s = n.strength * (DECAY + (1 - DECAY) * persistence * 0.9);
      if (n.valence <= PAIN_VALENCE) s = Math.max(s, PAIN_FLOOR);
      if (s < DELETE_FLOOR) {
        await store.deleteNode(n.id, { summary: n.summary, node_type: n.type, cause: "decay" });
        deleted++;
      } else { await store.updateNode(n.id, { strength: s }); decayed++; }
    }
    await store.decaySpeculativeLinks(0.9, 0.05);

    const sample = nodes.filter(n => ["semantic","episodic"].includes(n.type))
      .sort(() => Math.random() - 0.5).slice(0, 16);
    const pairs = [];
    for (let i = 0; i + 1 < sample.length; i += 2)
      pairs.push({ a_id: sample[i].id, a: sample[i].summary, b_id: sample[i+1].id, b: sample[i+1].summary });

    // CONSOLIDATION candidates: recent episodic + semantic claims for merge /
    // corroboration / contradiction review (rented cognition, like dreaming).
    const recent = nodes
      .filter(n => ["episodic", "semantic"].includes(n.type))
      .slice(0, 60)
      .map(n => ({ id: n.id, type: n.type, summary: n.summary,
                   evidence: n.evidence_count, at: n.created_at }));

    // SELF-MODEL refresh inputs: current model + recent durable learnings.
    const selfNode = (await store.listNodes({ type: ["self"], status: "active", limit: 1 }))[0];
    const learnings = nodes
      .filter(n => ["semantic", "procedural"].includes(n.type))
      .slice(0, 30).map(n => n.summary);

    return { content: [{ type: "text", text:
      `sleep done: ${decayed} decayed, ${deleted} forgotten (tombstoned).\n\n` +
      `Now perform up to three maintenance tasks and submit each via its commit tool:\n\n` +
      `1. CONSOLIDATE — review these nodes. Merge genuinely redundant episodics into one ` +
      `durable semantic claim; mark episodes that re-confirm an existing semantic claim as ` +
      `corroborations; flag pairs of semantic claims that cannot both be true. Be strict. ` +
      `Submit via brain_consolidate_commit as {"merges":[{"ids":["..."],"semantic_summary":"",` +
      `"semantic_body":"","cues":["3-6 DISTINCTIVE phrases"]}],"corroborations":[{"claim_id":"","supported_by":["..."]}],` +
      `"contradictions":[{"a_id":"","b_id":""}]}\n` +
      JSON.stringify(recent) + `\n\n` +
      `2. SELF-MODEL — merge the current self-model with recent learnings into <=20 lines: ` +
      `identity, who it serves, recurring domains, learned preferences, open threads. ` +
      `Submit via brain_self_commit as {"body":"..."}.\n` +
      `CURRENT SELF-MODEL:\n${selfNode?.body ?? "(newborn — none yet)"}\n` +
      `RECENT LEARNINGS:\n${learnings.map(l => "- " + l).join("\n") || "(none yet)"}\n\n` +
      `3. DREAM (optional) — for each pair, is there a NON-OBVIOUS structural connection ` +
      `(same problem shape, transferable lesson)? Be strict — most have none. ` +
      `Submit hits via brain_dream_commit as {"connections":[{"a_id":"","b_id":""}]}.\n` +
      JSON.stringify(pairs) }] };
  });

// ---------- CONSOLIDATE (commit phase) ----------
server.tool("brain_consolidate_commit",
  "Submit consolidation results from brain_sleep (merges, corroborations, contradictions).",
  { actor: z.string(), consolidation_json: z.string() },
  async ({ actor, consolidation_json }) => {
    const store = await brainFor(actor, cfg);
    let plan: { merges?: { ids: string[]; semantic_summary: string; semantic_body: string; cues?: string[] }[];
                corroborations?: { claim_id: string; supported_by: string[] }[];
                contradictions?: { a_id: string; b_id: string }[] } = {};
    try { plan = JSON.parse(consolidation_json); }
    catch { return { content: [{ type: "text", text: "invalid JSON" }] }; }
    const confFor = (ev: number) => Math.min(0.99, 1 - 1 / (1 + ev * 0.5));
    let merged = 0, corroborated = 0, resolved = 0;

    // MERGES: episodes graduate into one durable semantic claim; originals archived.
    for (const m of plan.merges ?? []) {
      const id = await store.insertNode({
        summary: m.semantic_summary, body: m.semantic_body || null, type: "semantic",
        strength: 1.0, valence: 0, actor,
        evidence_count: m.ids.length, confidence: confFor(m.ids.length),
      });
      for (const cue of (m.cues ?? []).slice(0, 6))
        await store.insertCue({ node_id: id, cue_kind: "semantic", cue_text: cue,
          embedding: await embed(cue), weight: 1.0 });
      for (const oldId of m.ids) {
        await store.updateNode(oldId, { status: "archived" });
        await store.deleteCuesFor(oldId); // archived memories can never fire
        await store.upsertLink({ from_node: id, to_node: oldId,
          link_strength: 0.3, speculative: false, confirmed_count: 0 });
      }
      merged++;
    }

    // CORROBORATIONS: re-confirmed claims gain evidence -> "I know", not "I think".
    for (const c of plan.corroborations ?? []) {
      const n = await store.getNode(c.claim_id);
      if (!n) continue;
      const ev = n.evidence_count + c.supported_by.length;
      await store.updateNode(c.claim_id, { evidence_count: ev, confidence: confFor(ev) });
      corroborated++;
    }

    // CONTRADICTIONS: evidence decides, not recency; ties fall to newest.
    for (const c of plan.contradictions ?? []) {
      const a = await store.getNode(c.a_id), b = await store.getNode(c.b_id);
      if (!a || !b) continue;
      let winner, loser;
      if (Math.abs(a.evidence_count - b.evidence_count) >= 2)
        [winner, loser] = a.evidence_count > b.evidence_count ? [a, b] : [b, a];
      else
        [winner, loser] = a.created_at > b.created_at ? [a, b] : [b, a];
      await store.updateNode(loser.id, { status: "archived" });
      await store.deleteCuesFor(loser.id);
      // Winner pays a confidence dent for having been contradicted at all.
      await store.updateNode(winner.id, {
        confidence: Math.max(0.3, confFor(winner.evidence_count) - 0.1) });
      resolved++;
    }
    return { content: [{ type: "text", text:
      `consolidated: ${merged} merges, ${corroborated} corroborations, ${resolved} contradictions resolved` }] };
  });

// ---------- SELF-MODEL (commit phase) ----------
server.tool("brain_self_commit",
  "Submit the refreshed self-model from brain_sleep as {\"body\":\"...\"}.",
  { actor: z.string(), self_json: z.string() },
  async ({ actor, self_json }) => {
    const store = await brainFor(actor, cfg);
    let body = "";
    try { body = JSON.parse(self_json).body ?? ""; }
    catch { return { content: [{ type: "text", text: "invalid JSON" }] }; }
    if (!body.trim()) return { content: [{ type: "text", text: "empty self-model, ignored" }] };
    const existing = (await store.listNodes({ type: ["self"], status: "active", limit: 1 }))[0];
    if (existing) {
      await store.updateNode(existing.id, { body });
    } else {
      await store.insertNode({
        summary: "Self-model: identity, purpose, learned patterns", body,
        type: "self", strength: 1.0, valence: 0, actor,
        evidence_count: 1, confidence: 0.5 });
    }
    return { content: [{ type: "text", text:
      existing ? "self-model reconsolidated" : "self-model born — brain_wake will return it from now on" }] };
  });

server.tool("brain_dream_commit",
  "Submit dream connections found during brain_sleep.",
  { actor: z.string(), connections_json: z.string() },
  async ({ actor, connections_json }) => {
    const store = await brainFor(actor, cfg);
    let cs: any[] = [];
    try { cs = JSON.parse(connections_json).connections ?? []; } catch { return { content: [{ type: "text", text: "invalid JSON" }] }; }
    for (const c of cs)
      await store.upsertLink({ from_node: c.a_id, to_node: c.b_id,
        link_strength: 0.2, speculative: true, confirmed_count: 0 });
    return { content: [{ type: "text", text: `planted ${cs.length} speculative links — reality will grade them` }] };
  });

// ---------- TIMELINE ----------
server.tool("brain_timeline",
  "Chronesthesia: what was happening around a date (ISO).",
  { actor: z.string(), around: z.string(), window_days: z.number().default(7) },
  async ({ actor, around, window_days }) => {
    const store = await brainFor(actor, cfg);
    const ns = await store.timelineAround(new Date(around), window_days);
    return { content: [{ type: "text", text:
      ns.map(n => `${n.created_at.slice(0,10)} [${n.type}] ${n.summary}`).join("\n") || "(empty window)" }] };
  });

return server;
}

// ---------- transport ----------
// HTTP (default): for remote MCP connectors (Claude/GPT mobile, Cowork, etc).
// Each request gets a fresh server instance — required for stateless mode.
// Set MCP_HTTP=stdio to run as a local stdio server instead.
if (process.env.MCP_HTTP === "stdio") {
  const server = createServer();
  const t = new StdioServerTransport();
  await server.connect(t);
} else {
  const PORT = Number(process.env.PORT) || 3000;
  const app = createMcpExpressApp({ host: "0.0.0.0" });

  // OAuth 2.1 + PKCE routes (discovery, register, authorize, token)
  app.use(oauthRouter);

  app.get("/", (_req, res) => {
    res.type("text/plain").send("selective-memory-brain: MCP server running. POST /mcp");
  });

  // Optional shared-secret gate. If BRAIN_ACCESS_KEY is set, requests to /mcp must
  // include it as ?key=..., X-Brain-Key header, or Authorization: Bearer <key>.
  const ACCESS_KEY = process.env.BRAIN_ACCESS_KEY;
  if (ACCESS_KEY) {
    app.use("/mcp", (req, res, next) => {
      const bearer = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "") || undefined;
      const key = (req.query.key as string | undefined) ?? req.header("x-brain-key") ?? bearer;
      if (key !== ACCESS_KEY) {
        res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
        return;
      }
      next();
    });
  }

  app.post("/mcp", async (req, res) => {
    const server = createServer();
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => { transport.close(); server.close(); });
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  });

  app.listen(PORT, () => console.log(`brain MCP server listening on :${PORT} (POST /mcp)`));
}
