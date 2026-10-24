import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    databasePath: string,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(
    join(tmpdir(), "integration-registry-fixture-"),
  );
  const databasePath = join(directory, "fixture.sqlite");
  const store = new HarnessStore(databasePath);
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
    await run(
      store,
      {
        workerId: worker.id,
        turnId: claim.claim.turn.id,
        generation: claim.claim.turn.generation,
      },
      databasePath,
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
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
    assert.equal(descriptors.length, 2);
    const firstDescriptor = descriptors[0];
    assert.ok(firstDescriptor);
    assert.match(firstDescriptor.description, /Search fixture records/);
    assert.deepEqual(await integrationToolDescriptors(store, "business"), []);
    const name = firstDescriptor.name;
    assert.ok(name.length <= 64);
    const catalog = await callIntegrationTool(
      store,
      grant,
      "tech",
      "integration_catalog",
      {},
      new AbortController().signal,
    );
    assert.match(JSON.stringify(catalog), /Fixture account/);
    assert.doesNotMatch(JSON.stringify(catalog), /adapterId|credentialRef/);
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
    const descriptor = (await integrationToolDescriptors(store, "tech"))[0];
    assert.ok(descriptor);
    const name = descriptor.name;
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
    const firstPending = pending[0];
    assert.ok(firstPending);
    assert.equal(firstPending.state, "unknown_outcome");
    assert.doesNotMatch(JSON.stringify(pending), /secret fixture/);
    assert.equal(
      await store.integrationOperationOutcome(
        firstPending.id,
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
    const descriptor = (await integrationToolDescriptors(store, "tech"))[0];
    assert.ok(descriptor);
    const name = descriptor.name;
    const calling = callIntegrationTool(
      store,
      grant,
      "tech",
      name,
      { operation_id: "revoked", arguments: { query: "hello" } },
      new AbortController().signal,
    );
    await started;
    const old = (await store.listIntegrationBindings("tech"))[0];
    assert.ok(old);
    await store.putIntegrationBinding(
      { ...old, revision: "b2", enabled: false },
      "b1",
    );
    await assert.rejects(calling, /unknown/);
    assert.deepEqual(await integrationToolDescriptors(store, "tech"), []);
  }));

test("proven pre-execution rejection can be explicitly retried and stale physical attempts cannot finalize a new receipt", () =>
  fixture(async (store, grant) => {
    const { IntegrationNotStartedError } = await import(
      "@harness/core/integrations"
    );
    let ready = false,
      calls = 0;
    registerIntegrationAdapter({
      id: "fixture",
      async discover() {
        return definition;
      },
      async execute() {
        if (!ready)
          throw new IntegrationNotStartedError("Missing fixture token");
        calls++;
        return { ok: true };
      },
    });
    const descriptors = await integrationToolDescriptors(store, "tech");
    const descriptor = descriptors[0];
    assert.ok(descriptor);
    const args = { operation_id: "prestart", arguments: { query: "test" } };
    await assert.rejects(
      callIntegrationTool(
        store,
        grant,
        "tech",
        descriptor.name,
        args,
        new AbortController().signal,
      ),
      /could not start/,
    );
    ready = true;
    await assert.rejects(
      callIntegrationTool(
        store,
        grant,
        "tech",
        descriptor.name,
        args,
        new AbortController().signal,
      ),
      /failed/,
    );
    await callIntegrationTool(
      store,
      grant,
      "tech",
      descriptor.name,
      { ...args, retry_unstarted: true },
      new AbortController().signal,
    );
    assert.equal(calls, 1);
    const id = "fixture-physical-fence";
    await store.operation(
      grant.workerId,
      grant.turnId,
      grant.generation,
      id,
      { a: 1 },
      { attemptToken: "old" },
    );
    assert.equal(
      await store.integrationOperationOutcome(
        id,
        "old",
        "failed",
        JSON.stringify({ attemptToken: "old", execution: "not_started" }),
      ),
      true,
    );
    const admitted = await store.operation(
      grant.workerId,
      grant.turnId,
      grant.generation,
      id,
      { a: 1 },
      { attemptToken: "new", retryUnstarted: true },
    );
    assert.equal(admitted.state, "new");
    assert.equal(
      await store.integrationOperationOutcome(id, "old", "succeeded", "{}"),
      false,
    );
    assert.equal(
      await store.integrationOperationOutcome(
        id,
        "new",
        "succeeded",
        JSON.stringify({ execution: "completed" }),
      ),
      true,
    );
  }));

test("admission survives control re-open across a lost completion and prevents duplicate external execution", () =>
  fixture(async (store, grant, databasePath) => {
    const sessionId = (await store.getTurn(grant.turnId)).sessionId;
    const id = `integration:${sessionId}:account-a:crash-window`;
    await store.operation(
      grant.workerId,
      grant.turnId,
      grant.generation,
      id,
      {
        connectionRevision: "c1",
        bindingRevision: "b1",
        integrationRevision: "v1",
        schemaHash: "schema1",
        toolId: "search",
        arguments: { query: "survived" },
      },
      { attemptToken: "lost-request", execution: "pending" },
    );
    const reopened = new HarnessStore(databasePath);
    await reopened.ready;
    try {
      let calls = 0;
      registerIntegrationAdapter({
        id: "fixture",
        async discover() {
          return definition;
        },
        async execute() {
          calls++;
          return null;
        },
      });
      const descriptor = (
        await integrationToolDescriptors(reopened, "tech")
      )[0];
      assert.ok(descriptor);
      await assert.rejects(
        callIntegrationTool(
          reopened,
          grant,
          "tech",
          descriptor.name,
          {
            operation_id: "crash-window",
            arguments: { query: "survived" },
            retry_unstarted: true,
          },
          new AbortController().signal,
        ),
        /running/,
      );
      assert.equal(calls, 0);
      assert.ok(
        (await reopened.unfinishedOperations(sessionId)).some(
          (o) => o.id === id,
        ),
      );
    } finally {
      await reopened.close();
    }
  }));
