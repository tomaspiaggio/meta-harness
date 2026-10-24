import assert from "node:assert/strict";
import { test } from "node:test";
import {
  callIntegrationTool,
  integrationToolDescriptors,
  registerIntegrationAdapter,
} from "../../../apps/web/server/integrations";
import {
  createGoogleAdapter,
  googleDefinition,
} from "../../integrations/src/index";
import { HarnessStore } from "./application";
import { GoogleAuthorizationStore } from "./google";

async function fixture(
  run: (
    store: HarnessStore,
    grant: { workerId: string; turnId: string; generation: number },
  ) => Promise<void>,
) {
  const store = new HarnessStore(":memory:");
  await store.ready;
  try {
    await store.putIntegrationDefinition(googleDefinition);
    for (const id of ["fixture-work", "fixture-personal"]) {
      await store.putIntegrationConnection({
        id,
        integrationId: googleDefinition.id,
        adapter: "native",
        label: id,
        revision: "c1",
        enabled: true,
        config: { adapterId: "google" },
      });
      await store.putIntegrationBinding({
        workspaceId: "tech",
        connectionId: id,
        revision: "b1",
        connectionRevision: "c1",
        integrationRevision: googleDefinition.revision,
        toolIds: ["sheets.read_range"],
        constraints: {
          fileIds: ["sheet"],
          sheetRanges: { sheet: ["'Tab'!A1:D10"] },
        },
        enabled: true,
      });
    }
    const worker = await store.createWorker("fixture-native-google");
    await store.reportWorker(worker.id, {
      hostname: "fixture",
      providers: ["demo"],
      labels: [],
      maxAgents: 1,
      memoryBudgetMiB: 4096,
      cpuSlots: 2,
      maxBuilds: 1,
      maxBrowsers: 0,
      availableMemoryMiB: 8192,
      reserveMemoryMiB: 1024,
      loadPerCpu: 0,
      maxLoadPerCpu: 1,
      draining: false,
    });
    await store.createTask({
      id: "fixture-google",
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
test("native Google uses the same model schema/projection and fenced receipt dispatch; account/workspace grants stay distinct", () =>
  fixture(async (store, grant) => {
    const issued: string[] = [];
    registerIntegrationAdapter(
      createGoogleAdapter({
        pageKey: new Uint8Array(32).fill(7),
        access: {
          async withAccess(id, _scopes, signal, action) {
            issued.push(id);
            signal.throwIfAborted();
            return action("fixture-private-access-token");
          },
        },
        fetch: async () =>
          Response.json({
            range: "Tab!A1:B2",
            values: [["External", 42]],
            majorDimension: "ROWS",
          }),
      }),
    );
    const descriptors = (
      await integrationToolDescriptors(store, "tech")
    ).filter((tool) => tool.name !== "integration_catalog");
    assert.equal(descriptors.length, 2);
    descriptors.sort(
      (a, b) =>
        Number(b.description.includes("fixture-work")) -
        Number(a.description.includes("fixture-work")),
    );
    assert.notEqual(descriptors[0].name, descriptors[1].name);
    const definition = googleDefinition.tools.find(
      (tool) => tool.id === "sheets.read_range",
    );
    assert.ok(definition);
    const properties = descriptors[0].inputSchema.properties;
    assert.ok("arguments" in properties);
    assert.deepEqual(properties.arguments, definition.inputSchema);
    assert.ok(descriptors[0].description.includes(definition.description));
    assert.deepEqual(await integrationToolDescriptors(store, "business"), []);
    const args = {
      operation_id: "fixture-native-read",
      arguments: {
        spreadsheetId: "sheet",
        range: "Tab!A1:B2",
        representation: "raw",
      },
    };
    const result = await callIntegrationTool(
      store,
      grant,
      "tech",
      descriptors[0].name,
      args,
      new AbortController().signal,
    );
    assert.equal(result.execution, "completed");
    assert.equal(result.result.source.connectionId, "fixture-work");
    assert.equal(result.result.source.representation, "raw");
    assert.equal(issued.length, 1);
    const duplicate = await callIntegrationTool(
      store,
      grant,
      "tech",
      descriptors[0].name,
      args,
      new AbortController().signal,
    );
    assert.deepEqual(duplicate, result);
    assert.equal(issued.length, 1);
    assert.ok(!JSON.stringify(result).includes("fixture-private-access-token"));
    const stored = await store
      .databaseConnection()
      .prepare("SELECT receipt FROM operation_ledger WHERE id = ?")
      .get(
        `integration:${(await store.getTurn(grant.turnId)).sessionId}:fixture-work:fixture-native-read`,
      );
    assert.ok(stored);
    assert.ok(!JSON.stringify(stored).includes("fixture-private-access-token"));
    const binding = (await store.listIntegrationBindings("tech")).find(
      (b) => b.connectionId === "fixture-work",
    );
    assert.ok(binding);
    await store.putIntegrationBinding(
      { ...binding, revision: "b2", enabled: false },
      binding.revision,
    );
    await assert.rejects(
      callIntegrationTool(
        store,
        grant,
        "tech",
        descriptors[0].name,
        { ...args, operation_id: "after-revoke" },
        new AbortController().signal,
      ),
      /disabled/,
    );
    assert.equal((await integrationToolDescriptors(store, "tech")).length, 2);
    const account = (await store.listIntegrationConnections()).find(
      (c) => c.id === "fixture-personal",
    );
    assert.ok(account);
    await store.putIntegrationConnection(
      { ...account, revision: "c2", enabled: false },
      account.revision,
    );
    assert.deepEqual(await integrationToolDescriptors(store, "tech"), []);
  }));
test("Google-specific credential rows cascade on owner connection deletion and workspace deletion preserves accounts", () =>
  fixture(async (store) => {
    const credentials = new GoogleAuthorizationStore(
      store.databaseConnection(),
    );
    for (const connectionId of ["fixture-work", "fixture-personal"]) {
      await credentials.locked(connectionId, async () => {
        await credentials.saveCredential(
          {
            connectionId,
            subject: connectionId,
            email: `${connectionId}@example.test`,
            scopes: ["fixture-read"],
            cipher: "fixture-ciphertext",
            revision: 1,
            status: "ready",
          },
          0,
        );
      });
    }
    await store.deleteIntegrationConnection("fixture-personal", "c1");
    assert.equal(await credentials.getCredential("fixture-personal"), null);
    await store.putIntegrationBinding({
      workspaceId: "business",
      connectionId: "fixture-work",
      revision: "business-binding",
      connectionRevision: "c1",
      integrationRevision: googleDefinition.revision,
      toolIds: ["sheets.read_range"],
      constraints: {},
      enabled: true,
    });
    await store.deleteWorkspace("business");
    assert.deepEqual(await store.listIntegrationBindings("business"), []);
    const remaining = await credentials.getCredential("fixture-work");
    assert.ok(remaining);
    assert.equal(remaining.subject, "fixture-work");
  }));
