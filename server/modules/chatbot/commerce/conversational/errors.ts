/**
 * Error shape for the conversational commerce slice. Messages are safe to show a customer: they never carry
 * credential values, token values, or another tenant's identifiers.
 */
export type CommerceErrorCode =
  | "validation"
  | "not_found"
  | "forbidden"
  | "invalid_token"
  | "expired"
  | "conflict"
  | "flag_disabled"
  | "unsupported";

export class CommerceError extends Error {
  readonly code: CommerceErrorCode;
  readonly fields: Record<string, string>;

  constructor(code: CommerceErrorCode, message: string, fields: Record<string, string> = {}) {
    super(message);
    this.name = "CommerceError";
    this.code = code;
    this.fields = fields;
  }
}
