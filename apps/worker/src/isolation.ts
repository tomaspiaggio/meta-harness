import { createHash } from "node:crypto";
import { chmod, chown, lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
export function isolatedAgents(): boolean {
  if (process.env.HARNESS_ISOLATE_AGENTS !== "1") return false;
  if (process.platform !== "linux" || process.getuid?.() !== 0)
    throw new Error(
      "Separate agent identities require a root supervisor inside the dedicated Linux worker container.",
    );
  return true;
}
/** Each session gets an unprivileged UID. The daemon credential remains root-only. */
export async function prepareIdentity(directory: string, sessionId: string) {
  if (!isolatedAgents()) return undefined;
  const uid =
    100000 +
    (createHash("sha256").update(sessionId).digest().readUInt32BE(0) %
      2000000000);
  const gid = uid;
  const home = join(directory, ".harness-home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  // Parents are traversable but cannot be listed. Session directories remain 0700.
  await chmod(dirname(dirname(directory)), 0o711);
  await chmod(dirname(directory), 0o711);
  const visit = async (path: string) => {
    const stat = await lstat(path);
    if (stat.isSymbolicLink())
      throw new Error("Isolated execution cannot contain symlinks.");
    if (stat.isDirectory()) {
      await chmod(path, 0o700);
      for (const name of await readdir(path)) await visit(join(path, name));
    } else if (stat.isFile())
      await chmod(path, stat.mode & 0o100 ? 0o700 : 0o600);
    else throw new Error("Unsupported isolated execution file.");
    await chown(path, uid, gid);
  };
  await visit(directory);
  return { uid, gid, home };
}
