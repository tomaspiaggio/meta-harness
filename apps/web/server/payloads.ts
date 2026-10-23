import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  decryptPayload,
  encryptPayload,
  INLINE_PAYLOAD_BYTES,
  MAX_PAYLOAD_BYTES,
  payloadHash,
} from "@harness/checkpoints/transport";
import { HarnessError } from "@harness/core";
import { grantSigningKey } from "./grants";
import { getObjects } from "./objects";
export interface PayloadGrant {
  purpose: "worker-payload";
  workerId: string;
  turnId: string;
  generation: number;
  kind: string;
  objectKey: string;
  hash: string;
  size: number;
  key: string;
  expiresAt: number;
}
const signature = (payload: string) =>
  createHmac("sha256", grantSigningKey())
    .update(`payload:${payload}`)
    .digest("base64url");
function token(grant: PayloadGrant) {
  const encoded = Buffer.from(JSON.stringify(grant)).toString("base64url");
  return `${encoded}.${signature(encoded)}`;
}
export function payloadGrant(value: string, workerId: string): PayloadGrant {
  const [encoded, mac, extra] = value.split(".");
  if (!encoded || !mac || extra || value.length > 2500)
    throw new HarnessError("Invalid payload grant.", 401);
  const expected = Buffer.from(signature(encoded));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new HarnessError("Invalid payload grant.", 401);
  let grant: PayloadGrant;
  try {
    grant = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new HarnessError("Invalid payload grant.", 401);
  }
  if (
    grant.purpose !== "worker-payload" ||
    grant.workerId !== workerId ||
    grant.expiresAt <= Date.now() ||
    !Number.isSafeInteger(grant.size) ||
    grant.size < 28 ||
    grant.size > MAX_PAYLOAD_BYTES ||
    !/^[a-f0-9]{64}$/.test(grant.hash) ||
    Buffer.from(grant.key ?? "", "base64url").length !== 32 ||
    !/^worker-payloads\/[a-f0-9]{64}\/[a-zA-Z0-9/-]+$/.test(grant.objectKey)
  )
    throw new HarnessError("Invalid or expired payload grant.", 401);
  return grant;
}
function metadata(
  workerId: string,
  turnId: string,
  generation: number,
  kind: string,
  hash: string,
  size: number,
  key: string,
): PayloadGrant {
  return {
    purpose: "worker-payload",
    workerId,
    turnId,
    generation,
    kind,
    hash,
    size,
    key,
    expiresAt: Date.now() + 15 * 60000,
    objectKey: `worker-payloads/${createHash("sha256").update(`${workerId}:${turnId}:${generation}`).digest("hex")}/${randomUUID()}`,
  };
}
export async function preparePayload(
  workerId: string,
  turnId: string,
  generation: number,
  body: Record<string, unknown>,
) {
  if (
    (body.kind !== "checkpoint" && body.kind !== "native-append") ||
    typeof body.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(body.hash) ||
    typeof body.size !== "number" ||
    !Number.isSafeInteger(body.size) ||
    body.size < 28 ||
    body.size > MAX_PAYLOAD_BYTES ||
    typeof body.key !== "string" ||
    Buffer.from(body.key, "base64url").length !== 32
  )
    throw new HarnessError("Invalid worker payload metadata.");
  const grant = metadata(
    workerId,
    turnId,
    generation,
    body.kind,
    body.hash,
    body.size,
    body.key,
  );
  const objects = await getObjects();
  return {
    token: token(grant),
    upload: objects.signedPut
      ? await objects.signedPut(
          grant.objectKey,
          "application/octet-stream",
          grant.hash,
        )
      : {
          url: "/api/worker?action=payload",
          headers: { "Content-Type": "application/octet-stream" },
        },
  };
}
export async function readPayload(
  grant: PayloadGrant,
): Promise<Record<string, unknown>> {
  const data = await (await getObjects()).get(grant.objectKey, grant.size);
  if (data.length !== grant.size || payloadHash(data) !== grant.hash)
    throw new HarnessError("Worker payload integrity check failed.", 409);
  let result: unknown;
  try {
    result = JSON.parse(
      Buffer.from(decryptPayload(data, grant.key)).toString("utf8"),
    );
  } catch {
    throw new HarnessError("Invalid encrypted worker payload.", 409);
  }
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new HarnessError("Expected a worker payload object.");
  return result as Record<string, unknown>;
}
export async function workerReply(
  workerId: string,
  turnId: string,
  generation: number,
  kind: string,
  value: unknown,
): Promise<Response> {
  const plain = Buffer.from(JSON.stringify(value));
  if (plain.length <= INLINE_PAYLOAD_BYTES) return Response.json(value);
  const encrypted = encryptPayload(plain);
  const grant = metadata(
    workerId,
    turnId,
    generation,
    kind,
    encrypted.hash,
    encrypted.size,
    encrypted.key,
  );
  const objects = await getObjects();
  await objects.put(
    grant.objectKey,
    encrypted.data,
    "application/octet-stream",
  );
  return Response.json(
    {
      payloadDownload: {
        token: token(grant),
        key: grant.key,
        hash: grant.hash,
        size: grant.size,
        turnId,
        generation,
        ...(objects.signedGet
          ? { url: await objects.signedGet(grant.objectKey) }
          : {}),
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
