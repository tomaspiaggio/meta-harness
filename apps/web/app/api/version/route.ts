export const dynamic = "force-dynamic";

/** The deployed build, compared by open apps to reload after a deploy. */
export function GET() {
  return Response.json(
    { build: process.env.HARNESS_BUILD },
    { headers: { "Cache-Control": "no-store" } },
  );
}
