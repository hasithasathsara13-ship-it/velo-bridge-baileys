import test from "node:test";
import assert from "node:assert/strict";
import {
  applyOrderedLabelString,
  buildPhoneVariants,
  evaluateFollowUpCandidate,
  type FollowUpProduct,
} from "./followUpCron.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PRODUCTS: FollowUpProduct[] = [
  { name: "Classic Black Shirt", price: 1500, description: "Black cotton shirt" },
  { name: "Denim Jeans", price: 3200, description: "Blue denim" },
];

test("buildPhoneVariants covers raw, digits, +digits, and Sri Lankan local 07x <-> 947x formats", () => {
  const variants = buildPhoneVariants("94771234567@s.whatsapp.net");
  assert.ok(variants.includes("94771234567"));
  assert.ok(variants.includes("+94771234567"));
  assert.ok(variants.includes("0771234567"));

  const localVariants = buildPhoneVariants("0771234567");
  assert.ok(localVariants.includes("0771234567"));
  assert.ok(localVariants.includes("94771234567"));
  assert.ok(localVariants.includes("+94771234567"));
});

test("applyOrderedLabelString removes sys-product-asked and keeps sys-ordered", () => {
  assert.equal(applyOrderedLabelString("sys-product-asked"), "sys-ordered");
  assert.equal(applyOrderedLabelString("sys-product-asked, sys-handover"), "sys-handover,sys-ordered");
  assert.equal(applyOrderedLabelString(""), "sys-ordered");
});

test("skips customer with a Confirmed order within 3 days even if they asked about a product earlier", () => {
  const now = Date.parse("2026-11-12T10:00:00Z");
  const result = evaluateFollowUpCandidate({
    msgsNewestFirst: [
      { role: "model", content: "Thank you! Order confirmed.", created_at: new Date(now - 6 * HOUR).toISOString() },
      { role: "user", content: "No 12 Main Rd, Colombo 0771234567", created_at: new Date(now - 6 * HOUR - 60_000).toISOString() },
      { role: "user", content: "Classic Black Shirt price kiyada?", created_at: new Date(now - 7 * HOUR).toISOString() },
    ],
    ordersNewestFirst: [
      { id: "ord-1", status: "Confirmed", created_at: new Date(now - 6 * HOUR).toISOString() },
    ],
    products: PRODUCTS,
    quietWindowMs: 4 * HOUR,
    reminderKind: "checkout",
    now,
  });

  assert.equal(result.eligible, false);
  assert.equal(result.reason, "ordered");
  assert.equal(result.clearReminder, true);
  assert.equal(result.ensureOrderedLabel, true);
});

test("skips customer whose Confirmed order was >3 days ago when only post-order acknowledgement exists", () => {
  const now = Date.parse("2026-11-12T10:00:00Z");
  const orderAt = now - 4 * DAY;
  const result = evaluateFollowUpCandidate({
    msgsNewestFirst: [
      { role: "model", content: "You're welcome!", created_at: new Date(now - 10 * HOUR).toISOString() },
      { role: "user", content: "Thanks delivery kawadada?", created_at: new Date(now - 10 * HOUR - 30_000).toISOString() },
      { role: "model", content: "[ORDER_CREATED] 1 x Classic Black Shirt", created_at: new Date(orderAt).toISOString() },
      { role: "user", content: "Classic Black Shirt price kiyada? Photo ewanna", created_at: new Date(orderAt - 2 * HOUR).toISOString() },
    ],
    ordersNewestFirst: [
      { id: "ord-old", status: "Confirmed", created_at: new Date(orderAt).toISOString() },
    ],
    products: PRODUCTS,
    quietWindowMs: 4 * HOUR,
    now,
  });

  assert.equal(result.eligible, false);
  assert.equal(result.reason, "ordered");
  assert.equal(result.clearReminder, true);
});

test("skips when [ORDER_CREATED] marker exists and customer has not sent a new product inquiry afterwards", () => {
  const now = Date.parse("2026-11-12T10:00:00Z");
  const result = evaluateFollowUpCandidate({
    msgsNewestFirst: [
      { role: "model", content: "[ORDER_CREATED] 1 x Denim Jeans", created_at: new Date(now - 5 * HOUR).toISOString() },
      { role: "user", content: "hari confirm karanna", created_at: new Date(now - 5 * HOUR - 5_000).toISOString() },
      { role: "user", content: "Denim Jeans price?", created_at: new Date(now - 6 * HOUR).toISOString() },
    ],
    ordersNewestFirst: [],
    products: PRODUCTS,
    quietWindowMs: 4 * HOUR,
    now,
  });

  assert.equal(result.eligible, false);
  assert.equal(result.reason, "ordered");
  assert.equal(result.clearReminder, true);
});

test("sends follow-up ONLY for asked product when no non-cancelled order exists", () => {
  const now = Date.parse("2026-11-12T10:00:00Z");
  const result = evaluateFollowUpCandidate({
    msgsNewestFirst: [
      { role: "model", content: "Classic Black Shirt is Rs.1,500", created_at: new Date(now - 5 * HOUR).toISOString() },
      { role: "user", content: "Classic Black Shirt price kiyada?", created_at: new Date(now - 5 * HOUR - 10_000).toISOString() },
    ],
    ordersNewestFirst: [
      { id: "ord-cancelled", status: "Cancelled", created_at: new Date(now - 2 * DAY).toISOString() },
    ],
    products: PRODUCTS,
    quietWindowMs: 4 * HOUR,
    now,
  });

  assert.equal(result.eligible, true);
  if (result.eligible) {
    assert.equal(result.matchedProduct?.name, "Classic Black Shirt");
  }
});

const AMEE_PRODUCTS: FollowUpProduct[] = [
  {
    id: "prod-panties",
    shop_id: "shop-amee",
    name: "Cotton Panties V Cut",
    price: 0,
    price_variants: [
      { label: "03 PCS PACK", price: 650 },
      { label: "10 PCS PACK (M,L,XL)", price: 1300 },
    ],
    description: "Ladies Cotton Panties V Cut",
    is_active: true,
  },
  {
    id: "prod-linen",
    shop_id: "shop-amee",
    name: "LINEN CARGO PANT",
    price: 0,
    price_variants: [{ label: "03 PCS PACK", price: 1650 }],
    description: "Ladies Linen Cargo Pant",
    is_active: true,
  },
  {
    id: "prod-skinny",
    shop_id: "shop-amee",
    name: "Ladies Skinny",
    price: 1250,
    description: "Ladies Skinny",
    is_active: true,
  },
  {
    id: "prod-foreign",
    shop_id: "shop-other",
    name: "Cotton Panties Foreign",
    price: 9999,
    is_active: true,
  },
];

test("+94763011744 reproduction in Baileys cron: resolves Cotton Panties V Cut and never LINEN CARGO PANT", () => {
  const now = Date.parse("2026-11-14T03:32:58Z");
  const base = now - 10 * HOUR;
  const res = evaluateFollowUpCandidate({
    shopId: "shop-amee",
    msgsNewestFirst: [
      { role: "model", content: "Yes, Cash on Delivery (COD) is available! 😊", created_at: new Date(base + 120_000).toISOString() },
      { role: "user", content: "Cash on delevery available ?", created_at: new Date(base + 110_000).toISOString() },
      { role: "model", content: "No problem! Let me know if you need more info 😊", created_at: new Date(base + 70_000).toISOString() },
      { role: "user", content: "No no", created_at: new Date(base + 60_000).toISOString() },
      { role: "model", content: "A pack of 10 is Rs. 1,300. Delivery is Rs. 350, total Rs. 1,650.", created_at: new Date(base + 20_000).toISOString() },
      { role: "user", content: "How much", created_at: new Date(base + 10_000).toISOString() },
      { role: "user", content: "Can you tell me more about V Cut Panties?", created_at: new Date(base).toISOString() },
    ],
    ordersNewestFirst: [],
    products: AMEE_PRODUCTS,
    quietWindowMs: 4 * HOUR,
    now,
  });

  assert.equal(res.eligible, true);
  if (res.eligible) {
    assert.equal(res.matchedProduct?.name, "Cotton Panties V Cut");
  }
});

test("Baileys cron suppresses follow-up on explicit decline and ignores bot promo items", () => {
  const now = Date.parse("2026-11-14T10:00:00Z");
  const base = now - 6 * HOUR;

  const declined = evaluateFollowUpCandidate({
    shopId: "shop-amee",
    msgsNewestFirst: [
      { role: "user", content: "Not interested", created_at: new Date(base + 20_000).toISOString() },
      { role: "model", content: "Rs. 1,300", created_at: new Date(base + 10_000).toISOString() },
      { role: "user", content: "V Cut Panties price?", created_at: new Date(base).toISOString() },
    ],
    ordersNewestFirst: [],
    products: AMEE_PRODUCTS,
    quietWindowMs: 4 * HOUR,
    now,
  });
  assert.equal(declined.eligible, false);
  if (!declined.eligible) assert.equal(declined.reason, "declined");

  const withBotPromo = evaluateFollowUpCandidate({
    shopId: "shop-amee",
    msgsNewestFirst: [
      { role: "user", content: "COD available?", created_at: new Date(base + 40_000).toISOString() },
      { role: "model", content: "You might also like LINEN CARGO PANT Rs. 1,650!", created_at: new Date(base + 20_000).toISOString() },
      { role: "user", content: "Ladies Skinny price?", created_at: new Date(base).toISOString() },
    ],
    ordersNewestFirst: [],
    products: AMEE_PRODUCTS,
    quietWindowMs: 4 * HOUR,
    now,
  });
  assert.equal(withBotPromo.eligible, true);
  if (withBotPromo.eligible) {
    assert.equal(withBotPromo.matchedProduct?.name, "Ladies Skinny");
  }
});


