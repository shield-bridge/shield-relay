/** A client-facing error carrying an HTTP status. Thrown by the processor, mapped by routes. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
