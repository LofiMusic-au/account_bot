// One-time eBay sign-in to get a long-lived user refresh token (about 18
// months) for LOFI's seller account. Run it in your own terminal:
//
//   npm run ebay:consent
//
// Needs in .dev.vars: EBAY_CLIENT_ID (App ID), EBAY_CLIENT_SECRET (Cert ID)
// and EBAY_RUNAME (the RuName from the developer portal's User Tokens page,
// "Get a Token from eBay via Your Application").
//
// It prints a sign-in link, you sign in as the LOFI seller and agree, then
// paste the address eBay sends you to. The code in it is exchanged for tokens,
// EBAY_REFRESH_TOKEN is written into .dev.vars (git-ignored), and a test call
// checks both scopes. No token is printed.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const root = join(import.meta.dirname, "..");
const varsPath = join(root, ".dev.vars");
const SCOPES = [
  "https://api.ebay.com/oauth/api_scope/sell.finances",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly",
];

function readVars(): Record<string, string> {
  if (!existsSync(varsPath)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(varsPath, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2]) out[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/**
 * Set KEY="value" in .dev.vars, replacing an existing (or commented-out) line.
 * Always quoted: eBay refresh tokens contain "#", which Wrangler's .env-style
 * parser treats as the start of a comment when the value is unquoted.
 */
function writeVar(key: string, value: string) {
  const lines = existsSync(varsPath) ? readFileSync(varsPath, "utf8").split("\n") : [];
  const i = lines.findIndex((l) => new RegExp(`^\\s*#?\\s*${key}\\s*=`).test(l));
  const line = `${key}="${value}"`;
  if (i >= 0) lines[i] = line;
  else lines.push(line);
  writeFileSync(varsPath, lines.join("\n").replace(/\n*$/, "\n"));
}

const vars = { ...readVars(), ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)) } as Record<string, string>;
const missing = ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_RUNAME"].filter((k) => !vars[k]);
if (missing.length) {
  console.log(`Add these to .dev.vars first: ${missing.join(", ")}`);
  process.exit(1);
}

const consent =
  "https://auth.ebay.com/oauth2/authorize?" +
  new URLSearchParams({
    client_id: vars.EBAY_CLIENT_ID!,
    redirect_uri: vars.EBAY_RUNAME!,
    response_type: "code",
    scope: SCOPES.join(" "),
    prompt: "login",
  }).toString();

console.log("\n1. Open this link and sign in as the LOFI eBay seller account, then agree:\n");
console.log(consent);
console.log("\n2. eBay then sends you to another page. Copy that page's full address from the browser bar.\n");
const rl = createInterface({ input: process.stdin, output: process.stdout });
const pasted = (await rl.question("Paste it here and press Enter: ")).trim();
rl.close();

// Accept the whole address or just the code. The code arrives URL-encoded once.
let code = pasted;
try {
  const u = new URL(pasted);
  code = u.searchParams.get("code") ?? "";
} catch {
  code = decodeURIComponent(pasted);
}
if (!code) {
  console.log("No code found in that address. Did the sign-in finish with 'accepted'? Try again.");
  process.exit(1);
}

const basic = Buffer.from(`${vars.EBAY_CLIENT_ID}:${vars.EBAY_CLIENT_SECRET}`).toString("base64");
const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: vars.EBAY_RUNAME! }),
});
const body = (await res.json()) as {
  access_token?: string;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
};
if (!res.ok || !body.refresh_token || !body.access_token) {
  console.log(`eBay refused the code: ${body.error ?? res.status} ${body.error_description ?? ""}`);
  console.log("Codes expire after about 5 minutes and work once. Run this again for a fresh one.");
  process.exit(1);
}

writeVar("EBAY_REFRESH_TOKEN", body.refresh_token);
const days = Math.round((body.refresh_token_expires_in ?? 0) / 86400);
console.log(`\nSaved EBAY_REFRESH_TOKEN to .dev.vars (valid about ${days} days).`);

// Check both scopes with the new access token.
const h = { Authorization: `Bearer ${body.access_token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_AU", Accept: "application/json" };
const fin = await fetch("https://apiz.ebay.com/sell/finances/v1/payout?limit=1", { headers: h });
const ful = await fetch("https://api.ebay.com/sell/fulfillment/v1/order?limit=1", { headers: h });
console.log(`Finances API (payouts): ${fin.ok ? "OK" : `failed (${fin.status})`}`);
console.log(`Fulfillment API (orders): ${ful.ok ? "OK" : `failed (${ful.status})`}`);
if (fin.ok && ful.ok) {
  console.log("\nAll set. If .dev.vars still has an EBAY_ACCESS_TOKEN line, delete it so the refresh token is used.");
}
