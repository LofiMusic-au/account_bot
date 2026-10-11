// Cloudflare Worker entry: a morning cron that rebuilds new payouts, plus a
// small dashboard. Milestone 1 is report-only: there is no QuickBooks client
// in this codebase, and nothing here writes to any accounting system.

import { EbayClient } from "./channels/ebay";
import { ShopifyClient } from "./channels/shopify";
import {
  addConsignor,
  clearPayouts,
  applyOrderFacts,
  FACT_FIELDS,
  getReport,
  ingestPayout,
  listReports,
  loadOrderFacts,
  loadResolver,
  loadStoredPayout,
  reportExists,
  saveReport,
  setConsignorAgreement,
  setConsignorGst,
  validateConsignor,
  type ConsignorInput,
  setOrderDestination,
  setStockFact,
  sourceInfo,
  upsertStock,
  validateStock,
  type FactField,
  type StockInput,
} from "./db";
import { toCents } from "./money";
import { buildReport, type PayoutReport } from "./reconcile";
import type { Channel, Issue, NormalisedPayout } from "./types";
import { renderIndex, renderReport, renderReview, renderStockForm, type ConsignorOption, type ReviewItem } from "./ui";

export interface Env {
  DB: D1Database;
  SHOPIFY_SHOP: string;
  SHOPIFY_API_VERSION: string;
  SHOPIFY_ADMIN_TOKEN?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  EBAY_MARKETPLACE_ID: string;
  EBAY_CLIENT_ID?: string;
  EBAY_CLIENT_SECRET?: string;
  EBAY_REFRESH_TOKEN?: string;
  LOOKBACK_DAYS: string;
  DASHBOARD_TOKEN?: string;
  /** "true" shows the "Clear all payouts" button. For local/testing only. */
  ALLOW_DATA_RESET?: string;
}

/** Max payouts processed per run, to stay inside Worker subrequest limits. */
const MAX_PAYOUTS_PER_RUN = 6;

interface Source {
  channel: Channel;
  list(since: string): Promise<{ id: string; load: () => Promise<NormalisedPayout> }[]>;
}

function sources(env: Env): Source[] {
  const out: Source[] = [];
  if (env.SHOPIFY_ADMIN_TOKEN || (env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET)) {
    const c = new ShopifyClient({
      shop: env.SHOPIFY_SHOP,
      token: env.SHOPIFY_ADMIN_TOKEN,
      clientId: env.SHOPIFY_CLIENT_ID,
      clientSecret: env.SHOPIFY_CLIENT_SECRET,
      apiVersion: env.SHOPIFY_API_VERSION,
    });
    out.push({
      channel: "shopify",
      list: async (since) => (await c.listPayouts(since)).map((p) => ({ id: p.legacyResourceId, load: () => c.fetchPayout(p) })),
    });
  }
  if (env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET && env.EBAY_REFRESH_TOKEN) {
    const c = new EbayClient({
      clientId: env.EBAY_CLIENT_ID,
      clientSecret: env.EBAY_CLIENT_SECRET,
      refreshToken: env.EBAY_REFRESH_TOKEN,
      marketplaceId: env.EBAY_MARKETPLACE_ID,
    });
    out.push({
      channel: "ebay",
      list: async (since) => (await c.listPayouts(since)).map((p) => ({ id: p.payoutId, load: () => c.fetchPayout(p) })),
    });
  }
  return out;
}

/** Classify and reconcile a stored or freshly fetched payout, applying the latest facts. */
export async function rebuild(db: D1Database, payout: NormalisedPayout, extraIssues: Issue[] = []): Promise<PayoutReport> {
  const withFacts = applyOrderFacts(payout, await loadOrderFacts(db, payout));
  const p = { ...withFacts, issues: [...withFacts.issues, ...extraIssues] };
  const report = buildReport(p, await loadResolver(db, p));
  await saveReport(db, report);
  return report;
}

/** Store a fetched payout (idempotent) and build its report. */
export async function ingestAndReport(db: D1Database, payout: NormalisedPayout): Promise<PayoutReport> {
  const issues = await ingestPayout(db, payout);
  return rebuild(db, payout, issues);
}

/** Rebuild from stored data (no platform calls). Used after staff correct a fact. */
export async function rebuildStored(db: D1Database, channel: string, payoutId: string): Promise<PayoutReport | null> {
  const p = await loadStoredPayout(db, channel, payoutId);
  return p ? rebuild(db, p) : null;
}

/** Rebuild every recent payout that isn't ready, so a corrected fact shows up everywhere. */
async function rebuildOpen(db: D1Database): Promise<number> {
  let n = 0;
  for (const r of await listReports(db, 60)) {
    if (r.status === "ready") continue;
    if (await rebuildStored(db, r.channel, r.payout_id)) n++;
  }
  return n;
}

/** Fetch payouts not yet reported. `only` limits to one payout (re-fetch). */
export async function run(env: Env, only?: { channel: string; payoutId: string }): Promise<string[]> {
  const log: string[] = [];
  const srcs = sources(env);
  if (srcs.length === 0) return ["No channels configured: set the Shopify and/or eBay secrets."];
  const since = new Date(Date.now() - Number(env.LOOKBACK_DAYS || "14") * 86_400_000).toISOString().slice(0, 10);
  let processed = 0;
  for (const s of srcs) {
    if (only && only.channel !== s.channel) continue;
    try {
      const list = await s.list(since);
      if (only && !list.some((p) => p.id === only.payoutId)) {
        log.push(`${s.channel} ${only.payoutId}: not in the last ${env.LOOKBACK_DAYS} days of payouts`);
      }
      for (const p of list) {
        if (only ? p.id !== only.payoutId : await reportExists(env.DB, s.channel, p.id)) continue;
        if (processed >= MAX_PAYOUTS_PER_RUN) {
          log.push("Run limit reached; remaining payouts will be picked up next run.");
          return log;
        }
        const r = await ingestAndReport(env.DB, await p.load());
        processed++;
        log.push(`${s.channel} ${p.id}: ${r.status}, ${r.saleCount} sales, difference ${r.differenceCents} cents`);
      }
    } catch (e) {
      // Error text comes from the platform's response body; tokens are never part of it.
      log.push(`${s.channel}: ${(e as Error).message.slice(0, 500)}`);
    }
  }
  if (processed === 0 && log.length === 0) log.push("No new payouts.");
  return log;
}

// ------------------------------------------------------------------ routing

function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function authorised(req: Request, env: Env): Response | null {
  if (!env.DASHBOARD_TOKEN) return null; // assume Cloudflare Access in front
  const url = new URL(req.url);
  const cookie = req.headers.get("Cookie") ?? "";
  const fromCookie = /(?:^|;\s*)lofi_token=([^;]+)/.exec(cookie)?.[1];
  if (fromCookie && safeEqual(decodeURIComponent(fromCookie), env.DASHBOARD_TOKEN)) return null;
  const q = url.searchParams.get("token");
  if (q && safeEqual(q, env.DASHBOARD_TOKEN)) {
    url.searchParams.delete("token");
    return new Response(null, {
      status: 302,
      headers: {
        Location: url.pathname + url.search,
        "Set-Cookie": `lofi_token=${encodeURIComponent(env.DASHBOARD_TOKEN)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
      },
    });
  }
  return new Response("Unauthorised", { status: 401 });
}

const redirect = (to: string) => new Response(null, { status: 303, headers: { Location: to } });
const withMsg = (to: string, msg: string) => `${to}${to.includes("?") ? "&" : "?"}msg=${encodeURIComponent(msg)}`;
/** Only same-site relative paths are allowed as a return address. */
const safeReturn = (r: string | undefined) => (r && r.startsWith("/") && !r.startsWith("//") ? r : "/review");

async function form(req: Request): Promise<Record<string, string>> {
  const fd = await req.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string" && v.trim() !== "") out[k] = v.trim();
  return out;
}

async function consignorList(env: Env) {
  return (
    await env.DB.prepare("SELECT id, name, country, australian_gst_registered, agreement_type FROM consignors ORDER BY name").all<ConsignorOption>()
  ).results;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const denied = authorised(req, env);
    if (denied) return denied;
    const url = new URL(req.url);
    const path = url.pathname;
    const msg = url.searchParams.get("msg") ?? undefined;

    const canReset = env.ALLOW_DATA_RESET === "true";

    if (req.method === "GET" && path === "/") {
      return renderIndex(await listReports(env.DB), msg, canReset);
    }

    if (req.method === "POST" && path === "/admin/clear-payouts") {
      if (!canReset) return new Response("Clearing payouts is switched off (set ALLOW_DATA_RESET=true locally).", { status: 403 });
      const n = await clearPayouts(env.DB);
      return redirect(withMsg("/", `Cleared ${n} payout(s) and their stored source data. Stock records, consignors and facts were kept.`));
    }

    if (req.method === "POST" && path === "/run") {
      const log = await run(env);
      return redirect(withMsg("/", log.join(" · ")));
    }

    const m = /^\/payout\/(ebay|shopify)\/([^/]+)(?:\/(rerun|refetch|rebuild))?$/.exec(path);
    if (m) {
      const [, channel, rawId, action] = m;
      const payoutId = decodeURIComponent(rawId!);
      const back = `/payout/${channel}/${encodeURIComponent(payoutId)}`;
      if (req.method === "POST" && action === "rebuild") {
        const r = await rebuildStored(env.DB, channel!, payoutId);
        return redirect(withMsg(back, r ? `Rebuilt from stored data: ${r.status}` : "No stored source data for this payout; fetch it again"));
      }
      if (req.method === "POST" && (action === "rerun" || action === "refetch")) {
        const log = await run(env, { channel: channel!, payoutId });
        return redirect(withMsg(back, log.join(" · ")));
      }
      if (req.method !== "GET" || action) return new Response("Not found", { status: 404 });
      const r = await getReport(env.DB, channel!, payoutId);
      if (!r) return new Response("Payout not found", { status: 404 });
      const consignors = new Map((await consignorList(env)).map((c) => [c.id, c.name]));
      return renderReport(r, await sourceInfo(env.DB, channel!, payoutId), msg, consignors);
    }

    if (req.method === "GET" && path === "/review") {
      const rows = await listReports(env.DB, 60);
      const items: ReviewItem[] = [];
      const consignors = new Map((await consignorList(env)).map((c) => [c.id, c.name]));
      for (const row of rows.filter((x) => x.status !== "ready")) {
        const r = await getReport(env.DB, row.channel, row.payout_id);
        if (!r || !r.issues) continue;
        for (const issue of r.issues) if (issue.severity === "blocking") items.push({ report: r, issue });
      }
      return renderReview(items, consignors, msg, canReset);
    }

    // One fact at a time, from the review queue. Facts, never tax codes.
    if (req.method === "POST" && path === "/facts/stock") {
      const f = await form(req);
      const back = safeReturn(f.return);
      try {
        if (!f.sku || !f.field || !f.value) throw new Error("sku, field and value are required");
        if (!Object.hasOwn(FACT_FIELDS, f.field)) throw new Error(`Unknown fact ${f.field}`);
        await setStockFact(env.DB, f.sku, f.field as FactField, f.value, f.title);
      } catch (e) {
        return redirect(withMsg(back, (e as Error).message));
      }
      const n = await rebuildOpen(env.DB);
      return redirect(withMsg(back, `Saved ${f.field.replace("_", " ")} for ${f.sku}; ${n} open payout(s) rebuilt`));
    }

    if (req.method === "POST" && path === "/facts/consignor") {
      const f = await form(req);
      const back = safeReturn(f.return);
      const id = Number(f.id);
      if (!Number.isInteger(id)) return redirect(withMsg(back, "Unknown consignor"));
      if (f.gst === "registered" || f.gst === "not_registered") {
        await setConsignorGst(env.DB, id, f.gst === "registered");
      } else if (f.agreement === "agency" || f.agreement === "153B") {
        await setConsignorAgreement(env.DB, id, f.agreement);
      } else {
        return redirect(withMsg(back, "Choose an answer"));
      }
      const n = await rebuildOpen(env.DB);
      return redirect(withMsg(back, `Saved consignor fact; ${n} open payout(s) rebuilt`));
    }

    if (req.method === "POST" && path === "/facts/order") {
      const f = await form(req);
      const back = safeReturn(f.return);
      try {
        if ((f.channel !== "ebay" && f.channel !== "shopify") || !f.order_id || !f.country) throw new Error("channel, order and country are required");
        await setOrderDestination(env.DB, f.channel, f.order_id, f.country);
      } catch (e) {
        return redirect(withMsg(back, (e as Error).message));
      }
      const n = await rebuildOpen(env.DB);
      return redirect(withMsg(back, `Saved destination ${f.country.toUpperCase()}; ${n} open payout(s) rebuilt`));
    }

    if (req.method === "GET" && path === "/stock/new") {
      return renderStockForm(
        { sku: url.searchParams.get("sku") ?? undefined, title: url.searchParams.get("title") ?? undefined },
        await consignorList(env),
        msg,
      );
    }

    if (req.method === "POST" && path === "/stock") {
      const f = await form(req);
      let purchase: number | undefined;
      try {
        purchase = f.purchase_aud ? toCents(f.purchase_aud.replace(/[$,]/g, "")) : undefined;
      } catch {
        return renderStockForm({ sku: f.sku, title: f.title }, await consignorList(env), "Purchase price isn't a valid amount");
      }
      const input: Partial<StockInput> = {
        sku: f.sku,
        title: f.title,
        ownership: f.ownership as StockInput["ownership"],
        acquired_from: f.acquired_from as StockInput["acquired_from"],
        item_condition: f.item_condition as StockInput["item_condition"],
        purchase_cents: purchase,
        purchase_date: f.purchase_date,
        seller_name: f.seller_name,
        seller_address: f.seller_address,
        seller_description: f.seller_description,
        consignor_id: f.consignor_id ? Number(f.consignor_id) : undefined,
        commission_type: f.commission_type as StockInput["commission_type"],
        commission_value: f.commission_value ? Number(f.commission_value) : undefined,
        notes: f.notes,
      };
      const errs = validateStock(input);
      if (errs.length) return renderStockForm({ sku: f.sku, title: f.title }, await consignorList(env), errs.join("; "));
      await upsertStock(env.DB, input as StockInput);
      const n = await rebuildOpen(env.DB);
      return redirect(withMsg("/stock/new", `Saved ${input.sku}; ${n} open payout(s) rebuilt`));
    }

    if (req.method === "POST" && path === "/consignors") {
      const f = await form(req);
      const input: Partial<ConsignorInput> = {
        name: f.name,
        contact: f.contact,
        country: f.country,
        australian_gst_registered: f.australian_gst === "yes" ? true : f.australian_gst === "no" ? false : f.australian_gst === "unknown" ? null : "auto",
        abn: f.abn,
        commission_type: "percent",
        commission_value: f.commission_value ? Number(f.commission_value) : 0,
        agreement_type: f.agreement_type === "agency" || f.agreement_type === "153B" ? f.agreement_type : null,
      };
      const errs = validateConsignor(input);
      if (errs.length) return redirect(withMsg("/stock/new", errs.join("; ")));
      await addConsignor(env.DB, input as ConsignorInput);
      return redirect(withMsg("/stock/new", `Added consignor ${f.name}`));
    }

    // JSON API for scripted consignor intake. Validates everything first.
    if (req.method === "POST" && path === "/api/consignors") {
      const body = (await req.json()) as Partial<ConsignorInput> | Partial<ConsignorInput>[];
      const items = Array.isArray(body) ? body : [body];
      const errors = items.map((x, i) => ({ i, errs: validateConsignor(x) })).filter((x) => x.errs.length);
      if (errors.length) return Response.json({ ok: false, errors }, { status: 400 });
      const ids: number[] = [];
      for (const x of items) ids.push(await addConsignor(env.DB, x as ConsignorInput));
      return Response.json({ ok: true, ids });
    }

    // JSON API for scripted intake (e.g. from the legacy stock sheet).
    if (req.method === "POST" && path === "/api/stock") {
      const body = (await req.json()) as Partial<StockInput> | Partial<StockInput>[];
      const items = Array.isArray(body) ? body : [body];
      const errors = items.map((x, i) => ({ i, errs: validateStock(x) })).filter((x) => x.errs.length);
      if (errors.length) return Response.json({ ok: false, errors }, { status: 400 });
      for (const x of items) await upsertStock(env.DB, x as StockInput);
      return Response.json({ ok: true, saved: items.length });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(run(env).then((log) => console.log(log.join("\n"))));
  },
} satisfies ExportedHandler<Env>;
