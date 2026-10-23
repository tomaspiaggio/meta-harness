/** Canonical JSON for logical arguments; object key order is not an action change. */
export function stableJson(value: unknown): string {
  const result = JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
  if (result === undefined)
    throw new Error("Operation arguments must be JSON-serializable.");
  return result;
}
