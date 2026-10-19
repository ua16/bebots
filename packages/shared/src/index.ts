/**
 * Small shared utilities. Keep this package tiny; do not put domain or
 * application logic here.
 */

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
