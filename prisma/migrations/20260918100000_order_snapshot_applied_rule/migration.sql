ALTER TABLE "OrderSnapshot" ADD COLUMN IF NOT EXISTS "ruleSource" TEXT;
ALTER TABLE "OrderSnapshot" ADD COLUMN IF NOT EXISTS "payRuleType" TEXT;
ALTER TABLE "OrderSnapshot" ADD COLUMN IF NOT EXISTS "ruleValue" DECIMAL(14,2);
ALTER TABLE "OrderSnapshot" ADD COLUMN IF NOT EXISTS "ruleLabel" TEXT;

UPDATE "OrderSnapshot"
SET
  "payRuleType" = 'fixed',
  "ruleValue" = 500,
  "ruleSource" = 'Inferred',
  "ruleLabel" = 'Inferred · Fixed ₹500'
WHERE "ruleLabel" IS NULL
  AND "payNow" = 500
  AND "fullPrice" >= 500;

UPDATE "OrderSnapshot"
SET
  "payRuleType" = 'percent',
  "ruleValue" = ROUND(("payNow" / NULLIF("fullPrice", 0)) * 100, 2),
  "ruleSource" = 'Inferred',
  "ruleLabel" = 'Inferred · Percent ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM ROUND(("payNow" / NULLIF("fullPrice", 0)) * 100, 2)::text)) || '%'
WHERE "ruleLabel" IS NULL
  AND "fullPrice" > 0
  AND "payNow" > 0
  AND ABS(("payNow" / "fullPrice") * 100 - ROUND(("payNow" / "fullPrice") * 100)) < 0.2
  AND ROUND(("payNow" / "fullPrice") * 100) BETWEEN 1 AND 99;

UPDATE "OrderSnapshot" AS o
SET
  "ruleSource" = 'Shop',
  "payRuleType" = s."payRuleType",
  "ruleValue" = CASE
    WHEN s."payRuleType" = 'percent' THEN s.percent
    WHEN s."payRuleType" = 'custom' THEN s."customAmount"
    WHEN s."payRuleType" = 'fixed' THEN COALESCE(s."fixedAmount", 500)
    ELSE o."ruleValue"
  END,
  "ruleLabel" = CASE
    WHEN s."payRuleType" = 'percent' THEN 'Shop · Percent ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM s.percent::text)) || '%'
    WHEN s."payRuleType" = 'custom' THEN 'Shop · Custom ₹' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM s."customAmount"::text))
    WHEN s."payRuleType" = 'fixed' THEN 'Shop · Fixed ₹500'
    ELSE o."ruleLabel"
  END
FROM "ShopSettingsSnapshot" AS s
WHERE o.shop = s.shop
  AND o."payNow" IS NOT NULL
  AND o."fullPrice" > 0
  AND (
    (s."payRuleType" = 'percent' AND ABS(o."payNow" - (o."fullPrice" * s.percent / 100)) < 0.05)
    OR (s."payRuleType" = 'fixed' AND o."payNow" = 500)
    OR (s."payRuleType" = 'custom' AND ABS(o."payNow" - s."customAmount") < 0.05)
  );
