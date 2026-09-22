/**
 * HomeState — one Durable Object holding the higher-order state that does
 * not belong on the box at home:
 *
 *   log     every call made through the home link: who asked, which tool,
 *           the arguments, and whether it worked. The audit trail the family
 *           can read back ("who gave him the afternoon?").
 *   docs    small versioned JSON documents, keyed by name. Intended for group
 *           definitions ("what does 'archie' mean") so they can be edited from
 *           anywhere and pulled by the engine, which keeps a local copy in
 *           case the cloud is unreachable.
 *
 * Accessed only from this Worker, via `fetch` with an internal URL scheme.
 */

import { DurableObject } from "cloudflare:workers";

export interface LogEntry {
  ts: string;
  actor: string;
  tool: string;
  args: unknown;
  ok: boolean;
  summary: string;
}

export class HomeState extends DurableObject<unknown> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL, actor TEXT NOT NULL, tool TEXT NOT NULL,
        args TEXT NOT NULL, ok INTEGER NOT NULL, summary TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS docs (
        name TEXT PRIMARY KEY, version INTEGER NOT NULL, updated TEXT NOT NULL,
        updated_by TEXT NOT NULL, body TEXT NOT NULL
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, kind, name] = url.pathname.split("/"); // /log | /docs/<name>

    if (kind === "log" && request.method === "POST") {
      const e = (await request.json()) as LogEntry;
      this.sql.exec(
        "INSERT INTO log (ts, actor, tool, args, ok, summary) VALUES (?, ?, ?, ?, ?, ?)",
        e.ts, e.actor, e.tool, JSON.stringify(e.args ?? null), e.ok ? 1 : 0, e.summary,
      );
      // Keep the table bounded; a year of button presses is a few thousand rows.
      this.sql.exec("DELETE FROM log WHERE id NOT IN (SELECT id FROM log ORDER BY id DESC LIMIT 5000)");
      return Response.json({ ok: true });
    }
    if (kind === "log" && request.method === "GET") {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      const rows = this.sql
        .exec("SELECT ts, actor, tool, args, ok, summary FROM log ORDER BY id DESC LIMIT ?", limit)
        .toArray()
        .map((r) => ({ ...r, args: JSON.parse(String(r.args)), ok: !!r.ok }));
      return Response.json({ entries: rows });
    }

    if (kind === "docs" && name && request.method === "GET") {
      const row = this.sql.exec("SELECT * FROM docs WHERE name = ?", name).toArray()[0];
      if (!row) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ name, version: row.version, updated: row.updated, updated_by: row.updated_by, body: JSON.parse(String(row.body)) });
    }
    if (kind === "docs" && name && request.method === "PUT") {
      const { body, by, ifVersion } = (await request.json()) as { body: unknown; by: string; ifVersion?: number };
      const cur = this.sql.exec("SELECT version FROM docs WHERE name = ?", name).toArray()[0];
      const version = Number(cur?.version ?? 0);
      if (ifVersion !== undefined && ifVersion !== version) {
        return Response.json({ error: `version is ${version}, not ${ifVersion}` }, { status: 409 });
      }
      this.sql.exec(
        "INSERT INTO docs (name, version, updated, updated_by, body) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(name) DO UPDATE SET version = excluded.version, updated = excluded.updated, updated_by = excluded.updated_by, body = excluded.body",
        name, version + 1, new Date().toISOString(), by, JSON.stringify(body),
      );
      return Response.json({ name, version: version + 1 });
    }
    return Response.json({ error: "bad request" }, { status: 400 });
  }
}

/** Typed helper over the object's fetch interface. */
export class HomeStateClient {
  constructor(private readonly stub: DurableObjectStub) {}

  log(entry: LogEntry) {
    return this.stub.fetch("https://home-state/log", { method: "POST", body: JSON.stringify(entry) });
  }
  async recent(limit = 50): Promise<LogEntry[]> {
    const r = await this.stub.fetch(`https://home-state/log?limit=${limit}`);
    return ((await r.json()) as { entries: LogEntry[] }).entries;
  }
  async doc(name: string): Promise<unknown | null> {
    const r = await this.stub.fetch(`https://home-state/docs/${name}`);
    return r.ok ? r.json() : null;
  }
  async putDoc(name: string, body: unknown, by: string, ifVersion?: number) {
    const r = await this.stub.fetch(`https://home-state/docs/${name}`, { method: "PUT", body: JSON.stringify({ body, by, ifVersion }) });
    return r.json();
  }
}
