import * as leadAccess from "../../../apps/web/lib/work-orders/lead-access.ts";

const completeAssignedWorkOrder = leadAccess.completeAssignedWorkOrder
  ?? leadAccess.default?.completeAssignedWorkOrder;
if (typeof completeAssignedWorkOrder !== "function") throw new Error("workforce-native-work-order-owner-unavailable");

/** Thin production adapter over the existing native TypeScript owner. */
export function createNativeWorkOrders() {
  return Object.freeze({
    async read(input) {
      input.signal?.throwIfAborted();
      const rows = await input.companyStorage.query(
        "SELECT id,status,completed_at FROM work_orders WHERE company_id=$1 AND id=$2 AND assigned_user_id=$3",
        [input.company_id, input.work_order_id, input.actor_id],
      );
      input.signal?.throwIfAborted();
      return rows.rows[0] ?? null;
    },
    async complete(input) {
      input.signal?.throwIfAborted();
      if (typeof input.authorityFence?.assertCurrent !== "function") {
        throw new Error("workforce-authority-fence-required");
      }
      const result = await input.companyStorage.transaction(tx => completeAssignedWorkOrder(
        tx, input.work_order_id, input.company_id, input.actor_id, input.authorityFence,
      ));
      input.signal?.throwIfAborted();
      return result;
    },
  });
}
