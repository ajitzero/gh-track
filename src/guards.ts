/** Small runtime guards shared by parsers and stores. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Converts an unknown thrown value into a readable message. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
