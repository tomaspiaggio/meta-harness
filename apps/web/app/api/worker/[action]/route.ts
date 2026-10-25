export const maxDuration = 60;

import { validateSnapshot } from "@harness/checkpoints";
import { MAX_PAYLOAD_BYTES, payloadHash } from "@harness/checkpoints/transport";
import { HarnessError, type RuntimeEvent, requiredText } from "@harness/core";
import { MAX_ATTACHMENT_BYTES } from "@harness/core/attachments";
import { parseDecisionUpdates } from "@harness/core/knowledge";
import type {
  NativeSessionEntry,
  NativeSessionKey,
} from "@harness/core/native-store";
import { parseWorkerReport } from "@harness/core/scheduling";
import { after } from "next/server";
import { BrowserBroker } from "../../../../server/browser";
import { delegationInstructions } from "../../../../server/delegation";
import { mintAttemptGrant } from "../../../../server/grants";
import { hosted, publicOrigin } from "../../../../server/hosted-auth";
import { failure, readJson } from "../../../../server/http";
import { maintain } from "../../../../server/maintenance";
import { getObjects } from "../../../../server/objects";
import {
  payloadGrant,
  preparePayload,
  readPayload,
  workerReply,
} from "../../../../server/payloads";
import { grantedEnvironment } from "../../../../server/secrets";
import { sameOrigin } from "../../../../server/security";
import { getStore } from "../../../../server/store";
export async function POST(
  request: Request,
  context: {
    params: Promise<{
      action: string;
    }>;
  },
) {
  try {
    sameOrigin(request);
    const workerId = request.headers.get("x-worker-id") ?? "";
    const store = await getStore();
    await store.authenticateWorker(
      workerId,
      request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
    );
    const { action } = await context.params;
    let body = await readJson(
      request,
      action === "checkpoint" || action === "browser-complete"
        ? 6 * 1024 * 1024
        : action === "native-append"
          ? 2 * 1024 * 1024
          : 64 * 1024,
    );
    if (action === "cleanup-list")
      return Response.json(await store.workerCleanup(workerId));
    if (action === "cleanup-ack") {
      await store.acknowledgeCleanup(
        workerId,
        requiredText(body.kind, "Kind", 20),
        requiredText(body.id, "ID", 100),
      );
      return Response.json({ ok: true });
    }
    if (action === "report") {
      await store.reportWorker(workerId, parseWorkerReport(body.report));
      return Response.json({ ok: true });
    }
    if (action === "claim") {
      const assignment = await store.claimForWorker(
        workerId,
        Date.now(),
        requiredText(body.requestId, "Claim request ID", 100),
      );
      if (!assignment) return Response.json(null);
      // Task, feedback and report turns carry their protocol to the agent; the
      // stored message stays what the sender wrote.
      const framing = await delegationInstructions(store, assignment.claim);
      if (framing)
        assignment.claim.turn.prompt = `${assignment.claim.turn.prompt}\n\n${framing}`;
      return workerReply(
        workerId,
        assignment.claim.turn.id,
        assignment.claim.turn.generation,
        "claim",
        assignment,
      );
    }
    if (
      typeof body.payload === "string" &&
      (action === "checkpoint" || action === "native-append")
    ) {
      const grant = payloadGrant(body.payload, workerId);
      if (grant.kind !== action)
        throw new HarnessError("Payload is for another operation.", 403);
      await store.assertAssignment(workerId, grant.turnId, grant.generation);
      body = await readPayload(grant);
      if (body.turnId !== grant.turnId || body.generation !== grant.generation)
        throw new HarnessError("Payload is outside this attempt.", 403);
    }
    if (action === "browser-release") {
      if (
        typeof body.generation !== "number" ||
        !Number.isSafeInteger(body.generation)
      )
        throw new HarnessError("Invalid browser generation.");
      await new BrowserBroker(store).release(
        workerId,
        requiredText(body.id, "Browser ID", 100),
        body.generation,
      );
      return Response.json({ ok: true });
    }
    if (action === "browser-poll")
      return Response.json(
        await new BrowserBroker(store).poll(
          workerId,
          requiredText(body.requestId, "Browser poll ID", 100),
        ),
      );
    if (action === "browser-complete") {
      if (
        typeof body.generation !== "number" ||
        !Number.isSafeInteger(body.generation)
      )
        throw new HarnessError("Invalid browser generation.");
      await new BrowserBroker(store).complete(
        workerId,
        requiredText(body.id, "Browser command ID", 100),
        body.generation,
        body.result && typeof body.result === "object"
          ? (body.result as Record<string, unknown>)
          : null,
        typeof body.stateCipher === "string" ? body.stateCipher : undefined,
        typeof body.error === "string" ? body.error : undefined,
      );
      return Response.json({ ok: true });
    }
    const turnId = requiredText(body.turnId, "Turn ID", 100);
    const generation = body.generation;
    if (
      typeof generation !== "number" ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    )
      throw new HarnessError("Invalid ownership generation.");
    if (action === "payload-prepare") {
      await store.assertAssignment(workerId, turnId, generation);
      return Response.json(
        await preparePayload(workerId, turnId, generation, body),
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (action === "payload-read") {
      const grant = payloadGrant(
        requiredText(body.payload, "Payload grant", 2500),
        workerId,
      );
      if (
        !["claim", "native-load"].includes(grant.kind) ||
        grant.turnId !== turnId ||
        grant.generation !== generation
      )
        throw new HarnessError("Payload is outside this attempt.", 403);
      await store.assertAssignment(workerId, turnId, generation);
      const data = await (await getObjects()).get(grant.objectKey, grant.size);
      if (data.length !== grant.size || payloadHash(data) !== grant.hash)
        throw new HarnessError("Payload integrity check failed.", 409);
      return new Response(Buffer.from(data), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-store",
        },
      });
    }
    if (action === "decisions")
      return Response.json(
        await store.readWorkerDecisions(workerId, turnId, generation),
      );
    if (action === "context") {
      await store.assertAssignment(workerId, turnId, generation);
      const session = await store.getSession(
        (await store.getTurn(turnId)).sessionId,
      );
      return Response.json({
        tools: {
          url: new URL(
            "/api/tools",
            hosted() ? publicOrigin() : request.url,
          ).toString(),
          token: mintAttemptGrant(workerId, turnId, generation),
        },
        policy: await store.resourcePolicy(session.workspaceId),
        unfinishedOperations: await store.unfinishedOperations(session.id),
        environment: await grantedEnvironment(
          store,
          workerId,
          turnId,
          generation,
        ),
      });
    }
    if (action === "attachments" || action === "attachment-read") {
      await store.assertAssignment(workerId, turnId, generation);
      const current = new Set(
        (await store.attachmentsForTurn(turnId)).map((item) => item.id),
      );
      const attachments = await store.attachmentsForSession(
        (await store.getTurn(turnId)).sessionId,
      );
      if (action === "attachments" && !attachments.length)
        return Response.json([]);
      const objects = await getObjects();
      if (action === "attachments")
        return Response.json(
          await Promise.all(
            attachments.map(async (attachment) => ({
              ...attachment,
              current: current.has(attachment.id),
              ...(objects.signedGet
                ? { url: await objects.signedGet(attachment.objectKey) }
                : {}),
            })),
          ),
        );
      const attachment = attachments.find((item) => item.id === body.id);
      if (!attachment)
        throw new HarnessError("Attachment is outside this turn.", 403);
      return new Response(
        Buffer.from(
          await objects.get(attachment.objectKey, MAX_ATTACHMENT_BYTES),
        ),
        {
          headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "no-store",
          },
        },
      );
    }
    if (
      action === "native-append" ||
      action === "native-load" ||
      action === "native-subkeys"
    ) {
      if (!body.key || typeof body.key !== "object" || Array.isArray(body.key))
        throw new HarnessError("Invalid native key.");
      const key = body.key as NativeSessionKey;
      if (
        typeof key.projectKey !== "string" ||
        typeof key.sessionId !== "string"
      )
        throw new HarnessError("Invalid native key.");
      if (action === "native-load")
        return workerReply(
          workerId,
          turnId,
          generation,
          "native-load",
          await store.loadNative(workerId, turnId, generation, key),
        );
      if (action === "native-subkeys")
        return Response.json(
          await store.nativeSubkeys(workerId, turnId, generation, key),
        );
      if (
        !Array.isArray(body.entries) ||
        body.entries.length > 1000 ||
        body.entries.some(
          (entry) =>
            !entry ||
            typeof entry !== "object" ||
            typeof entry.type !== "string" ||
            (entry.uuid !== undefined && typeof entry.uuid !== "string"),
        )
      )
        throw new HarnessError("Invalid native entries.");
      await store.appendNative(
        workerId,
        turnId,
        generation,
        requiredText(body.id, "Native write ID", 100),
        key,
        body.entries as NativeSessionEntry[],
      );
      return Response.json({ ok: true });
    }
    if (action === "cooldown") {
      if (
        typeof body.retryAt !== "number" ||
        !Number.isFinite(body.retryAt) ||
        body.retryAt < Date.now() ||
        body.retryAt > Date.now() + 7 * 24 * 60 * 60000
      )
        throw new HarnessError("Invalid provider reset time.");
      await store.coolDownProvider(
        workerId,
        turnId,
        generation,
        body.retryAt,
        requiredText(body.reason, "Provider reason", 1000),
      );
    } else if (action === "heartbeat")
      return Response.json({
        ok: true,
        ...(await store.heartbeatWorkerTurn(workerId, turnId, generation)),
      });
    else if (action === "event") {
      if (
        typeof body.sequence !== "number" ||
        !Number.isSafeInteger(body.sequence) ||
        body.sequence < 1
      )
        throw new HarnessError("Invalid event sequence.");
      const event = body.event as Partial<RuntimeEvent> | undefined;
      if (
        event?.type === "text" &&
        typeof event.text === "string" &&
        event.text.length <= 32768
      ) {
        await store.applyWorkerEvent(
          workerId,
          turnId,
          generation,
          body.sequence,
          {
            type: "text",
            text: event.text,
          },
        );
      } else if (
        event?.type === "native-session" &&
        typeof event.id === "string" &&
        event.id.length > 0 &&
        event.id.length < 200
      ) {
        await store.applyWorkerEvent(
          workerId,
          turnId,
          generation,
          body.sequence,
          {
            type: "native-session",
            id: event.id,
          },
        );
      } else throw new HarnessError("Invalid worker event.");
    } else if (action === "checkpoint") {
      let snapshot: ReturnType<typeof validateSnapshot>;
      try {
        snapshot = validateSnapshot(body.snapshot);
      } catch (error) {
        throw new HarnessError(
          error instanceof Error ? error.message : "Invalid checkpoint.",
        );
      }
      if (snapshot.attachments?.length) {
        const allowed = await store.attachmentsForSession(
          (await store.getTurn(turnId)).sessionId,
        );
        if (
          snapshot.attachments.some(
            (ref) =>
              !allowed.some(
                (item) => item.id === ref.id && item.hash === ref.hash,
              ),
          )
        )
          throw new HarnessError(
            "Checkpoint attachment is outside this session.",
            403,
          );
      }
      await store.saveCheckpoint(
        workerId,
        turnId,
        generation,
        requiredText(body.id, "Checkpoint ID", 100),
        snapshot,
      );
    } else if (action === "complete") {
      if (
        body.status !== "completed" &&
        body.status !== "failed" &&
        body.status !== "interrupted"
      )
        throw new HarnessError("Invalid completion status.");
      await store.completeWorkerTurn(
        workerId,
        turnId,
        generation,
        body.status,
        body.error === undefined
          ? undefined
          : requiredText(body.error, "Error", 4000),
        parseDecisionUpdates(body.decisionUpdates ?? []),
      );
    } else throw new HarnessError("Unknown worker action.", 404);
    after(() => maintain());
    return Response.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  try {
    sameOrigin(request);
    if ((await context.params).action !== "payload")
      throw new HarnessError("Not found.", 404);
    const workerId = request.headers.get("x-worker-id") ?? "";
    const store = await getStore();
    await store.authenticateWorker(
      workerId,
      request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
    );
    const grant = payloadGrant(
      request.headers.get("x-payload-grant") ?? "",
      workerId,
    );
    if (!["checkpoint", "native-append"].includes(grant.kind))
      throw new HarnessError("Payload is read-only.", 403);
    await store.assertAssignment(workerId, grant.turnId, grant.generation);
    const objects = await getObjects();
    if (objects.signedPut)
      throw new HarnessError("Use the signed object upload URL.", 409);
    if (Number(request.headers.get("content-length") ?? 0) > grant.size)
      throw new HarnessError("Payload exceeds its size limit.", 413);
    const reader = request.body?.getReader();
    if (!reader) throw new HarnessError("Expected a payload.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > grant.size || size > MAX_PAYLOAD_BYTES) {
        await reader.cancel();
        throw new HarnessError("Payload exceeds its size limit.", 413);
      }
      chunks.push(part.value);
    }
    const bytes = Buffer.concat(chunks);
    if (size !== grant.size || payloadHash(bytes) !== grant.hash)
      throw new HarnessError("Payload integrity check failed.", 409);
    await store.assertAssignment(workerId, grant.turnId, grant.generation);
    await objects.put(grant.objectKey, bytes, "application/octet-stream");
    return Response.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
