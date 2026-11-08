/**
 * Error type for the orders module. Status 422 matches the Laravel ValidationException the PHP runtime
 * throws. 404 is used for rows that are missing or outside the caller's scope.
 */
export class OrderError extends Error {
  readonly status: number;

  constructor(message: string, status = 422) {
    super(message);
    this.name = "OrderError";
    this.status = status;
  }
}
