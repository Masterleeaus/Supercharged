import type { RouteContext } from "../common";
import type { createCommsAuditSink } from "../../modules/comms/audit-sink.ts";

/** Route context shared by the core route modules (see server/routes/common.ts). */
export type { RouteContext };

/** Return type of createCommsAuditSink, passed into the comms routes. */
export type CommsAuditSink = ReturnType<typeof createCommsAuditSink>;
