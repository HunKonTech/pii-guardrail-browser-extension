export function redactBounded(
  value: string,
  sensitiveValues: readonly string[],
  maximumLength: number,
): string {
  let result = value.replace(/[\r\n]+/g, ' ');
  for (const sensitive of sensitiveValues) {
    if (sensitive) result = result.split(sensitive).join('[redacted]');
  }
  return result.slice(0, maximumLength);
}
