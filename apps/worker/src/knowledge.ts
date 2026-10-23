import { constants } from "node:fs";
import { open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type DecisionSnapshot,
  type DecisionUpdate,
  parseDecisionUpdates,
} from "@harness/core/knowledge";

const filename = "DECISION_UPDATES.json";
async function replace(path: string, content: string): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}
async function readUpdates(directory: string): Promise<string> {
  const file = await open(
    join(directory, filename),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65536)
      throw new Error(
        "Decision updates must be a regular JSON file of at most 64 KiB.",
      );
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}
export async function prepareDecisionFiles(
  directory: string,
  snapshot: DecisionSnapshot,
): Promise<void> {
  try {
    const previous = await readUpdates(directory);
    if (previous.trim() && previous.trim() !== "[]")
      await writeFile(
        join(
          directory,
          `DECISION_UPDATES.unpublished.${crypto.randomUUID()}.json`,
        ),
        previous,
        { flag: "wx", mode: 0o600 },
      );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const records = snapshot.decisions.map(
    (decision) =>
      `## ${decision.key} (revision ${decision.revision})\nSource workspace: ${decision.workspaceId}\n\n${decision.content ?? "WITHDRAWN: do not rely on earlier values."}`,
  );
  await replace(
    join(directory, "SHARED_DECISIONS.md"),
    `# Shared decisions\n\nSnapshot revision: ${snapshot.revision}\n\n${records.join("\n\n")}\n`,
  );
  await clearDecisionUpdates(directory);
}
export async function collectDecisionUpdates(
  directory: string,
): Promise<DecisionUpdate[]> {
  try {
    return parseDecisionUpdates(JSON.parse(await readUpdates(directory)));
  } catch (error) {
    throw new Error(
      `Shared decisions were not published: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
export async function clearDecisionUpdates(directory: string): Promise<void> {
  await replace(join(directory, filename), "[]\n");
}
