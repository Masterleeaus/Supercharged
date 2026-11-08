/** Shared result shapes for the conversational commerce slice. */
export interface ApprovedActionResult {
  status: "completed";
  /** True when the action had already run and the stored result is returned without running it again. */
  replay: boolean;
  actionId: string;
  result: Record<string, unknown>;
}
