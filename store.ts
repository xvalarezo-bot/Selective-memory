// store.ts — storage abstraction + brain topology.
// One MCP surface, three interchangeable backends (sqlite | github | supabase).
// Topology is CONFIG, not architecture: brains are namespaced; actors (claude,
// gpt, ...) bind to a brain. Default: one shared brain, per-actor attribution.

export type Actor = string; // "claude" | "gpt" | "gemini" | ...

export interface MemoryNode {
  id: string;
  parent_id?: string | null;
  summary: string;
  body?: string | null;
  type: "episodic" | "semantic" | "procedural" | "folder" | "self";
  status: "active" | "archived";
  strength: number;
  valence: number;
  volatility_days?: number | null;
  evidence_count: number;
  confidence: number;
  fire_count: number;
  actor: Actor;              // who wrote it (attribution, not ownership)
  origin_body?: string | null; // immutable first version (provenance)
  created_at: string;
  last_fired?: string | null;
}

export interface MemoryCue {
  id: string;
  node_id: string;
  cue_kind: "semantic" | "temporal";
  cue_text: string;
  embedding?: number[] | null;
  weight?: number;
  fires_after?: string | null;
  fires_until?: string | null;
}

export interface MemoryLink {
  from_node: string; to_node: string;
  link_strength: number; speculative: boolean; confirmed_count: number;
}

export interface Tombstone { summary: string; node_type: string; cause: string; died_at: string; }

export interface BrainStore {
  init(): Promise<void>;
  // nodes
  insertNode(n: Omit<MemoryNode, "id" | "created_at" | "status" | "fire_count">): Promise<string>;
  getNode(id: string): Promise<MemoryNode | null>;
  updateNode(id: string, patch: Partial<MemoryNode>): Promise<void>;
  deleteNode(id: string, tombstone: Omit<Tombstone, "died_at">): Promise<void>;
  listNodes(filter: { type?: string[]; status?: string; parentNull?: boolean; limit?: number }): Promise<MemoryNode[]>;
  countActive(): Promise<number>;
  // cues
  insertCue(c: Omit<MemoryCue, "id">): Promise<void>;
  allSemanticCues(): Promise<(MemoryCue & { strength: number; summary: string; node_type: string; node_status: string })[]>;
  dueTemporalCues(now: Date): Promise<{ node_id: string; summary: string; node_type: string; urgency: number }[]>;
  bumpRecall(nodeIds: string[]): Promise<void>;
  deleteCuesFor(nodeId: string): Promise<void>;
  // links
  upsertLink(l: MemoryLink): Promise<void>;
  linksFrom(nodeIds: string[]): Promise<MemoryLink[]>;
  confirmLink(a: string, b: string): Promise<void>;
  decaySpeculativeLinks(factor: number, floor: number): Promise<void>;
  // time
  pulse(actor: Actor): Promise<{ gapSeconds: number; sessionCount: number }>;
  timelineAround(t: Date, windowDays: number): Promise<MemoryNode[]>;
}

// ---------- brain registry ----------
export interface BrainConfig {
  brains: Record<string, {
    backend: "sqlite" | "github" | "supabase";
    options: Record<string, string>; // path / repo+token / url+key
  }>;
  bindings: Record<Actor, string>;   // actor -> brain id
  default_brain: string;
}

import { readFileSync } from "fs";

export function loadConfig(path = process.env.BRAIN_CONFIG ?? "./brain.config.json"): BrainConfig {
  // ${VAR} in any config value is replaced from the environment — secrets
  // (tokens, service keys) live in .env / host secrets, never in the file.
  const raw = readFileSync(path, "utf-8")
    .replace(/\$\{(\w+)\}/g, (_, v) => process.env[v] ?? "");
  return JSON.parse(raw);
}

const cache = new Map<string, BrainStore>();

export async function brainFor(actor: Actor, cfg: BrainConfig): Promise<BrainStore> {
  const brainId = cfg.bindings[actor] ?? cfg.default_brain;
  if (cache.has(brainId)) return cache.get(brainId)!;
  const def = cfg.brains[brainId];
  if (!def) throw new Error(`unknown brain: ${brainId}`);
  let store: BrainStore;
  if (def.backend === "sqlite") {
    const { SqliteStore } = await import("./stores/sqlite.js");
    store = new SqliteStore(def.options.path ?? "./brain.db");
  } else if (def.backend === "github") {
    const { GithubStore } = await import("./stores/github.js");
    store = new GithubStore(def.options.repo, def.options.token, def.options.branch ?? "main");
  } else {
    const { SupabaseStore } = await import("./stores/supabase.js");
    store = new SupabaseStore(def.options.url, def.options.service_key);
  }
  await store.init();
  cache.set(brainId, store);
  return store;
}
