import type { NextFunction, Response, Request } from "express";

export class AppError extends Error {
  status: number = 500;
  causeMessage?: string;

  constructor(status: number, message: string, causeMessage?: string) {
    super(message);
    this.status = status;
    this.causeMessage = causeMessage;
  }
}

/* eslint-disable @typescript-eslint/no-unused-vars */
export function errorHandler(
  err: AppError,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  console.error(
    `[${new Date().toISOString()}] Error: ${err.message} 
    at ${req.method} ${req.originalUrl} with ${err.stack ?? "no stack trace"}
    ${err.causeMessage ? `Cause: ${err.causeMessage}` : ""}`
  );

  const status = typeof err.status === "number" ? err.status : 500;

  // Include `causeMessage` (the underlying CLI stderr / wrapped error) as
  // `details` in the response. Bambuddy reads this field to surface the
  // actual slice-rejection reason in its own log instead of the generic
  // top-level `Failed to slice the model`. Without it, every CLI failure
  // looks the same on the calling side and the embedded-settings fallback
  // hides the real cause.
  const body: { message: string; details?: string } = { message: err.message };
  if (err.causeMessage) {
    body.details = err.causeMessage;
  }
  res.status(status).json(body);
}
