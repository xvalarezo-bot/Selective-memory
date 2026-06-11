import { brainFor, loadConfig } from "./store.js";

const cfg = loadConfig();
const store = await brainFor("claude", cfg);
await store.init();

async function embed(text: string): Promise<number[]> {
  try {
    const mod = await import("./embeddings.js");
    return await mod.embed(text);
  } catch {
    console.log("(fallback embedding — @xenova/transformers unavailable here)");
    const v = new Array(64).fill(0);
    for (const ch of text.toLowerCase()) v[ch.charCodeAt(0) % 64] += 1;
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map(x => x / norm);
  }
}
function cosine(a: number[], b: number[]) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

console.log("Writing the brain's first memory...");
const id = await store.insertNode({
  summary: "XV's test cue is 'salt water taffy'",
  body: "Birth-test memory: planted to verify cue-based recall end to end.",
  type: "episodic", strength: 1.0, valence: 0,
  actor: "claude", evidence_count: 1, confidence: 0.5,
});
console.log("node id:", id);

const cueText = "salt water taffy";
await store.insertCue({ node_id: id, cue_kind: "semantic", cue_text: cueText, embedding: await embed(cueText), weight: 1.0 });
console.log("cue planted.");

const cues = await store.allSemanticCues();
async function score(msg: string) {
  const qe = await embed(msg);
  let best = 0;
  for (const c of cues) if (c.embedding && c.embedding.length === qe.length) best = Math.max(best, cosine(qe, c.embedding) * (c.weight ?? 1) * c.strength);
  return best;
}

const hit = await score("I went to the boardwalk and bought salt water taffy");
const miss = await score("What's the weather in Cuenca tomorrow?");
console.log("matching message score:", hit.toFixed(3));
console.log("unrelated message score:", miss.toFixed(3));
console.log(hit > miss ? "recall is associative" : "check embeddings");
