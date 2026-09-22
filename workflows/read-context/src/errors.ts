export class ReadContextError extends Error {
  override name = "ReadContextError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
