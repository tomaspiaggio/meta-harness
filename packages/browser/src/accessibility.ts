/** Keep control labels/roles, but never include form input values in agent reads. */
export function redactFormValues(snapshot: string): string {
  const result: string[] = [];
  let omittedIndent: number | undefined;
  for (const line of snapshot.split("\n")) {
    const indent = line.length - line.trimStart().length;
    if (omittedIndent !== undefined && indent > omittedIndent) continue;
    omittedIndent = undefined;
    if (!/^\s*- (?:textbox|searchbox|combobox|spinbutton)\b/.test(line)) {
      result.push(line);
      continue;
    }
    let quoted = false;
    let escaped = false;
    let end = line.length;
    for (let i = 0; i < line.length; i++) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (line[i] === "\\") {
        escaped = true;
        continue;
      }
      if (line[i] === '"') quoted = !quoted;
      if (line[i] === ":" && !quoted) {
        end = i;
        break;
      }
    }
    result.push(`${line.slice(0, end)}: [input value omitted]`);
    omittedIndent = indent;
  }
  return result.join("\n");
}
