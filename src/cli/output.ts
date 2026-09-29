/** Every `porch` command prints one JSON document per line on stdout. */
export function jsonLine(value: unknown): string {
  return JSON.stringify(value) + "\n";
}
