import type { ErrorCode } from "./types.js";

/** An error Porch reports as `{ schema, error: { code, message } }` with the code's exit status. */
export class PorchError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
