// One-time QuickBooks SANDBOX sign-in. Run in your own terminal:
//
//   npm run qbo:connect
//
// Needs in .dev.vars: QBO_MODE=sandbox, QBO_CLIENT_ID and QBO_CLIENT_SECRET
// (the Intuit app's DEVELOPMENT keys), and the redirect URI
// http://localhost:8788/qbo/callback added to the app's Development settings.
// You sign in, choose the sandbox company, and the tokens are saved to
// .dev.vars and the local D1 database (both git-ignored). Nothing is printed.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { basic, readVars, requireSandbox, SANDBOX_BASE, storeRefresh, writeVar } from "./qbo-lib";

const REDIRECT = "http://localhost:8788/qbo/callback";
const v = requireSandbox(readVars());
const state = randomBytes(16).toString("hex");
const url =
  "https://appcenter.intuit.com/connect/oauth2?" +
  new URLSearchParams({ client_id: v.QBO_CLIENT_ID!, response_type: "code", scope: "com.intuit.quickbooks.accounting", redirect_uri: REDIRECT, state });

console.log("\n1. Open this link, sign in, and choose the SANDBOX company (Sandbox Company AU):\n");
console.log(url);
console.log("\n2. Waiting for Intuit to send you back to http://localhost:8788 …\n");

const result = await new Promise<{ code: string; realmId: string }>((resolve, reject) => {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost:8788");
    if (u.pathname !== "/qbo/callback") {
      res.writeHead(404).end();
      return;
    }
    const ok = u.searchParams.get("state") === state && u.searchParams.get("code") && u.searchParams.get("realmId");
    res.writeHead(200, { "Content-Type": "text/plain" }).end(ok ? "Connected. You can close this tab and go back to the terminal." : "Something went wrong; check the terminal.");
    server.close();
    if (!ok) reject(new Error(u.searchParams.get("error") ?? "state mismatch or missing code"));
    else resolve({ code: u.searchParams.get("code")!, realmId: u.searchParams.get("realmId")! });
  });
  server.listen(8788);
  setTimeout(() => {
    server.close();
    reject(new Error("Timed out after 10 minutes"));
  }, 600_000);
});

const res = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", Authorization: basic(v) },
  body: new URLSearchParams({ grant_type: "authorization_code", code: result.code, redirect_uri: REDIRECT }),
});
const body = (await res.json()) as { access_token?: string; refresh_token?: string; error?: string; error_description?: string };
if (!res.ok || !body.refresh_token || !body.access_token) {
  console.log(`Intuit refused the code: ${body.error ?? res.status} ${body.error_description ?? ""}`);
  process.exit(1);
}
if (v.QBO_REALM_ID && v.QBO_REALM_ID !== result.realmId) {
  console.log(`Note: you connected company ${result.realmId}, not ${v.QBO_REALM_ID}; .dev.vars now uses ${result.realmId}.`);
}
writeVar("QBO_REALM_ID", result.realmId);
storeRefresh(body.refresh_token);

// Prove it's the sandbox company: read its company info from the SANDBOX host.
const info = await fetch(`${SANDBOX_BASE}/v3/company/${result.realmId}/companyinfo/${result.realmId}?minorversion=75`, {
  headers: { Authorization: `Bearer ${body.access_token}`, Accept: "application/json" },
});
const ci = (await info.json()) as { CompanyInfo?: { CompanyName?: string; Country?: string } };
if (!info.ok) {
  console.log(`Connected, but reading the company from the sandbox host failed (${info.status}). Is this a sandbox company?`);
  process.exit(1);
}
console.log(`\nConnected to SANDBOX company "${ci.CompanyInfo?.CompanyName}" (${ci.CompanyInfo?.Country}). Tokens saved to .dev.vars and local D1.`);
console.log("Restart `npm run dev` so the Worker picks up the QuickBooks settings.");
