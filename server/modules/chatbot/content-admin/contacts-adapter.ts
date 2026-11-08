/**
 * Contact reader over the customers slice. Read only.
 *
 * It calls the public CustomerStorage methods, which DrizzleCustomerStorage (db/customers-storage.ts) implements
 * with company_id filters on every query. Each record is mapped to the ContactSummary view, so fields the screen
 * does not show (ip address, payload, communication preferences, session id) never leave this module.
 * A row whose companyId differs from the argument is treated as absent, as a second check on top of the storage.
 */
import { requireCompanyId } from "../chatbot-scope.ts";
import type { CustomerRecord, CustomerStorage } from "../customers/customer-storage.ts";
import type { ContactReader, ContactSummary } from "./types.ts";

/** The two read methods of the customers storage. Anything else on the storage is not used here. */
export type CustomerReadPort = Pick<CustomerStorage, "listCustomers" | "findCustomer">;

export function toContactSummary(row: CustomerRecord): ContactSummary {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    email: row.email,
    phone: row.phone,
    chatbotId: row.chatbotId,
    chatbotChannel: row.chatbotChannel,
    preferredLanguage: row.preferredLanguage,
    createdAt: row.createdAt,
  };
}

export function createContactReader(customers: CustomerReadPort): ContactReader {
  return {
    async listContacts(companyId) {
      const cid = requireCompanyId(companyId);
      const rows = await customers.listCustomers(cid);
      return rows.filter((row) => row.companyId === cid).map(toContactSummary);
    },
    async findContact(companyId, id) {
      const cid = requireCompanyId(companyId);
      const row = await customers.findCustomer(cid, id);
      return row && row.companyId === cid ? toContactSummary(row) : null;
    },
  };
}
