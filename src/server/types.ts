export type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown, message: string): JsonObject {
  if (!isRecord(value)) throw new TypeError(message);
  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
