import { HarnessError } from "@harness/core";
import { resourcePolicy, type SecretsEngine } from "@harness/core/resources";
import type { HarnessStore } from "@harness/storage/application";
/** Initial backend uses deployment secret variables; no values enter the DB. */
export class EnvironmentSecrets implements SecretsEngine {
  async read(
    reference: string,
    _context?: { workspaceId: string; turnId: string; generation: number },
  ): Promise<string> {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(reference))
      throw new HarnessError("Invalid secret reference.");
    const bindings: unknown = JSON.parse(
      process.env.HARNESS_SECRET_BINDINGS ?? "{}",
    );
    const variable =
      bindings && typeof bindings === "object"
        ? (bindings as Record<string, unknown>)[reference]
        : undefined;
    if (
      typeof variable !== "string" ||
      !/^[A-Z][A-Z0-9_]*$/.test(variable) ||
      !variable.startsWith("JOB_SECRET_")
    )
      throw new HarnessError(
        `Secret reference ${reference} is not configured.`,
        409,
      );
    const value = process.env[variable];
    if (!value || value.length > 16384)
      throw new HarnessError(
        `Secret reference ${reference} is unavailable.`,
        409,
      );
    return value;
  }
}
export async function grantedEnvironment(
  store: HarnessStore,
  workerId: string,
  turnId: string,
  generation: number,
) {
  await store.assertAssignment(workerId, turnId, generation);
  const turn = await store.getTurn(turnId);
  const session = await store.getSession(turn.sessionId);
  const policy = resourcePolicy(
    await store.resourcePolicy(session.workspaceId),
  );
  const engine = new EnvironmentSecrets();
  const result: Record<string, string> = {};
  for (const binding of policy.secrets) {
    const id = `secret:${turnId}:${generation}:${binding.ref}:${binding.env}`;
    await store.operation(workerId, turnId, generation, id, {
      reference: binding.ref,
      environment: binding.env,
      workspaceId: session.workspaceId,
    });
    try {
      result[binding.env] = await engine.read(binding.ref, {
        workspaceId: session.workspaceId,
        turnId,
        generation,
      });
      await store.operationOutcome(
        id,
        "succeeded",
        JSON.stringify({
          backend: "environment",
          reference: binding.ref,
          issuedAt: Date.now(),
        }),
      );
    } catch (error) {
      await store.operationOutcome(
        id,
        "failed",
        null,
        "Secret backend unavailable; no value was logged.",
      );
      throw error;
    }
  }
  // Revalidate ownership and current grants after backend IO.
  await store.assertAssignment(workerId, turnId, generation);
  const latest = resourcePolicy(
    await store.resourcePolicy(session.workspaceId),
  );
  if (
    policy.secrets.some(
      (binding) =>
        !latest.secrets.some(
          (item) => item.ref === binding.ref && item.env === binding.env,
        ),
    )
  )
    throw new HarnessError(
      "Secret policy changed before delivery. Re-read the current resource policy.",
      409,
    );
  return result;
}
