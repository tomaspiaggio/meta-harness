import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { dataDirectory } from "./index";

export interface ObjectStore {
  delete(key: string): Promise<void>;
  put(key: string, bytes: Uint8Array, mediaType: string): Promise<void>;
  get(key: string, maxBytes: number): Promise<Uint8Array>;
  head(key: string): Promise<{ size: number; hash?: string }>;
  signedGet?(key: string): Promise<string>;
  signedPut?(
    key: string,
    mediaType: string,
    hash: string,
  ): Promise<{ url: string; headers: Record<string, string> }>;
}
export const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function validKey(key: string) {
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(key))
    throw new Error("Invalid object key.");
  return key;
}
export class LocalObjects implements ObjectStore {
  constructor(private root = join(dataDirectory(), "objects")) {}
  private async path(key: string, writing = false) {
    const path = resolve(this.root, validKey(key));
    if (writing) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const [root, parent] = await Promise.all([
      realpath(this.root),
      realpath(dirname(path)),
    ]);
    if (parent !== root && !parent.startsWith(root + sep))
      throw new Error("Object directory escaped its root.");
    return path;
  }
  async put(key: string, bytes: Uint8Array, _mediaType: string) {
    const path = await this.path(key, true);
    const temporary = `${path}.${crypto.randomUUID()}`;
    const file = await open(/* turbopackIgnore: true */ temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  async get(key: string, maxBytes: number) {
    const file = await open(
      await this.path(key),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes)
        throw new Error("Object exceeds the read limit.");
      return new Uint8Array(await file.readFile());
    } finally {
      await file.close();
    }
  }
  async delete(key: string) {
    try {
      await unlink(await this.path(key));
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
  }
  async head(key: string) {
    const bytes = await this.get(key, 32 * 1024 * 1024);
    return { size: bytes.length, hash: sha256(bytes) };
  }
}
export async function createObjectStore(): Promise<ObjectStore> {
  const bucket = process.env.HARNESS_S3_BUCKET;
  if (!bucket) {
    if (process.env.VERCEL)
      throw new Error(
        "Configure private object storage before hosting attachments.",
      );
    return new LocalObjects();
  }
  const {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
    HeadObjectCommand,
    DeleteObjectCommand,
  } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const client = new S3Client({
    region: process.env.HARNESS_S3_REGION ?? "us-east-1",
    endpoint: process.env.HARNESS_S3_ENDPOINT,
    forcePathStyle: process.env.HARNESS_S3_PATH_STYLE === "1",
    credentials:
      process.env.HARNESS_S3_ACCESS_KEY_ID &&
      process.env.HARNESS_S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.HARNESS_S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.HARNESS_S3_SECRET_ACCESS_KEY,
          }
        : undefined,
  });
  const key = (value: string) => `meta-harness/${validKey(value)}`;
  return {
    async delete(value) {
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key(value) }),
      );
    },
    async put(value, bytes, mediaType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key(value),
          Body: bytes,
          ContentType: mediaType,
          ChecksumSHA256: Buffer.from(sha256(bytes), "hex").toString("base64"),
        }),
      );
    },
    async get(value, maxBytes) {
      const response = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key(value) }),
      );
      if (!response.Body || (response.ContentLength ?? 0) > maxBytes)
        throw new Error("Object exceeds the read limit.");
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        length += chunk.length;
        if (length > maxBytes)
          throw new Error("Object exceeds the read limit.");
        chunks.push(chunk);
      }
      return new Uint8Array(Buffer.concat(chunks));
    },
    async head(value) {
      const response = await client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: key(value),
          ChecksumMode: "ENABLED",
        }),
      );
      return {
        size: response.ContentLength ?? 0,
        hash: response.ChecksumSHA256
          ? Buffer.from(response.ChecksumSHA256, "base64").toString("hex")
          : undefined,
      };
    },
    async signedGet(value) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key(value),
          ResponseContentDisposition: "attachment",
        }),
        { expiresIn: 60 },
      );
    },
    async signedPut(value, mediaType, hash) {
      const checksum = Buffer.from(hash, "hex").toString("base64");
      return {
        url: await getSignedUrl(
          client,
          new PutObjectCommand({
            Bucket: bucket,
            Key: key(value),
            ContentType: mediaType,
            ChecksumSHA256: checksum,
          }),
          { expiresIn: 300 },
        ),
        headers: {
          "Content-Type": mediaType,
          "x-amz-checksum-sha256": checksum,
        },
      };
    },
  };
}
