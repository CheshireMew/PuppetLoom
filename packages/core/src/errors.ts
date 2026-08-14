export type PuppetLoomErrorCode = "INVALID_INPUT" | "OUTPUT_NOT_EMPTY" | "IO_ERROR" | "INVALID_PROJECT";

export class PuppetLoomError extends Error {
  readonly code: PuppetLoomErrorCode;

  constructor(code: PuppetLoomErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PuppetLoomError";
    this.code = code;
  }
}
