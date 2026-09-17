CREATE TABLE "ShopSettingsSnapshot" (
    "shop" TEXT NOT NULL,
    "shopId" TEXT,
    "shopName" TEXT,
    "currencyCode" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "productScope" TEXT,
    "allProductsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "payRuleType" TEXT,
    "fixedAmount" DECIMAL(14,2),
    "percent" DECIMAL(7,2),
    "customAmount" DECIMAL(14,2),
    "surcharge" DECIMAL(14,2),
    "fullyCodEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ruleCollectionIds" JSONB NOT NULL DEFAULT '[]',
    "ruleCollections" JSONB NOT NULL DEFAULT '[]',
    "ruleTags" JSONB NOT NULL DEFAULT '[]',
    "productOverrides" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopSettingsSnapshot_pkey" PRIMARY KEY ("shop")
);

CREATE TABLE "ProductRuleSnapshot" (
    "shopProductKey" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT,
    "handle" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "explicitOff" BOOLEAN NOT NULL DEFAULT false,
    "payRuleType" TEXT,
    "fixedAmount" DECIMAL(14,2),
    "percent" DECIMAL(7,2),
    "customAmount" DECIMAL(14,2),
    "surcharge" DECIMAL(14,2),
    "fullyCodEnabled" BOOLEAN,
    "skus" JSONB NOT NULL DEFAULT '[]',
    "tags" JSONB NOT NULL DEFAULT '[]',
    "collectionIds" JSONB NOT NULL DEFAULT '[]',
    "collections" JSONB NOT NULL DEFAULT '[]',
    "config" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductRuleSnapshot_pkey" PRIMARY KEY ("shopProductKey")
);

CREATE INDEX "ProductRuleSnapshot_shop_idx" ON "ProductRuleSnapshot"("shop");

CREATE TABLE "ScheduledRuleSnapshot" (
    "shopRuleKey" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "name" TEXT,
    "action" TEXT,
    "status" TEXT,
    "targetType" TEXT,
    "targetIds" JSONB NOT NULL DEFAULT '[]',
    "targetTags" JSONB NOT NULL DEFAULT '[]',
    "targetPreviews" JSONB NOT NULL DEFAULT '[]',
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "payRuleType" TEXT,
    "fixedAmount" DECIMAL(14,2),
    "percent" DECIMAL(7,2),
    "customAmount" DECIMAL(14,2),
    "surcharge" DECIMAL(14,2),
    "fullyCodEnabled" BOOLEAN,
    "rule" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledRuleSnapshot_pkey" PRIMARY KEY ("shopRuleKey")
);

CREATE INDEX "ScheduledRuleSnapshot_shop_idx" ON "ScheduledRuleSnapshot"("shop");

CREATE TABLE "OrderSnapshot" (
    "shopOrderKey" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT,
    "customerName" TEXT,
    "customerEmail" TEXT,
    "shopifyFinancialStatus" TEXT,
    "partialPaymentStatus" TEXT,
    "payNow" DECIMAL(14,2),
    "remainingCod" DECIMAL(14,2),
    "collectedCod" DECIMAL(14,2),
    "fullPrice" DECIMAL(14,2),
    "invoiceScheduled" BOOLEAN NOT NULL DEFAULT false,
    "invoiceSent" BOOLEAN NOT NULL DEFAULT false,
    "invoiceMode" TEXT,
    "invoiceDays" INTEGER,
    "invoiceDueAt" TIMESTAMP(3),
    "invoiceSentAt" TIMESTAMP(3),
    "collectedVia" TEXT,
    "tags" JSONB NOT NULL DEFAULT '[]',
    "lineDetails" JSONB NOT NULL DEFAULT '[]',
    "orderCreatedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderSnapshot_pkey" PRIMARY KEY ("shopOrderKey")
);

CREATE INDEX "OrderSnapshot_shop_updatedAt_idx" ON "OrderSnapshot"("shop", "updatedAt");
