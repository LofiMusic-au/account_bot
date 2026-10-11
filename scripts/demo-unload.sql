-- Removes everything `npm run demo:sql && npm run demo:load` inserted, plus the
-- test facts recorded against demo SKUs/orders. Local database only.
DELETE FROM payout_reports WHERE payout_id IN ('7001', '7003', '9001', 'DEMO-1');
DELETE FROM source_transactions WHERE payout_id IN ('7001', '7003', '9001');
DELETE FROM source_orders WHERE order_id LIKE '26-0000%' OR order_id LIKE 'gid://shopify/Order/32__' OR order_id LIKE 'gid://shopify/Order/3247';
DELETE FROM source_payouts WHERE payout_id IN ('7001', '7003', '9001');
DELETE FROM stock_items WHERE sku IN ('L-500-A', 'L-300-B', 'L-NZ-1', 'RM-CONS-1', 'L-REF-1', '240/100_Stepdown',
  'RM-256549-001196-140526', 'L-DISC-1', 'L-NZ-2', 'L-mk3-0010230-300726', 'P41-ZD05714-270826');
DELETE FROM sku_prefix_rules WHERE description = 'demo';
DELETE FROM order_facts WHERE order_id LIKE 'gid://shopify/Order/32__' OR order_id LIKE 'gid://shopify/Order/3247';
DELETE FROM consignors WHERE name IN ('Overseas private consignor', 'Private consignor', 'Demo consignor (private)')
  AND id NOT IN (SELECT consignor_id FROM stock_items WHERE consignor_id IS NOT NULL);
