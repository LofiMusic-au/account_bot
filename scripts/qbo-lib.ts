// Shared helpers for the QuickBooks SANDBOX scripts. Sandbox only: every
// request goes to sandbox-quickbooks.api.intuit.com, and the scripts refuse
// to run unless QBO_MODE=sandbox. Secrets stay in .dev.vars (git-ignored)
// and the local D1 database; nothing is printed.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const root = join(import.meta.dirname, "..");
const varsPath = join(root, ".dev.vars");
export const SANDBOX_BASE = "https://sandbox-quickbooks.api.intuit.com";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

export function readVars(): Record<string, string> {
  if (!existsSync(varsPath)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(varsPath, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2]) out[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/** Set KEY="value" in .dev.vars (quoted: Intuit tokens can contain characters a .env parser mangles). */
export function writeVar(key: string, value: string) {
  const lines = existsSync(varsPath) ? readFileSync(varsPath, "utf8").split("\n") : [];
  const i = lines.findIndex((l) => new RegExp(`^\\s*#?\\s*${key}\\s*=`).test(l));
  const line = `${key}="${value}"`;
  if (i >= 0) lines[i] = line;
  else lines.push(line);
  writeFileSync(varsPath, lines.join("\n").replace(/\n*$/, "\n"));
}

/** Run SQL against the local D1 database (the one `npm run dev` uses). */
export function localSql<T = Record<string, unknown>>(sql: string): T[] {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "lofi-recon", "--local", "--json", "--command", sql], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(out) as { results: T[] }[];
  return parsed.flatMap((p) => p.results ?? []);
}

export function requireSandbox(v = readVars()) {
  if (v.QBO_MODE !== "sandbox") throw new Error("These scripts only run with QBO_MODE=sandbox in .dev.vars");
  for (const k of ["QBO_REALM_ID", "QBO_CLIENT_ID", "QBO_CLIENT_SECRET"]) if (!v[k]) throw new Error(`Set ${k} in .dev.vars (Intuit DEVELOPMENT keys)`);
  return v;
}

export const basic = (v: Record<string, string>) => `Basic ${Buffer.from(`${v.QBO_CLIENT_ID}:${v.QBO_CLIENT_SECRET}`).toString("base64")}`;

/** Sandbox API client. Uses the newest refresh token (local D1 first, as the Worker does) and stores rotations in both places. */
export class SandboxClient {
  private access: string | null = null;
  constructor(private v = requireSandbox()) {}

  private currentRefresh(): string {
    const row = localSql<{ refresh_token: string }>("SELECT refresh_token FROM qbo_tokens WHERE id = 1")[0];
    const t = row?.refresh_token ?? this.v.QBO_REFRESH_TOKEN;
    if (!t) throw new Error("No sandbox refresh token yet: run `npm run qbo:connect`");
    return t;
  }

  async token(): Promise<string> {
    if (this.access) return this.access;
    const refresh = this.currentRefresh();
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", Authorization: basic(this.v) },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
    });
    const body = (await res.json()) as { access_token?: string; refresh_token?: string; error?: string };
    if (!res.ok || !body.access_token) throw new Error(`Sandbox token refresh failed: ${body.error ?? res.status}`);
    if (body.refresh_token && body.refresh_token !== refresh) storeRefresh(body.refresh_token);
    this.access = body.access_token;
    return this.access;
  }

  async call<T = unknown>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: T; raw: string }> {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${SANDBOX_BASE}/v3/company/${this.v.QBO_REALM_ID}${path}${sep}minorversion=75`, {
      method,
      headers: { Authorization: `Bearer ${await this.token()}`, Accept: "application/json", "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const raw = await res.text();
    let json: T;
    try {
      json = JSON.parse(raw) as T;
    } catch {
      json = raw as unknown as T;
    }
    return { status: res.status, json, raw };
  }

  async query<T = Record<string, unknown>>(q: string, entity: string): Promise<T[]> {
    const r = await this.call<{ QueryResponse?: Record<string, T[]>; Fault?: unknown }>("GET", `/query?query=${encodeURIComponent(q)}`);
    if (r.status !== 200) throw new Error(`Query failed (${r.status}): ${r.raw.slice(0, 400)}`);
    return r.json.QueryResponse?.[entity] ?? [];
  }
}

export function storeRefresh(token: string) {
  writeVar("QBO_REFRESH_TOKEN", token);
  const q = token.replace(/'/g, "''");
  localSql(`INSERT INTO qbo_tokens (id, refresh_token, updated_at) VALUES (1, '${q}', datetime('now')) ON CONFLICT (id) DO UPDATE SET refresh_token = excluded.refresh_token, updated_at = excluded.updated_at`);
}
