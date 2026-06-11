// stores/sqlite.ts — the phone backend. The entire brain is ONE file (brain.db):
// a folder on your device, backupable, yours. Cosine sweep runs in-process over
// the cue index (fine to ~100k cues; upgrade path: sqlite-vec extension).

import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { BrainStore, MemoryNode, MemoryCue, MemoryLink, Actor } from "../store.js";

export class SqliteStore implements BrainStore {
  private db: any;
  constructor(path: string) { this.db = new Database(path); }

  async init() {
    this.db.exec(`
      create table if not exists nodes (
        id text primary key, parent_id text, summary text not null, body text,
        type text not null, status text not null default 'active',
        strength real not null default 1.0, valence real not null default 0,
        volatility_days integer, evidence_count integer not null default 1,
        confidence real not null default 0.5, fire_count integer not null default 0,
        actor text not null default 'unknown', origin_body text,
        created_at text not null, last_fired text);
      create table if not exists cues (
        id text primary key, node_id text not null, cue_kind text not null default 'semantic',
        cue_text text not null, embedding text, weight real not null default 1.0,
        fires_after text, fires_until text);
      create table if not exists links (
        from_node text, to_node text, link_strength real not null default 0.5,
        speculative integer not null default 0, confirmed_count integer not null default 0,
        primary key (from_node, to_node));
      create table if not exists tombstones (
        summary text, node_type text, cause text, died_at text);
      create table if not exists heartbeat (
        actor text primary key, last_session_at text, session_count integer default 0);
    `);
  }

  async insertNode(n: any): Promise<string> {
    const id = randomUUID();
    this.db.prepare(`insert into nodes (id,parent_id,summary,body,type,strength,valence,
      volatility_days,evidence_count,confidence,actor,origin_body,created_at)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, n.parent_id ?? null, n.summary, n.body ?? null, n.type, n.strength,
           n.valence ?? 0, n.volatility_days ?? null, n.evidence_count ?? 1,
           n.confidence ?? 0.5, n.actor, n.body ?? null, new Date().toISOString());
    return id;
  }
  async getNode(id: string) { return this.db.prepare(`select * from nodes where id=?`).get(id) as any; }
  async updateNode(id: string, patch: Partial<MemoryNode>) {
    const keys = Object.keys(patch).filter(k => k !== "id" && k !== "origin_body"); // origin immutable
    if (!keys.length) return;
    this.db.prepare(`update nodes set ${keys.map(k => `${k}=?`).join(",")} where id=?`)
      .run(...keys.map(k => (patch as any)[k]), id);
  }
  async deleteNode(id: string, t: any) {
    this.db.prepare(`insert into tombstones values (?,?,?,?)`)
      .run(t.summary, t.node_type, t.cause, new Date().toISOString());
    this.db.prepare(`delete from cues where node_id=?`).run(id);
    this.db.prepare(`delete from links where from_node=? or to_node=?`).run(id, id);
    this.db.prepare(`delete from nodes where id=?`).run(id);
  }
  async listNodes(f: any) {
    let q = `select * from nodes where 1=1`; const args: any[] = [];
    if (f.status) { q += ` and status=?`; args.push(f.status); }
    if (f.type?.length) { q += ` and type in (${f.type.map(() => "?").join(",")})`; args.push(...f.type); }
    if (f.parentNull) q += ` and parent_id is null`;
    q += ` order by created_at desc limit ?`; args.push(f.limit ?? 100);
    return this.db.prepare(q).all(...args) as any;
  }
  async countActive() {
    return (this.db.prepare(`select count(*) c from nodes where status='active'`).get() as any).c;
  }

  async insertCue(c: any) {
    this.db.prepare(`insert into cues (id,node_id,cue_kind,cue_text,embedding,weight,fires_after,fires_until)
      values (?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), c.node_id, c.cue_kind ?? "semantic", c.cue_text,
           c.embedding ? JSON.stringify(c.embedding) : null, c.weight ?? 1.0,
           c.fires_after ?? null, c.fires_until ?? null);
  }
  async allSemanticCues() {
    return (this.db.prepare(`
      select c.*, n.strength, n.summary, n.type as node_type, n.status as node_status
      from cues c join nodes n on n.id=c.node_id
      where c.cue_kind='semantic' and n.status='active'`).all() as any[])
      .map(r => ({ ...r, embedding: r.embedding ? JSON.parse(r.embedding) : null }));
  }
  async dueTemporalCues(now: Date) {
    const rows = this.db.prepare(`
      select c.node_id, c.fires_after, c.fires_until, n.summary, n.type as node_type
      from cues c join nodes n on n.id=c.node_id
      where c.cue_kind='temporal' and n.status='active'`).all() as any[];
    const t = now.getTime();
    return rows.filter(r => {
      const a = new Date(r.fires_after).getTime();
      const u = r.fires_until ? new Date(r.fires_until).getTime() : null;
      return t >= a && (u === null || t <= u + 3 * 864e5);
    }).map(r => {
      const a = new Date(r.fires_after).getTime();
      const u = r.fires_until ? new Date(r.fires_until).getTime() : null;
      const urgency = u ? Math.min(1, Math.max(0, (t - a) / (u - a || 1))) : 0.5;
      return { node_id: r.node_id, summary: r.summary, node_type: r.node_type, urgency };
    });
  }
  async bumpRecall(ids: string[]) {
    const now = new Date().toISOString();
    const u1 = this.db.prepare(`update nodes set fire_count=fire_count+1,last_fired=? where id=?`);
    const u2 = this.db.prepare(`update cues set weight=min(weight+0.05,2.0) where node_id=?`);
    for (const id of ids) { u1.run(now, id); u2.run(id); }
  }
  async deleteCuesFor(nodeId: string) { this.db.prepare(`delete from cues where node_id=?`).run(nodeId); }

  async upsertLink(l: MemoryLink) {
    this.db.prepare(`insert into links values (?,?,?,?,?)
      on conflict(from_node,to_node) do update set link_strength=excluded.link_strength,
      speculative=excluded.speculative`).run(l.from_node, l.to_node, l.link_strength,
      l.speculative ? 1 : 0, l.confirmed_count);
  }
  async linksFrom(ids: string[]) {
    if (!ids.length) return [];
    return this.db.prepare(`select * from links where from_node in (${ids.map(() => "?").join(",")})`)
      .all(...ids) as any;
  }
  async confirmLink(a: string, b: string) {
    this.db.prepare(`update links set speculative=0, link_strength=0.6, confirmed_count=confirmed_count+1
      where speculative=1 and ((from_node=? and to_node=?) or (from_node=? and to_node=?))`)
      .run(a, b, b, a);
  }
  async decaySpeculativeLinks(factor: number, floor: number) {
    this.db.prepare(`update links set link_strength=link_strength*? where speculative=1 and confirmed_count=0`).run(factor);
    this.db.prepare(`delete from links where speculative=1 and link_strength<?`).run(floor);
  }

  async pulse(actor: Actor) {
    const row = this.db.prepare(`select * from heartbeat where actor=?`).get(actor) as any;
    const now = new Date().toISOString();
    if (!row) {
      this.db.prepare(`insert into heartbeat values (?,?,1)`).run(actor, now);
      return { gapSeconds: 0, sessionCount: 1 };
    }
    const gap = (Date.now() - new Date(row.last_session_at).getTime()) / 1000;
    this.db.prepare(`update heartbeat set last_session_at=?, session_count=session_count+1 where actor=?`)
      .run(now, actor);
    return { gapSeconds: gap, sessionCount: row.session_count + 1 };
  }
  async timelineAround(t: Date, windowDays: number) {
    const lo = new Date(t.getTime() - windowDays * 864e5).toISOString();
    const hi = new Date(t.getTime() + windowDays * 864e5).toISOString();
    return this.db.prepare(`select * from nodes where status='active' and created_at between ? and ?
      order by created_at`).all(lo, hi) as any;
  }
}
