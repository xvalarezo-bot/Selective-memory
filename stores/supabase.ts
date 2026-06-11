// stores/supabase.ts — thin adapter over the existing schema.sql deployment.
// Use for always-on, multi-device, large-corpus brains.

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { BrainStore, MemoryLink, Actor } from "../store.js";

export class SupabaseStore implements BrainStore {
  private db: SupabaseClient;
  constructor(url: string, key: string) { this.db = createClient(url, key); }
  async init() {}

  async insertNode(n: any) {
    let origin_id: string | null = null;
    if (n.body) {
      const { data } = await this.db.from("memory_origins").insert({ body: n.body }).select("id").single();
      origin_id = data?.id ?? null;
    }
    const { data } = await this.db.from("memory_nodes").insert({
      parent_id: n.parent_id ?? null, summary: n.summary, body: n.body ?? null,
      type: n.type, strength: n.strength, valence: n.valence ?? 0,
      volatility_days: n.volatility_days ?? null, evidence_count: n.evidence_count ?? 1,
      confidence: n.confidence ?? 0.5, origin_id,
    }).select("id").single();
    return data!.id;
  }
  async getNode(id: string) {
    const { data } = await this.db.from("memory_nodes").select("*").eq("id", id).single();
    return data as any;
  }
  async updateNode(id: string, patch: any) {
    delete patch.origin_body;
    await this.db.from("memory_nodes").update(patch).eq("id", id);
  }
  async deleteNode(id: string, t: any) {
    await this.db.from("memory_tombstones").insert({ summary: t.summary, node_type: t.node_type, cause: t.cause });
    await this.db.from("memory_nodes").delete().eq("id", id);
  }
  async listNodes(f: any) {
    let q = this.db.from("memory_nodes").select("*");
    if (f.status) q = q.eq("status", f.status);
    if (f.type?.length) q = q.in("type", f.type);
    if (f.parentNull) q = q.is("parent_id", null);
    const { data } = await q.order("created_at", { ascending: false }).limit(f.limit ?? 100);
    return (data ?? []) as any;
  }
  async countActive() {
    const { count } = await this.db.from("memory_nodes")
      .select("id", { count: "exact", head: true }).eq("status", "active");
    return count ?? 0;
  }
  async insertCue(c: any) { await this.db.from("memory_cues").insert(c); }
  async allSemanticCues() {
    const { data } = await this.db.from("memory_cues")
      .select("*, memory_nodes!inner(strength, summary, type, status)")
      .eq("cue_kind", "semantic").eq("memory_nodes.status", "active");
    return (data ?? []).map((r: any) => ({
      ...r, strength: r.memory_nodes.strength, summary: r.memory_nodes.summary,
      node_type: r.memory_nodes.type, node_status: r.memory_nodes.status,
      embedding: typeof r.embedding === "string" ? JSON.parse(r.embedding) : r.embedding,
    }));
  }
  async dueTemporalCues(_now: Date) {
    const { data } = await this.db.rpc("due_temporal_cues");
    return (data ?? []) as any;
  }
  async bumpRecall(ids: string[]) { await this.db.rpc("reconsolidate_nodes", { node_ids: ids }); }
  async deleteCuesFor(id: string) { await this.db.from("memory_cues").delete().eq("node_id", id); }
  async upsertLink(l: MemoryLink) { await this.db.from("memory_links").upsert(l); }
  async linksFrom(ids: string[]) {
    const { data } = await this.db.from("memory_links").select("*").in("from_node", ids);
    return (data ?? []) as any;
  }
  async confirmLink(a: string, b: string) {
    await this.db.from("memory_links")
      .update({ speculative: false, link_strength: 0.6, confirmed_count: 1 })
      .eq("speculative", true)
      .or(`and(from_node.eq.${a},to_node.eq.${b}),and(from_node.eq.${b},to_node.eq.${a})`);
  }
  async decaySpeculativeLinks(factor: number, floor: number) {
    const { data } = await this.db.from("memory_links").select("*")
      .eq("speculative", true).eq("confirmed_count", 0);
    for (const l of data ?? []) {
      const s = l.link_strength * factor;
      if (s < floor) await this.db.from("memory_links").delete()
        .eq("from_node", l.from_node).eq("to_node", l.to_node);
      else await this.db.from("memory_links").update({ link_strength: s })
        .eq("from_node", l.from_node).eq("to_node", l.to_node);
    }
  }
  async pulse(_actor: Actor) {
    const { data } = await this.db.rpc("pulse").single() as any;
    return { gapSeconds: data?.gap_seconds ?? 0, sessionCount: Number(data?.session_count ?? 1) };
  }
  async timelineAround(t: Date, windowDays: number) {
    const { data } = await this.db.rpc("timeline_around", { t: t.toISOString(), window_days: windowDays });
    return (data ?? []) as any;
  }
}
