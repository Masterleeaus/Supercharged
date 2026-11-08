// Chatbot customers and tags tests (node:test). No database, no Express, no node_modules.
// Covers customer create and lookup, identity normalisation, duplicate detection and merge, tag assignment
// and removal, duplicate prevention, company isolation, tenant rejection and the default-off feature flags.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createCustomerService,
  lightenColor,
  normalizeIdentifier,
  readCustomerFlags,
} from "../../server/modules/chatbot/customers/customer-service.ts";
import { createMemoryCustomerStorage } from "../../server/modules/chatbot/customers/customer-storage.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const FLAGS_ON = { customers: true, tags: true, merge: true };

// ---------- fixtures ----------

function setup(flags = FLAGS_ON) {
  const storage = createMemoryCustomerStorage();
  // Conversations live in the chatbot module. Each company owns its own, keyed here as company:conversation.
  const conversations = new Set([
    `${COMPANY_A}:conv-a1`,
    `${COMPANY_A}:conv-a2`,
    `${COMPANY_B}:conv-b1`,
  ]);
  // Each call moves the clock forward by one minute, so createdAt ordering is deterministic.
  let tick = 0;
  const service = createCustomerService({
    storage,
    conversationExists: async (companyId, id) => conversations.has(`${companyId}:${id}`),
    flags: () => flags,
    now: () => new Date(Date.UTC(2026, 10, 8, 0, tick++)),
  });
  return { storage, service };
}

async function expectStatus(promise, status) {
  await assert.rejects(promise, (err) => err.status === status);
}

// ---------- customers ----------

test("creates a customer and looks it up by id inside its own company", async () => {
  const { service } = setup();
  const created = await service.createCustomer(COMPANY_A, {
    name: "  Jane Smith ",
    email: "jane@example.com",
    phone: "+61 412 345 678",
    enabledSound: false,
  });
  assert.equal(created.name, "Jane Smith");
  assert.equal(created.companyId, COMPANY_A);
  assert.equal(created.enabledSound, false);

  const found = await service.getCustomer(COMPANY_A, created.id);
  assert.equal(found?.email, "jane@example.com");
  assert.equal(await service.getCustomer(COMPANY_B, created.id), null);
});

test("sound preference defaults to on, as in the source migration", async () => {
  const { service } = setup();
  const created = await service.createCustomer(COMPANY_A, { name: "Sam" });
  assert.equal(created.enabledSound, true);
});

test("listContacts returns only customers with an email, newest first", async () => {
  const { service } = setup();
  const older = await service.createCustomer(COMPANY_A, { name: "Older", email: "older@example.com" });
  await service.createCustomer(COMPANY_A, { name: "No email" });
  const newer = await service.createCustomer(COMPANY_A, { name: "Newer", email: "newer@example.com" });

  const contacts = await service.listContacts(COMPANY_A);
  assert.deepEqual(
    contacts.map((row) => row.id),
    [newer.id, older.id],
  );
});

test("update requires name, email and phone, and the error does not echo the rejected value", async () => {
  const { service } = setup();
  const created = await service.createCustomer(COMPANY_A, { name: "Lee", email: "lee@example.com", phone: "0400" });

  await assert.rejects(
    service.updateCustomer(COMPANY_A, created.id, { name: "Lee", email: "lee@example.com", phone: "   " }),
    (err) => err.status === 422 && /phone is required/.test(err.message),
  );

  await assert.rejects(
    service.updateCustomer(COMPANY_A, created.id, { name: "Lee", email: "lee@example.com", phone: 12345678 }),
    (err) => err.status === 422 && err.message === "phone must be a string" && !err.message.includes("12345678"),
  );

  const updated = await service.updateCustomer(COMPANY_A, created.id, {
    name: "Lee Park",
    email: "lee@example.com",
    phone: "0400 000 111",
  });
  assert.equal(updated.name, "Lee Park");
});

test("lookupCustomer matches phone numbers by digits and emails case-insensitively", async () => {
  const { service } = setup();
  const customer = await service.createCustomer(COMPANY_A, { name: "Ana", email: "ana@example.com" });
  await service.linkIdentity(COMPANY_A, customer.id, "phone", "+61 412 345 678");
  await service.linkIdentity(COMPANY_A, customer.id, "email", "Ana@Example.com");

  assert.equal((await service.lookupCustomer(COMPANY_A, "phone", "(+61) 412-345-678"))?.id, customer.id);
  assert.equal((await service.lookupCustomer(COMPANY_A, "email", "ana@example.com "))?.id, customer.id);
  assert.equal(await service.lookupCustomer(COMPANY_A, "phone", "+61 499 999 999"), null);
});

test("normalizeIdentifier keeps digits for phone channels and rejects an empty result", () => {
  assert.equal(normalizeIdentifier("whatsapp", " +61-412 345 678 "), "61412345678");
  assert.equal(normalizeIdentifier("email", " Foo@Bar.COM "), "foo@bar.com");
  assert.throws(() => normalizeIdentifier("phone", "---"), (err) => err.status === 422);
});

test("findDuplicates reports identities held by another customer, matching on digits across channels", async () => {
  const { service } = setup();
  const first = await service.createCustomer(COMPANY_A, { name: "First", email: "first@example.com" });
  const second = await service.createCustomer(COMPANY_A, { name: "Second", email: "second@example.com" });
  await service.linkIdentity(COMPANY_A, first.id, "phone", "0412 345 678");
  await service.linkIdentity(COMPANY_A, second.id, "whatsapp", "0412-345-678");

  const duplicates = await service.findDuplicates(COMPANY_A, first.id);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].customerId, second.id);
  assert.equal(duplicates[0].channel, "whatsapp");
  assert.equal(duplicates[0].normalizedIdentifier, "0412345678");
});

test("linking an identity that another customer holds moves it, as the source updateOrCreate does", async () => {
  const { service } = setup();
  const first = await service.createCustomer(COMPANY_A, { name: "First" });
  const second = await service.createCustomer(COMPANY_A, { name: "Second" });
  await service.linkIdentity(COMPANY_A, first.id, "phone", "0412 345 678");
  await service.linkIdentity(COMPANY_A, second.id, "phone", "0412-345-678");

  assert.equal((await service.lookupCustomer(COMPANY_A, "phone", "0412345678"))?.id, second.id);
  assert.deepEqual(await service.findDuplicates(COMPANY_A, first.id), []);
});

test("mergeCustomers moves identities and conversation links, then removes the source", async () => {
  const { service, storage } = setup();
  const target = await service.createCustomer(COMPANY_A, { name: "Target", email: "t@example.com" });
  const source = await service.createCustomer(COMPANY_A, { name: "Source", email: "s@example.com" });
  await service.linkIdentity(COMPANY_A, source.id, "phone", "0400 111 222");
  await service.linkConversationToCustomer(COMPANY_A, "conv-a1", source.id);

  const result = await service.mergeCustomers(COMPANY_A, target.id, source.id);
  assert.deepEqual(result, { identitiesMoved: 1, conversationsMoved: 1 });

  assert.equal(await service.getCustomer(COMPANY_A, source.id), null);
  assert.equal((await service.lookupCustomer(COMPANY_A, "phone", "0400111222"))?.id, target.id);
  assert.equal(await storage.findConversationCustomerId(COMPANY_A, "conv-a1"), target.id);
});

test("mergeCustomers rejects a self-merge and a missing source", async () => {
  const { service } = setup();
  const only = await service.createCustomer(COMPANY_A, { name: "Only" });
  await expectStatus(service.mergeCustomers(COMPANY_A, only.id, only.id), 422);
  await expectStatus(service.mergeCustomers(COMPANY_A, only.id, "99999999-9999-4999-8999-999999999999"), 404);
});

test("deleting a customer removes its identities and conversation links, and keeps the conversation", async () => {
  const { service, storage } = setup();
  const customer = await service.createCustomer(COMPANY_A, { name: "Gone", email: "gone@example.com" });
  await service.linkIdentity(COMPANY_A, customer.id, "phone", "0400 999 000");
  await service.linkConversationToCustomer(COMPANY_A, "conv-a2", customer.id);

  await service.deleteCustomer(COMPANY_A, customer.id);

  assert.equal(await service.getCustomer(COMPANY_A, customer.id), null);
  assert.equal(await service.lookupCustomer(COMPANY_A, "phone", "0400999000"), null);
  assert.equal(await storage.findConversationCustomerId(COMPANY_A, "conv-a2"), null);
});

// ---------- tags ----------

test("createTag stores a background colour lightened from the tag colour, and rejects a blank name", async () => {
  const { service } = setup();
  const tag = await service.createTag(COMPANY_A, { tag: "VIP", tagColor: "#000000" });
  assert.equal(tag.tag, "VIP");
  assert.equal(tag.tagColor, "#000000");
  assert.equal(tag.backgroundColor, "#8c8c8c");
  await assert.rejects(service.createTag(COMPANY_A, { tag: "   " }), (err) => err.status === 422);
});

test("lightenColor mixes #rgb and #rrggbb toward white and returns null for anything else", () => {
  assert.equal(lightenColor("#fff", 55), "#ffffff");
  assert.equal(lightenColor("#000", 100), "#ffffff");
  assert.equal(lightenColor("#000000", 0), "#000000");
  assert.equal(lightenColor("red", 55), null);
});

test("listTags returns tags sorted by name", async () => {
  const { service } = setup();
  await service.createTag(COMPANY_A, { tag: "Zeta" });
  await service.createTag(COMPANY_A, { tag: "Alpha" });
  assert.deepEqual(
    (await service.listTags(COMPANY_A)).map((row) => row.tag),
    ["Alpha", "Zeta"],
  );
});

test("assignTags replaces the conversation's tag set and drops tags left out", async () => {
  const { service } = setup();
  const t1 = await service.createTag(COMPANY_A, { tag: "One" });
  const t2 = await service.createTag(COMPANY_A, { tag: "Two" });

  await service.assignTags(COMPANY_A, "conv-a1", [t1.id, t2.id]);
  await service.assignTags(COMPANY_A, "conv-a1", [t2.id]);

  const view = await service.listConversationTags(COMPANY_A, "conv-a1");
  assert.deepEqual(view.assigned, [t2.id]);
  assert.equal(view.tags.length, 2);
});

test("duplicate tag prevention: adding the same tag twice stores one assignment", async () => {
  const { service } = setup();
  const tag = await service.createTag(COMPANY_A, { tag: "Lead" });

  assert.equal(await service.addTag(COMPANY_A, "conv-a1", tag.id), true);
  assert.equal(await service.addTag(COMPANY_A, "conv-a1", tag.id), false);
  assert.deepEqual((await service.listConversationTags(COMPANY_A, "conv-a1")).assigned, [tag.id]);
});

test("duplicate tag ids in one assign call collapse to a single assignment", async () => {
  const { service } = setup();
  const tag = await service.createTag(COMPANY_A, { tag: "Dup" });
  const assigned = await service.assignTags(COMPANY_A, "conv-a2", [tag.id, tag.id, tag.id]);
  assert.deepEqual(assigned, [tag.id]);
});

test("removeTag removes one assignment and reports whether it existed", async () => {
  const { service } = setup();
  const tag = await service.createTag(COMPANY_A, { tag: "Temp" });
  await service.addTag(COMPANY_A, "conv-a1", tag.id);

  assert.equal(await service.removeTag(COMPANY_A, "conv-a1", tag.id), true);
  assert.equal(await service.removeTag(COMPANY_A, "conv-a1", tag.id), false);
  assert.deepEqual((await service.listConversationTags(COMPANY_A, "conv-a1")).assigned, []);
});

test("assignTags rejects an unknown tag id", async () => {
  const { service } = setup();
  await expectStatus(service.assignTags(COMPANY_A, "conv-a1", ["00000000-0000-4000-8000-000000000000"]), 422);
});

test("deleting a tag removes its assignments", async () => {
  const { service } = setup();
  const tag = await service.createTag(COMPANY_A, { tag: "Bin" });
  await service.addTag(COMPANY_A, "conv-a1", tag.id);

  await service.deleteTag(COMPANY_A, tag.id);

  assert.deepEqual((await service.listConversationTags(COMPANY_A, "conv-a1")).assigned, []);
  await expectStatus(service.deleteTag(COMPANY_A, tag.id), 404);
});

// ---------- company isolation ----------

test("a tag or customer in company A is invisible to company B", async () => {
  const { service } = setup();
  const customer = await service.createCustomer(COMPANY_A, { name: "Private", email: "p@example.com" });
  const tag = await service.createTag(COMPANY_A, { tag: "Secret" });
  await service.addTag(COMPANY_A, "conv-a1", tag.id);

  assert.deepEqual(await service.listTags(COMPANY_B), []);
  assert.deepEqual(await service.listContacts(COMPANY_B), []);
  assert.equal(await service.getCustomer(COMPANY_B, customer.id), null);
  await expectStatus(service.updateCustomer(COMPANY_B, customer.id, { name: "x", email: "x", phone: "1" }), 404);
  await expectStatus(service.deleteTag(COMPANY_B, tag.id), 404);
});

test("company B cannot assign company A's tag, or tag a conversation that belongs to company A", async () => {
  const { service } = setup();
  const tag = await service.createTag(COMPANY_A, { tag: "A only" });

  await expectStatus(service.assignTags(COMPANY_B, "conv-b1", [tag.id]), 422);
  await expectStatus(service.addTag(COMPANY_B, "conv-b1", tag.id), 422);
  await expectStatus(service.listConversationTags(COMPANY_B, "conv-a1"), 404);
  await expectStatus(service.assignTags(COMPANY_B, "conv-a1", []), 404);
});

test("the same phone number can be held in both companies, and each lookup stays in its company", async () => {
  const { service } = setup();
  const inA = await service.createCustomer(COMPANY_A, { name: "A", email: "a@example.com" });
  const inB = await service.createCustomer(COMPANY_B, { name: "B", email: "b@example.com" });
  await service.linkIdentity(COMPANY_A, inA.id, "phone", "0411 222 333");
  await service.linkIdentity(COMPANY_B, inB.id, "phone", "0411 222 333");

  assert.equal((await service.lookupCustomer(COMPANY_A, "phone", "0411222333"))?.id, inA.id);
  assert.equal((await service.lookupCustomer(COMPANY_B, "phone", "0411222333"))?.id, inB.id);
});

test("a missing or malformed tenant id is rejected by the service and by storage", async () => {
  const { service, storage } = setup();
  for (const bad of [undefined, null, "", "not-a-uuid", 42]) {
    await expectStatus(service.createCustomer(bad, { name: "x" }), 403);
    await expectStatus(service.listTags(bad), 403);
    await assert.rejects(storage.listCustomers(bad), (err) => /Company scope required/.test(err.message));
    await assert.rejects(storage.findTag(bad, "any"), (err) => /Company scope required/.test(err.message));
  }
});

// ---------- feature flags ----------

test("feature flags default OFF, and every customer and tag call is refused", async () => {
  assert.deepEqual(readCustomerFlags({}), { customers: false, tags: false, merge: false });

  const { service } = setup({ customers: false, tags: false, merge: false });
  await expectStatus(service.createCustomer(COMPANY_A, { name: "x" }), 404);
  await expectStatus(service.createTag(COMPANY_A, { tag: "x" }), 404);
});

test("merge needs its own switch even when customers is on", async () => {
  const { service } = setup({ customers: true, tags: false, merge: false });
  const a = await service.createCustomer(COMPANY_A, { name: "a" });
  const b = await service.createCustomer(COMPANY_A, { name: "b" });
  await expectStatus(service.mergeCustomers(COMPANY_A, a.id, b.id), 404);
});

test("readCustomerFlags turns each switch on only for the exact value true (rule L3)", () => {
  assert.deepEqual(
    readCustomerFlags({
      CHATBOT_CUSTOMERS_ENABLED: "true",
      CHATBOT_CUSTOMER_TAGS_ENABLED: "yes",
      CHATBOT_CUSTOMER_MERGE_ENABLED: "maybe",
    }),
    { customers: true, tags: false, merge: false },
  );
  for (const value of ["1", "on", "TRUE", " true "]) {
    assert.equal(readCustomerFlags({ CHATBOT_CUSTOMERS_ENABLED: value }).customers, false, `${JSON.stringify(value)} must not enable`);
  }
});
