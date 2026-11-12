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

