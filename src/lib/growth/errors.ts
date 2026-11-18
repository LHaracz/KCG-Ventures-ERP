/** Errors from Marketing & Sales server code, mapped to HTTP status by the routes. */
export class GrowthError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
export function idOrThrow(v: unknown, what: string): string {
  if (!isUuid(v)) throw new GrowthError(`Unknown ${what}.`, 404);
  return v;
}
