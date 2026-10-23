import { POST as dispatch, PUT as upload } from "./[action]/route";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Keep frequently polled worker traffic on a static route. In Next dev, dynamic
// route matching otherwise launches static-path analysis for every poll.
const context = (request: Request) => ({
  params: Promise.resolve({
    action: new URL(request.url).searchParams.get("action") ?? "",
  }),
});
export function POST(request: Request) {
  return dispatch(request, context(request));
}
export function PUT(request: Request) {
  return upload(request, context(request));
}
