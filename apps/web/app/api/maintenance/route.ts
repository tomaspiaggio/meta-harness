import { timingSafeEqual } from "node:crypto";
import { HarnessError } from "@harness/core";
import { hosted } from "../../../server/hosted-auth";
import { failure, localRequest } from "../../../server/http";
import { maintain } from "../../../server/maintenance";
export const maxDuration = 60;
export async function GET(request: Request) {
  try {
    if (hosted()) {
      const secret = process.env.CRON_SECRET;
      const expected = Buffer.from(`Bearer ${secret ?? ""}`);
      const actual = Buffer.from(request.headers.get("authorization") ?? "");
      if (
        !secret ||
        secret.length < 32 ||
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual)
      )
        throw new HarnessError("Unauthorized maintenance request.", 401);
    } else await localRequest(request);
    await maintain();
    return Response.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
