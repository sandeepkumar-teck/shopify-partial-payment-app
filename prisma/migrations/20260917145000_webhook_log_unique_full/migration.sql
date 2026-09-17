DROP INDEX IF EXISTS "WebhookLog_shop_orderId_key";

DELETE FROM "WebhookLog" AS keep
WHERE keep."orderId" IS NOT NULL
AND keep.ctid NOT IN (
  SELECT DISTINCT ON ("shop", "orderId") ctid
  FROM "WebhookLog"
  WHERE "orderId" IS NOT NULL
  ORDER BY "shop", "orderId", "createdAt" DESC
);

CREATE UNIQUE INDEX "WebhookLog_shop_orderId_key"
ON "WebhookLog"("shop", "orderId");
