import { createHash, randomUUID } from "node:crypto";
import { HarnessError, requiredText } from "@harness/core";
import { stableJson } from "@harness/core/idempotency";
import type {
  IntegrationAdapter,
  IntegrationConnection,
  JsonObject,
  ToolDefinition,
} from "@harness/core/integrations";
import { IntegrationNotStartedError } from "@harness/core/integrations";
import type { HarnessStore } from "@harness/storage/application";
import Ajv from "ajv";

const adapters = new Map<string, IntegrationAdapter>();
export function registerIntegrationAdapter(adapter: IntegrationAdapter) {
  adapters.set(adapter.id, adapter);
}
export function getIntegrationAdapter(
  connection: IntegrationConnection,
): IntegrationAdapter {
  const id = String(connection.config.adapterId ?? connection.adapter);
  const adapter = adapters.get(id);
  if (!adapter)
    throw new HarnessError(`Integration adapter ${id} is unavailable.`, 409);
  return adapter;
}
const nameFor = (connection: string, tool: string) =>
  `integration_${createHash("sha256")
    .update(stableJson([connection, tool]))
    .digest("hex")
    .slice(0, 48)}`;
export async function integrationTools(
  store: HarnessStore,
  workspaceId: string,
) {
  const [connections, definitions, bindings] = await Promise.all([
    store.listIntegrationConnections(),
    store.listIntegrationDefinitions(),
    store.listIntegrationBindings(workspaceId),
  ]);
  return bindings
    .flatMap((binding) => {
      const connection = connections.find((c) => c.id === binding.connectionId);
      const definition = definitions.find(
        (d) => d.id === connection?.integrationId,
      );
      if (
        !binding.enabled ||
        !connection?.enabled ||
        !definition ||
        binding.connectionRevision !== connection.revision ||
        binding.integrationRevision !== definition.revision
      )
        return [];
      return definition.tools
        .filter((t) => binding.toolIds.includes(t.id))
        .map((tool) => ({
          connection,
          definition,
          binding,
          tool,
          name: nameFor(connection.id, tool.id),
        }));
    })
    .slice(0, 100);
}
export async function integrationToolDescriptors(
  store: HarnessStore,
  workspaceId: string,
) {
  return (await integrationTools(store, workspaceId)).map(
    ({ name, connection, definition, tool }) => ({
      name,
      description: `${definition.name} / ${connection.label}: ${tool.description}${tool.effect !== "read" ? " Supply a stable operation_id for this logical action; reconcile unknown outcomes before any repeat." : ""}`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          arguments: tool.inputSchema,
          operation_id: { type: "string", maxLength: 100 },
          retry_unstarted: { type: "boolean" },
        },
        required:
          tool.effect === "read"
            ? ["arguments"]
            : ["arguments", "operation_id"],
      },
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      annotations: { readOnlyHint: tool.effect === "read" },
    }),
  );
}
function validateArguments(
  tool: ToolDefinition,
  args: unknown,
): asserts args is JsonObject {
  // No remote refs, schema fetches, defaults, coercion or metadata-based permission.
  const ajv = new Ajv({
    strict: false,
    allErrors: false,
    validateFormats: false,
    addUsedSchema: false,
  });
  let valid = false;
  try {
    valid = Boolean(ajv.compile(tool.inputSchema)(args));
  } catch {
    throw new HarnessError(
      "Unsupported accepted tool schema; rediscover and review this connection.",
      409,
    );
  }
  if (!valid)
    throw new HarnessError("Tool arguments do not match the accepted schema.");
}
export async function callIntegrationTool(
  store: HarnessStore,
  grant: { workerId: string; turnId: string; generation: number },
  workspaceId: string,
  name: string,
  args: Record<string, unknown>,
  requestSignal: AbortSignal,
) {
  const identityTurn = await store.getTurn(grant.turnId);
  if (
    (await store.getSession(identityTurn.sessionId)).workspaceId !== workspaceId
  )
    throw new HarnessError(
      "Integration workspace is outside this attempt grant.",
      403,
    );
  const entry = (await integrationTools(store, workspaceId)).find(
    (t) => t.name === name,
  );
  if (!entry)
    throw new HarnessError(
      "Integration tool is disabled or its revisions require review.",
      403,
    );
  const { connection, binding, definition, tool } = entry;
  validateArguments(tool, args.arguments);
  const operationId =
    tool.effect === "read" && args.operation_id === undefined
      ? randomUUID()
      : requiredText(args.operation_id, "operation_id", 100);
  const turn = await store.getTurn(grant.turnId);
  const id = `integration:${turn.sessionId}:${connection.id}:${operationId}`;
  const attemptToken = randomUUID();
  const details = {
    connectionId: connection.id,
    toolId: tool.id,
    attemptToken,
    execution: "pending",
    retryUnstarted: args.retry_unstarted === true,
  };
  const admission = await store.operation(
    grant.workerId,
    grant.turnId,
    grant.generation,
    id,
    {
      connectionRevision: connection.revision,
      bindingRevision: binding.revision,
      integrationRevision: definition.revision,
      schemaHash: tool.schemaHash,
      toolId: tool.id,
      arguments: args.arguments,
    },
    details,
  );
  if (admission.state !== "new") {
    if (admission.state === "succeeded")
      return JSON.parse(admission.receipt ?? "null");
    throw new HarnessError(
      `Operation ${operationId} is ${admission.state}; inspect operation_list and reconcile before retrying.`,
      409,
    );
  }
  let sent = false;
  const controller = new AbortController();
  const abort = () => controller.abort();
  requestSignal.addEventListener("abort", abort, { once: true });
  if (requestSignal.aborted) abort();
  const timeout = setTimeout(abort, 25000);
  // Revocation/stop checks are on demand only while this request is active.
  const check = async () => {
    await store.assertAssignment(
      grant.workerId,
      grant.turnId,
      grant.generation,
    );
    if ((await store.getTurn(grant.turnId)).stopRequestedAt)
      throw new HarnessError("Turn is stopping.", 409);
    const current = (await integrationTools(store, workspaceId)).find(
      (t) => t.name === name,
    );
    if (
      !current ||
      current.binding.revision !== binding.revision ||
      current.connection.revision !== connection.revision ||
      current.definition.revision !== definition.revision
    )
      throw new HarnessError("Integration access changed.", 409);
  };
  let checking = false;
  const poll = setInterval(() => {
    if (checking) return;
    checking = true;
    void check()
      .catch(abort)
      .finally(() => {
        checking = false;
      });
  }, 250);
  try {
    const adapter = getIntegrationAdapter(connection);
    await check();
    controller.signal.throwIfAborted();
    sent = true;
    const result = await adapter.execute({
      connection,
      tool,
      arguments: args.arguments,
      constraints: binding.constraints,
      workspaceId,
      signal: controller.signal,
    });
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized) > 65536)
      throw new HarnessError("Integration result exceeds 64 KiB.");
    await check();
    controller.signal.throwIfAborted();
    const receipt = JSON.stringify({
      ...details,
      execution: "completed",
      result,
    });
    await store.integrationOperationOutcome(
      id,
      attemptToken,
      "succeeded",
      receipt,
    );
    return JSON.parse(receipt);
  } catch (error) {
    if (error instanceof IntegrationNotStartedError) sent = false;
    const state = sent ? "unknown_outcome" : "failed";
    await store.integrationOperationOutcome(
      id,
      attemptToken,
      state,
      JSON.stringify({
        ...details,
        execution: sent ? "unknown" : "not_started",
      }),
      sent
        ? "External outcome is unknown. Reconcile before repeating."
        : "Rejected before adapter execution.",
    );
    throw new HarnessError(
      sent
        ? "External outcome is unknown. Inspect operation_list; reconcile before repeating this action."
        : "Integration could not start; check configuration and current permissions. The same operation_id may be explicitly retried with retry_unstarted.",
      409,
    );
  } finally {
    clearTimeout(timeout);
    clearInterval(poll);
    requestSignal.removeEventListener("abort", abort);
  }
}
