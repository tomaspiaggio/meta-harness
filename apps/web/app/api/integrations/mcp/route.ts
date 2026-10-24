import { McpDiscoveryStore } from "@harness/storage/mcp";
import { failure, localRequest, readJson } from "../../../../server/http";
import {
  createMcpConnection,
  reviseMcpConnection,
} from "../../../../server/mcp-integrations";
import { getStore } from "../../../../server/store";
export async function POST(request: Request) {
  try {
    await localRequest(request);
    return Response.json(await createMcpConnection(await readJson(request)));
  } catch (error) {
    return failure(error);
  }
}
export async function GET(request: Request) {
  try {
    await localRequest(request);
    const store = await getStore();
    return Response.json(
      await new McpDiscoveryStore(store.databaseConnection()).list(),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request) {
  try {
    await localRequest(request);
    return Response.json(await reviseMcpConnection(await readJson(request)));
  } catch (error) {
    return failure(error);
  }
}
