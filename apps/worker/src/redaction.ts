/** Exact-value redaction across arbitrary stream chunks, without retaining a transcript. */
export class SecretRedactor {
  private pending = "";
  private values: string[];
  constructor(values: string[]) {
    this.values = [...new Set(values.filter(Boolean))].sort(
      (a, b) => b.length - a.length,
    );
  }
  redact(value: string): string {
    for (const secret of this.values)
      value = value.split(secret).join("[REDACTED]");
    return value;
  }
  sanitize<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as T;
    if (Array.isArray(value))
      return value.map((item) => this.sanitize(item)) as T;
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.sanitize(item)]),
      ) as T;
    return value;
  }
  push(text: string, final = false): string {
    this.pending += text;
    let boundary = this.pending.length;
    if (!final) {
      // Retain only an actual credential prefix, so ordinary text streams immediately.
      for (const secret of this.values) {
        for (
          let size = Math.min(secret.length - 1, this.pending.length);
          size > this.pending.length - boundary;
          size--
        ) {
          if (secret.startsWith(this.pending.slice(-size))) {
            boundary = this.pending.length - size;
            break;
          }
        }
      }
      // A split UTF-16 pair must not reach an independently encoded HTTP body.
      if (/[\uD800-\uDBFF]$/.test(this.pending))
        boundary = Math.min(boundary, this.pending.length - 1);
    }
    if (
      boundary > 0 &&
      /[\uD800-\uDBFF]/.test(this.pending[boundary - 1]) &&
      /[\uDC00-\uDFFF]/.test(this.pending[boundary] ?? "")
    )
      boundary--;
    let cursor = 0;
    let result = "";
    while (cursor < boundary) {
      let first = -1;
      let selected = "";
      for (const secret of this.values) {
        const at = this.pending.indexOf(secret, cursor);
        if (at >= 0 && (first < 0 || at < first)) {
          first = at;
          selected = secret;
        }
      }
      if (first < 0 || first >= boundary) {
        result += this.pending.slice(cursor, boundary);
        cursor = boundary;
        break;
      }
      result += `${this.pending.slice(cursor, first)}[REDACTED]`;
      cursor = first + selected.length;
    }
    this.pending = this.pending.slice(cursor);
    return result;
  }
  canCheckpoint(): boolean {
    // Persist progress only when every preceding output byte is durable. Pending
    // credential prefixes stay in memory and are never copied into a checkpoint.
    return this.pending.length === 0;
  }
  contains(bytes: Uint8Array): boolean {
    const value = Buffer.from(bytes);
    return this.values.some((secret) => value.includes(Buffer.from(secret)));
  }
}
