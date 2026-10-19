/** Single-document JSON serialization for stdout. */

export function renderJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  return `${text === undefined ? 'null' : text}\n`;
}
