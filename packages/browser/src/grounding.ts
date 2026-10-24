/**
 * Visual grounding, after Autonoma's quarita: a vision model returns the
 * bounding box of a UI element described in plain language, and the agent acts
 * on its center with real input events. It needs no selectors or page scripts,
 * so it also works on canvas apps and strict-CSP pages such as Google Sheets.
 *
 * Optional: set HARNESS_GROUNDING_API_KEY (OpenRouter) on the worker. The model
 * defaults to Qwen3-VL-32B; HARNESS_GROUNDING_MODEL overrides it.
 */
const PROMPT = `You are a precise GUI grounding model. The user names a single UI element visible in the screenshot.
Return that element's bounding box as JSON: { "bbox_2d": [x1, y1, x2, y2] }.
Coordinates are normalized between 0 and 1000, where x is horizontal (0 = left edge, 1000 = right edge) and y is vertical (0 = top edge, 1000 = bottom edge), relative to the image.
If the element is not visible, return { "bbox_2d": [] }.
Return only the JSON object - no prose, no code fences.`;

export class GroundingError extends Error {}

export function groundingAvailable() {
  return !!process.env.HARNESS_GROUNDING_API_KEY;
}

/** Parse a 0..1000 normalized box and return its center in viewport pixels. */
export function boxCenter(
  content: string,
  size: { width: number; height: number },
): { x: number; y: number } {
  const json = content.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  let box: unknown;
  try {
    box = (JSON.parse(json) as { bbox_2d?: unknown }).bbox_2d;
  } catch {
    throw new GroundingError("The grounding model returned no usable box.");
  }
  if (!Array.isArray(box) || box.length === 0)
    throw new GroundingError(
      "That element is not visible on the current screen. Scroll, or describe it differently.",
    );
  if (
    box.length !== 4 ||
    box.some((value) => typeof value !== "number" || value < 0 || value > 1000)
  )
    throw new GroundingError("The grounding model returned an invalid box.");
  const [x1, y1, x2, y2] = box as number[];
  return {
    x: Math.min(
      size.width - 1,
      Math.round(((x1 + x2) / 2 / 1000) * size.width),
    ),
    y: Math.min(
      size.height - 1,
      Math.round(((y1 + y2) / 2 / 1000) * size.height),
    ),
  };
}

export async function locate(
  screenshot: Buffer,
  description: string,
  size: { width: number; height: number },
): Promise<{ x: number; y: number }> {
  const key = process.env.HARNESS_GROUNDING_API_KEY;
  if (!key)
    throw new GroundingError(
      "Description targeting is not configured on this browser host. Use x/y coordinates read from the screenshot, or a ref from the snapshot action.",
    );
  const response = await fetch(
    process.env.HARNESS_GROUNDING_URL ??
      "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        model:
          process.env.HARNESS_GROUNDING_MODEL ?? "qwen/qwen3-vl-32b-instruct",
        temperature: 0,
        messages: [
          { role: "system", content: PROMPT },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${screenshot.toString("base64")}`,
                },
              },
              { type: "text", text: description.slice(0, 500) },
            ],
          },
        ],
      }),
    },
  ).catch(() => {
    throw new GroundingError("The grounding model could not be reached.");
  });
  if (!response.ok)
    throw new GroundingError(
      `The grounding model failed (${response.status}). Use x/y coordinates instead.`,
    );
  const body = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return boxCenter(body.choices?.[0]?.message?.content ?? "", size);
}
