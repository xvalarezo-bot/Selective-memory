// stores/github.ts — the repo-as-brain backend. The brain is a GitHub repo:
//   nodes/<id>.json       one file per memory (emergent folders -> parent_id field)
//   cues.json             hot index (small, loaded whole into memory)
//   links.json, heartbeat.json, tombstones.json
// Git history IS the provenance ledger: every reconsolidation is a commit, the
// original is always reachable, and `git log` is the brain's autobiography.
// Single-writer by design (commits serialize). Good to ~50k memories.

import { randomUUID } from "crypto";
import type { BrainStore, MemoryNode, MemoryCue, MemoryLink, Actor } from "../store.js";

const API = "https://api.github.com";

export class GithubStore implements BrainStore {
  private shaCache = new Map<string, string>();
  private cues: MemoryCue[] = [];
  private links: MemoryLink[] = [];
  private nodeCache = new Map<string, MemoryNode>();
  private loaded = false;

  constructor(private repo: string, private token: string, private branch = "main") {}

  // ---------- low-level ----------
  private async gh(path: string, init?: RequestInit): Promise<any> {
    const r = await fetch(`${API}/repos/${this.repo}/contents/${path}?ref=${this.branch}`.replace("?ref", init?.method === "PUT" ? "?x" : "?ref"), {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`,
                 Accept: "application/vnd.github+json", ...(init?.headers ?? {}) },
    });
    if (r.status === 404) return null;
    return r.json();
  }
  private async readJson(path: string): Promise<any | null> {
    const d = await this.gh(path);
    if (!d?.content) return null;
    this.shaCache.set(path, d.sha);
    return JSON.parse(Buffer.from(d.content, "base64").toString("utf-8"));
  }
  private async writeJson(path: string, obj: any, message: string) {
    const body: any = {
      message, branch: this.branch,
      content: Buffer.from(JSON.stringify(obj, null, 1)).toString("base64"),
    };
    if (this.shaCache.has(path)) body.sha = this.shaCache.get(path);
    const res = await fetch(`${API}/repos/${this.repo}/contents/${path}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json" },
      body: JSON.stringify(body),
    }).then(r => r.json());
    if (res?.content?.sha) this.shaCache.set(path, res.content.sha);
  }

  // ---------- init / cache ----------
  async init() {
    if (this.loaded) return;
    this.cues = (await this.readJson("cues.json")) ?? [];
    this.links = (await this.readJson("links.json")) ?? [];
    const list = await this.gh("nodes");
    if (Array.isArray(list)) {
      for (const f of list) {
        const n = await this.readJson(`nodes/${f.name}`);
        if (n) this.nodeCache.set(n.id, n);
      }
    }
    this.loaded = true;
  }
  private async flushCues() { await this.writeJson("cues.json", this.cues, "brain: cue index"); }
  private async flushLinks() { await this.writeJson("links.json", this.links, "brain: links"); }

  // ---------- nodes ----------
  async insertNode(n: any): Promise<string> {
    const id = randomUUID();
    const node: MemoryNode = {
      ...n, id, status: "active", fire_count: 0,
      origin_body: n.body ?? null,             // immutable copy; git keeps it anyway
      created_at: new Date().toISOString(),
    };
    this.nodeCache.set(id, node);
    await this.writeJson(`nodes/${id}.json`, node, `memory: ${n.summary.slice(0, 60)}`);
    return id;
  }
  async getNode(id: string) { return this.nodeCache.get(id) ?? null; }
  async updateNode(id: string, patch: Partial<MemoryNode>) {
    const n = this.nodeCache.get(id); if (!n) return;
    delete (patch as any).origin_body;          // origin immutable (and git remembers)
    Object.assign(n, patch);
    await this.writeJson(`nodes/${id}.json`, n, `reconsolidate: ${n.summary.slice(0, 50)}`);
  }
  async deleteNode(id: string, t: any) {
    const tomb = (await this.readJson("tombstones.json")) ?? [];
    tomb.push({ ...t, died_at: new Date().toISOString() });
    await this.writeJson("tombstones.json", tomb, `forgot: ${t.summary.slice(0, 50)} (${t.cause})`);
    this.nodeCache.delete(id);
    this.cues = this.cues.filter(c => c.node_id !== id);
    this.links = this.links.filter(l => l.from_node !== id && l.to_node !== id);
    await this.flushCues(); await this.flushLinks();
    // node file left in repo marked archived — git is the tombstone's body
    const n = await this.readJson(`nodes/${id}.json`);
    if (n) { n.status = "archived"; await this.writeJson(`nodes/${id}.json`, n, "archive"); }
  }
  async listNodes(f: any) {
    let out = [...this.nodeCache.values()];
    if (f.status) out = out.filter(n => n.status === f.status);
    if (f.type?.length) out = out.filter(n => f.type.includes(n.type));
    if (f.parentNull) out = out.filter(n => !n.parent_id);
    out.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return out.slice(0, f.limit ?? 100);
  }
  async countActive() { return [...this.nodeCache.values()].filter(n => n.status === "active").length; }

  // ---------- cues ----------
  async insertCue(c: any) {
    this.cues.push({ ...c, id: randomUUID(), weight: c.weight ?? 1.0, cue_kind: c.cue_kind ?? "semantic" });
    await this.flushCues();
  }
  async allSemanticCues() {
    return this.cues.filter(c => c.cue_kind === "semantic").map(c => {
      const n = this.nodeCache.get(c.node_id);
      return n && n.status === "active"
        ? { ...c, strength: n.strength, summary: n.summary, node_type: n.type, node_status: n.status }
        : null;
    }).filter(Boolean) as any;
  }
  async dueTemporalCues(now: Date) {
    const t = now.getTime();
    return this.cues.filter(c => c.cue_kind === "temporal" && c.fires_after).flatMap(c => {
      const n = this.nodeCache.get(c.node_id);
      if (!n || n.status !== "active") return [];
      const a = new Date(c.fires_after!).getTime();
      const u = c.fires_until ? new Date(c.fires_until).getTime() : null;
      if (t < a || (u !== null && t > u + 3 * 864e5)) return [];
      const urgency = u ? Math.min(1, Math.max(0, (t - a) / (u - a || 1))) : 0.5;
      return [{ node_id: c.node_id, summary: n.summary, node_type: n.type, urgency }];
    });
  }
  async bumpRecall(ids: string[]) {
    const now = new Date().toISOString();
    for (const id of ids) {
      const n = this.nodeCache.get(id);
      if (n) { n.fire_count++; n.last_fired = now;
        await this.writeJson(`nodes/${id}.json`, n, "recall"); }
    }
    for (const c of this.cues) if (ids.includes(c.node_id)) c.weight = Math.min(c.weight + 0.05, 2.0);
    await this.flushCues();
  }
  async deleteCuesFor(nodeId: string) {
    this.cues = this.cues.filter(c => c.node_id !== nodeId); await this.flushCues();
  }

  // ---------- links ----------
  async upsertLink(l: MemoryLink) {
    const i = this.links.findIndex(x => x.from_node === l.from_node && x.to_node === l.to_node);
    if (i >= 0) this.links[i] = l; else this.links.push(l);
    await this.flushLinks();
  }
  async linksFrom(ids: string[]) { return this.links.filter(l => ids.includes(l.from_node)); }
  async confirmLink(a: string, b: string) {
    for (const l of this.links) {
      if (l.speculative && ((l.from_node === a && l.to_node === b) || (l.from_node === b && l.to_node === a))) {
        l.speculative = false; l.link_strength = 0.6; l.confirmed_count++;
      }
    }
    await this.flushLinks();
  }
  async decaySpeculativeLinks(factor: number, floor: number) {
    for (const l of this.links) if (l.speculative && !l.confirmed_count) l.link_strength *= factor;
    this.links = this.links.filter(l => !(l.speculative && l.link_strength < floor));
    await this.flushLinks();
  }

  // ---------- time ----------
  async pulse(actor: Actor) {
    const hb = (await this.readJson("heartbeat.json")) ?? {};
    const prev = hb[actor];
    const now = new Date().toISOString();
    const gapSeconds = prev ? (Date.now() - new Date(prev.last_session_at).getTime()) / 1000 : 0;
    hb[actor] = { last_session_at: now, session_count: (prev?.session_count ?? 0) + 1 };
    await this.writeJson("heartbeat.json", hb, `wake: ${actor}`);
    return { gapSeconds, sessionCount: hb[actor].session_count };
  }
  async timelineAround(t: Date, windowDays: number) {
    const lo = t.getTime() - windowDays * 864e5, hi = t.getTime() + windowDays * 864e5;
    return [...this.nodeCache.values()]
      .filter(n => n.status === "active") 
      .filter(n => { const c = new Date(n.created_at).getTime(); return c >= lo && c <= hi; })
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
}
