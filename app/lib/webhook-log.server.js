import prisma from "../db.server";

function nowIst() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(new Date())
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} IST`;
}

function personName(obj = {}) {
  const full = String(obj.name || obj.displayName || "").trim();
  const parts = [obj.first_name || obj.firstName, obj.last_name || obj.lastName]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ");
  return full || parts;
}

export function customerFromOrderPayload(payload) {
  const customer = payload?.customer || {};
  const billing = payload?.billing_address || payload?.billingAddress || {};
  const shipping = payload?.shipping_address || payload?.shippingAddress || {};
  const name =
    personName(shipping) || personName(billing) || personName(customer) || "";
  const email = String(
    payload?.email ||
      payload?.contact_email ||
      payload?.contactEmail ||
      customer.email ||
      billing.email ||
      shipping.email ||
      "",
  ).trim();
  return {
    customerName: name ? name.slice(0, 200) : null,
    customerEmail: email ? email.slice(0, 200) : null,
  };
}

export async function enrichCustomerFromAdmin(admin, orderId, customer = {}) {
  const next = { ...customer };
  if (!admin || !orderId) return next;
  if (next.customerName) return next;
  try {
    const response = await admin.graphql(
      `#graphql
        query WebhookLogOrderCustomer($id: ID!) {
          order(id: $id) {
            customer { displayName firstName lastName }
            shippingAddress { name firstName lastName }
            billingAddress { name firstName lastName }
          }
        }
      `,
      { variables: { id: orderId } },
    );
    const json = await response.json();
    const order = json?.data?.order;
    if (!order) return next;
    const name =
      personName(order.shippingAddress) ||
      personName(order.billingAddress) ||
      personName(order.customer) ||
      "";
    if (!next.customerName && name) next.customerName = name.slice(0, 200);
  } catch (error) {
    console.warn("[partial-payment] webhook customer lookup failed", error.message);
  }
  return next;
}

export async function recordWebhookLog({
  shop,
  topic,
  orderId,
  customerName,
  customerEmail,
  ok,
  reason,
}) {
  const id = crypto.randomUUID();
  const ist = nowIst();
  const shopValue = String(shop || "");
  const topicValue = String(topic || "");
  const name = customerName ? String(customerName).slice(0, 200) : null;
  const email = customerEmail ? String(customerEmail).slice(0, 200) : null;
  const reasonText = reason ? String(reason).slice(0, 500) : null;
  const okValue = ok !== false;
  try {
    if (orderId) {
      const orderValue = String(orderId);
      await prisma.$executeRaw`
        INSERT INTO "WebhookLog" (
          id, shop, topic, "orderId", "customerName", "customerEmail",
          "createdAtIst", ok, reason
        )
        VALUES (
          ${id}, ${shopValue}, ${topicValue}, ${orderValue}, ${name}, ${email},
          ${ist}, ${okValue}, ${reasonText}
        )
        ON CONFLICT (shop, "orderId") DO UPDATE SET
          topic = EXCLUDED.topic,
          "customerName" = COALESCE(EXCLUDED."customerName", "WebhookLog"."customerName"),
          "customerEmail" = COALESCE(EXCLUDED."customerEmail", "WebhookLog"."customerEmail"),
          "createdAtIst" = EXCLUDED."createdAtIst",
          ok = EXCLUDED.ok,
          reason = EXCLUDED.reason,
          "createdAt" = NOW()
      `;
      return;
    }
    await prisma.$executeRaw`
      INSERT INTO "WebhookLog" (id, shop, topic, "orderId", "customerName", "customerEmail", "createdAtIst", ok, reason)
      VALUES (
        ${id},
        ${shopValue},
        ${topicValue},
        ${orderId ? String(orderId) : null},
        ${name},
        ${email},
        ${ist},
        ${okValue},
        ${reasonText}
      )
    `;
  } catch (error) {
    console.warn("[partial-payment] webhook log failed", error.message);
  }
}
