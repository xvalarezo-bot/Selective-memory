// embeddings.ts — on-device embeddings via transformers.js (MiniLM, ~25MB,
// downloads once, runs locally). No API key; nothing leaves the device.
// Set EMBED_PROVIDER=openai to use a remote provider instead (server deployments).

let pipe: any = null;

export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 384); // MiniLM=384

export async function embed(text: string): Promise<number[]> {
  if (process.env.EMBED_PROVIDER === "openai") {
    const r = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json",
                 Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
    });
    return (await r.json()).data[0].embedding;
  }
  if (!pipe) {
    const { pipeline } = await import("@xenova/transformers");
    pipe = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  }
  const out = await pipe(text, { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
