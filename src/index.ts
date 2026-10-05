// Cloudflare Worker entry: a morning cron that rebuilds new payouts, plus a
// small dashboard. Milestone 1 is report-only: nothing is posted to QuickBooks.

import { EbayClient } from "./channels/ebay";
import { ShopifyClient } from "./channels/shopify";
import {
  addConsignor,
  getReport,
  listReports,
  loadResolver,
  reportExists,
  saveReport,
  upsertStock,
  validateStock,
  type StockInput,
} from "./db";
import { toCents } from "./money";
import { buildReport, type PayoutReport } from "./reconcile";
import type { Channel, NormalisedPayout } from "./types";
import { renderIndex, renderReport, renderReview, renderStockForm } from "./ui";

export interface Env {
  DB: D1Database;
  SHOPIFY_SHOP: string;
  SHOPIFY_API_VERSION: string;
  SHOPIFY_ADMIN_TOKEN?: string;
  EBAY_MARKETPLACE_ID: string;
  EBAY_CLIENT_ID?: string;
  EBAY_CLIENT_SECRET?: string;
  EBAY_REFRESH_TOKEN?: string;
  LOOKBACK_DAYS: string;
  DASHBOARD_TOKEN?: string;
}

/** Max payouts processed per run, to stay inside Worker subrequest limits. */
const MAX_PAYOUTS_PER_RUN = 6;

interface Source {
  channel: Channel;
  list(since: string): Promise<{ id: string; load: () => Promise<NormalisedPayout> }[]>;
}

function sources(env: Env): Source[] {
  const out: Source[] = [];
  if (env.SHOPIFY_ADMIN_TOKEN) {
    const c = new ShopifyClient({ shop: env.SHOPIFY_SHOP, token: env.SHOPIFY_ADMIN_TOKEN, apiVersion: env.SHOPIFY_API_VERSION });
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

async function process(env: Env, payout: NormalisedPayout): Promise<PayoutReport> {
  const resolve = await loadResolver(env.DB, payout);
  const report = buildReport(payout, resolve);
  await saveReport(env.DB, report);
  return report;
}

/** Fetch payouts not yet reported. `only` limits to one payout (re-run). */
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
      for (const p of list) {
        if (only ? p.id !== only.payoutId : await reportExists(env.DB, s.channel, p.id)) continue;
        if (processed >= MAX_PAYOUTS_PER_RUN) {
          log.push("Run limit reached; remaining payouts will be picked up next run.");
          return log;
        }
        const r = await process(env, await p.load());
        processed++;
        log.push(`${s.channel} ${p.id}: ${r.status}, ${r.saleCount} sales, difference ${r.differenceCents} cents`);
      }
    } catch (e) {
      log.push(`${s.channel}: ${(e as Error).message}`);
    }
  }
  if (processed === 0 && log.length === 0) log.push("No new payouts.");
  return log;
}

// ------------------------------------------------------------------ routing

function authorised(req: Request, env: Env): Response | null {
  if (!env.DASHBOARD_TOKEN) return null; // assume Cloudflare Access in front
  const url = new URL(req.url);
  const cookie = req.headers.get("Cookie") ?? "";
  const fromCookie = /(?:^|;\s*)lofi_token=([^;]+)/.exec(cookie)?.[1];
  if (fromCookie && decodeURIComponent(fromCookie) === env.DASHBOARD_TOKEN) return null;
  if (url.searchParams.get("token") === env.DASHBOARD_TOKEN) {
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

async function form(req: Request): Promise<Record<string, string>> {
  const fd = await req.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string" && v.trim() !== "") out[k] = v.trim();
  return out;
}

async function consignorList(env: Env) {
  return (await env.DB.prepare("SELECT id, name, gst_registered FROM consignors ORDER BY name").all<{
    id: number;
    name: string;
    gst_registered: number;
  }>()).results;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const denied = authorised(req, env);
    if (denied) return denied;
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/") {
      return renderIndex(await listReports(env.DB), url.searchParams.get("msg") ?? undefined);
    }

    if (req.method === "POST" && path === "/run") {
      const log = await run(env);
      return redirect(`/?msg=${encodeURIComponent(log.join(" · "))}`);
    }

    const m = /^\/payout\/(ebay|shopify)\/([^/]+)(\/rerun)?$/.exec(path);
    if (m) {
      const [, channel, rawId, rerun] = m;
      const payoutId = decodeURIComponent(rawId!);
      if (req.method === "POST" && rerun) {
        const log = await run(env, { channel: channel!, payoutId });
        return redirect(`/payout/${channel}/${encodeURIComponent(payoutId)}?msg=${encodeURIComponent(log.join(" · "))}`);
      }
      const r = await getReport(env.DB, channel!, payoutId);
      return r ? renderReport(r) : new Response("Payout not found", { status: 404 });
    }

    if (req.method === "GET" && path === "/review") {
      const rows = await listReports(env.DB, 30);
      const items = [];
      for (const row of rows.filter((x) => x.review_count > 0)) {
        const r = await getReport(env.DB, row.channel, row.payout_id);
        if (!r) continue;
        for (const line of [...r.sales, ...r.refunds]) if (line.approval === "review") items.push({ report: r, line });
      }
      return renderReview(items);
    }

    if (req.method === "GET" && path === "/stock/new") {
      return renderStockForm(
        { sku: url.searchParams.get("sku") ?? undefined, title: url.searchParams.get("title") ?? undefined },
        await consignorList(env),
        url.searchParams.get("msg") ?? undefined,
      );
    }

    if (req.method === "POST" && path === "/stock") {
      const f = await form(req);
      const input: Partial<StockInput> = {
        sku: f.sku,
        title: f.title,
        ownership: f.ownership as StockInput["ownership"],
        acquired_from: f.acquired_from as StockInput["acquired_from"],
        purchase_cents: f.purchase_aud ? toCents(f.purchase_aud) : undefined,
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
      return redirect(`/stock/new?msg=${encodeURIComponent(`Saved ${input.sku}. Re-run the payout to apply it.`)}`);
    }

    if (req.method === "POST" && path === "/consignors") {
      const f = await form(req);
      if (!f.name) return redirect(`/stock/new?msg=${encodeURIComponent("Consignor name is required")}`);
      await addConsignor(env.DB, {
        name: f.name,
        contact: f.contact,
        gst_registered: f.gst_registered === "1",
        abn: f.abn,
        commission_type: "percent",
        commission_value: f.commission_value ? Number(f.commission_value) : 0,
        agreement_type: f.agreement_type,
      });
      return redirect(`/stock/new?msg=${encodeURIComponent(`Added consignor ${f.name}`)}`);
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
