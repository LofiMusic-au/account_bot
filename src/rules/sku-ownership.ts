// LOFI's SKU ownership conventions (confirmed by LOFI, Oct 2026).
//
// These set OWNERSHIP ONLY. They never set the acquisition source,
// condition, purchase price, consignor or split, so they can't create
// Division 66 eligibility or a consignor. A consignment SKU still needs its
// consignor recorded before the sale can be classified.
//
// Precedence (src/db.ts makeResolver, with listing links applied first in
// rebuild):
//   1. the item's own stock record (explicit facts / manual corrections)
//   2. a persisted listing -> stock SKU link (the linked SKU is then resolved)
//   3. a staff-created SKU prefix rule (longest match)
//   4. these built-in conventions (first match)
//   5. otherwise unknown -> review
// Matching is case-insensitive. Individual SKU answers belong in stock
// records, never in this table.

import type { Ownership } from "../types";

export interface SkuOwnershipRule {
  /** Recorded as the ownership source, e.g. "sku_rule:L_PREFIX". */
  id: string;
  /** What the SKU starts with (case-insensitive). */
  prefix: string;
  ownership: Ownership;
}

export const SKU_OWNERSHIP_RULES: readonly SkuOwnershipRule[] = [
  // LOFI-owned
  { id: "sku_rule:L_PREFIX", prefix: "L", ownership: "owned" }, // covers L- and other L SKUs
  // Consignment (longer prefixes first where they share a start)
  { id: "sku_rule:M_C_PREFIX", prefix: "M_C", ownership: "consignment" },
  { id: "sku_rule:A_C_PREFIX", prefix: "A_C", ownership: "consignment" },
  { id: "sku_rule:INSDOT_PREFIX", prefix: "insdot", ownership: "consignment" },
  { id: "sku_rule:INS_PREFIX", prefix: "INS", ownership: "consignment" },
  { id: "sku_rule:AUDOT_PREFIX", prefix: "audot", ownership: "consignment" },
  { id: "sku_rule:AUD_PREFIX", prefix: "AUD", ownership: "consignment" },
  { id: "sku_rule:RM_PREFIX", prefix: "RM", ownership: "consignment" },
  { id: "sku_rule:TT_PREFIX", prefix: "TT", ownership: "consignment" },
  { id: "sku_rule:P_PREFIX", prefix: "P", ownership: "consignment" },
  { id: "sku_rule:G_PREFIX", prefix: "G", ownership: "consignment" },
  { id: "sku_rule:BOX_PREFIX", prefix: "BOX", ownership: "consignment" },
  { id: "sku_rule:OWN-BOX_PREFIX", prefix: "OWN-BOX", ownership: "consignment" },
  { id: "sku_rule:OWNBOX_PREFIX", prefix: "OWNBOX", ownership: "consignment" },
];

/** The first convention a SKU matches, or null (-> review). */
export function skuOwnershipRule(sku: string | null | undefined): SkuOwnershipRule | null {
  const s = sku?.trim().toUpperCase();
  if (!s) return null;
  return SKU_OWNERSHIP_RULES.find((r) => s.startsWith(r.prefix.toUpperCase())) ?? null;
}
