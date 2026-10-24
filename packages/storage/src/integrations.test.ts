import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  IntegrationAdapter,
  IntegrationDefinition,
} from "@harness/core/integrations";
import {
  callIntegrationTool,
  integrationToolDescriptors,
  registerIntegrationAdapter,
} from "../../../apps/web/server/integrations";
import { HarnessStore } from "./application";

const definition: IntegrationDefinition = {
  id: "fixture",
  name: "Fixture collection",
  description: "A fixture third adapter",
  revision: "v1",
  tools: [
    {
      id: "search",
      name: "Search",
      description: "Search fixture records",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      effect: "write",
      schemaHash: "schema1",
    },
  ],
};
async function fixture(
  run: (
    store: HarnessStore,
    grant: { workerId: string; turnId: string; generation: number },
  ) => Promise<void>,
) {
  const store = new HarnessStore(":memory:");
  await store.ready;
  try {
    await store.putIntegrationDefinition(definition);
    await store.putIntegrationConnection({
      id: "account-a",
      integrationId: "fixture",
      adapter: "native",
      label: "Fixture account",
      revision: "c1",
      enabled: true,
      config: { adapterId: "fixture" },
    });
    await store.putIntegrationBinding({
      workspaceId: "tech",
      connectionId: "account-a",
      revision: "b1",
      connectionRevision: "c1",
      integrationRevision: "v1",
      toolIds: ["search"],
      enabled: true,
      constraints: {},
    });
    const worker = await store.createWorker("fixture");
    await store.reportWorker(worker.id, {
      hostname: "fixture",
      providers: ["demo"],
      labels: [],
      maxAgents: 1,
      memoryBudgetMiB: 4096,
      cpuSlots: 2,
      maxBuilds: 1,
      maxBrowsers: 1,
      availableMemoryMiB: 8192,
      reserveMemoryMiB: 1024,
      loadPerCpu: 0,
      maxLoadPerCpu: 1,
      draining: false,
    });
    await store.createTask({
      id: "fixture",
      workspaceId: "tech",
      title: "Fixture",
      objective: "Fixture",
      provider: "demo",
      profile: "standard",
      priority: 0,
    });
    for (const id of await store.pendingDispatch()) await store.enqueue(id);
    const claim = await store.claimForWorker(worker.id);
    assert.ok(claim);
    await run(store, {
      workerId: worker.id,
      turnId: claim.claim.turn.id,
      generation: claim.claim.turn.generation,
    });
  } finally {
    await store.close();
  }
}
test("shared collection ports preserve descriptions and schemas; grants fence receipts and revisions", () =>
  fixture(async (store, grant) => {
    let calls = 0;
    const adapter: IntegrationAdapter = {
      id: "fixture",
      async discover() {
        return definition;
      },
      async execute(input) {
        calls++;
        assert.equal(input.workspaceId, "tech");
        return { answer: input.arguments.query };
      },
    };
    registerIntegrationAdapter(adapter);
    const descriptors = await integrationToolDescriptors(store, "tech");
    assert.equal(descriptors.length, 1);
    assert.match(descriptors[0]!.description, /Search fixture records/);
    assert.deepEqual(await integrationToolDescriptors(store, "business"), []);
    const name = descriptors[0]!.name;
    assert.ok(name.length <= 64);
    const args = { operation_id: "logical", arguments: { query: "hello" } };
    await assert.rejects(
      callIntegrationTool(
        store,
        grant,
        "tech",
        name,
        { ...args, arguments: { query: 12 } },
        new AbortController().signal,
      ),
      /schema/,
    );
    const receipt = await callIntegrationTool(
      store,
      grant,
      "tech",
      name,
      args,
      new AbortController().signal,
    );
    assert.deepEqual(
      await callIntegrationTool(
        store,
        grant,
        "tech",
        name,
        args,
        new AbortController().signal,
      ),
      receipt,
    );
    assert.equal(calls, 1);
    await assert.rejects(
      callIntegrationTool(
        store,
        grant,
        "tech",
        name,
        { ...args, arguments: { query: "different" } },
        new AbortController().signal,
      ),
      /different arguments/,
    );
    await assert.rejects(
      store.putIntegrationConnection({
        ...(await store.listIntegrationConnections().then((c) => c[0])),
        revision: "c2",
      }),
      /conflict/,
    );
    await store.putIntegrationDefinition(
      { ...definition, revision: "v2" },
      "v1",
    );
    assert.deepEqual(await integrationToolDescriptors(store, "tech"), []);
  }));
test("physical attempt outcomes are fenced and ambiguous writes cannot repeat", () =>
  fixture(async (store, grant) => {
    registerIntegrationAdapter({
      id: "fixture",
      async discover() {
        return definition;
      },
      async execute() {
        throw new Error("secret fixture credential must not be stored");
      },
    });
    const name = (await integrationToolDescriptors(store, "tech"))[0]!.name;
    const args = { operation_id: "ambiguous", arguments: { query: "hello" } };
    await assert.rejects(
      callIntegrationTool(
        store,
        grant,
        "tech",
        name,
        args,
        new AbortController().signal,
      ),
      /unknown/,
    );
    await assert.rejects(
      callIntegrationTool(
        store,
        grant,
        "tech",
        name,
        { ...args, retry_unstarted: true },
        new AbortController().signal,
      ),
      /unknown/,
    );
    const pending = await store.unfinishedOperations(
      (await store.getTurn(grant.turnId)).sessionId,
    );
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.state, "unknown_outcome");
    assert.doesNotMatch(JSON.stringify(pending), /secret fixture/);
    assert.equal(
      await store.integrationOperationOutcome(
        pending[0]!.id,
        "stale",
        "succeeded",
        "{}",
      ),
      false,
    );
  }));
test("connection and binding revocation abort active adapter I/O", () =>
  fixture(async (store, grant) => {
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    registerIntegrationAdapter({
      id: "fixture",
      async discover() {
        return definition;
      },
      async execute({ signal }) {
        entered();
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("abort")), {
            once: true,
          }),
        );
        return null;
      },
    });
    const name = (await integrationToolDescriptors(store, "tech"))[0]!.name;
    const calling = callIntegrationTool(
      store,
      grant,
      "tech",
      name,
      { operation_id: "revoked", arguments: { query: "hello" } },
      new AbortController().signal,
    );
    await started;
    const old = (await store.listIntegrationBindings("tech"))[0]!;
    await store.putIntegrationBinding(
      { ...old, revision: "b2", enabled: false },
      "b1",
    );
    await assert.rejects(calling, /unknown/);
    assert.deepEqual(await integrationToolDescriptors(store, "tech"), []);
  }));
