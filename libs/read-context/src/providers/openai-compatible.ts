import { ReadContextSchema, type ReadContextResult } from "../schemas.js";
import { ReadContextError } from "../errors.js";
import { z } from "zod";

const jsonTextSchema = z.string().transform((value, context) => {
  try {
    const parsed: unknown = JSON.parse(value);
    const validated = z.json().safeParse(parsed);
    if (validated.success) return validated.data;
  } catch {
    // The issue below keeps malformed provider data out of the contract.
  }
  context.addIssue({ code: "custom", message: "invalid JSON" });
  return z.NEVER;
});

export interface SummarizeRequest {
  readonly question: string;
  readonly corpus: string;
  readonly retrieval: ReadContextResult["retrieval"];
}

function setting(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function endpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, "");
  return base.endsWith("/v1")
    ? `${base}/chat/completions`
    : `${base}/v1/chat/completions`;
}

function parseJsonObject(value: string): unknown {
  const candidate = value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const parsed = jsonTextSchema.safeParse(candidate);
  if (!parsed.success)
    throw new ReadContextError("The context provider returned invalid JSON", {
      cause: parsed.error,
    });
  return parsed.data;
}

export async function summarizeWithOpenAICompatible(
  request: SummarizeRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<ReadContextResult> {
  const baseUrl = setting("READ_CONTEXT_BASE_URL");
  const apiKey = setting("READ_CONTEXT_API_KEY");
  const model = setting("READ_CONTEXT_MODEL");
  if (baseUrl === undefined || apiKey === undefined || model === undefined) {
    throw new ReadContextError(
      "read-context requires READ_CONTEXT_BASE_URL, READ_CONTEXT_API_KEY, and READ_CONTEXT_MODEL; configure an OpenAI-compatible endpoint (no primary-model fallback is used)",
    );
  }
  const timeout = Number(process.env.READ_CONTEXT_TIMEOUT_MS ?? "30000");
  const timeoutMs = Number.isInteger(timeout) && timeout > 0 ? timeout : 30_000;
  const system =
    "You are a read-only codebase analyst. Answer the exact question from supplied evidence only. Do not propose code changes, implementation plans, or architectural choices. Do not reproduce large code blocks. Cite source paths and line ranges in evidence. If evidence is incomplete, state that explicitly in uncertainties. Suggested follow-up reads must be narrow and identify why that exact range is needed. Return only JSON matching the requested schema.";
  const body = {
    model,
    temperature: 0,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: `Question: ${request.question}\n\nEvidence:\n${request.corpus}`,
      },
    ],
    response_format: { type: "json_object" },
  };
  let response: Response;
  try {
    response = await fetchImpl(endpoint(baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new ReadContextError("The context provider request failed", {
      cause,
    });
  }
  if (!response.ok) {
    throw new ReadContextError(
      `The context provider returned HTTP ${response.status}`,
    );
  }
  const payload = jsonTextSchema.safeParse(await response.text());
  if (!payload.success)
    throw new ReadContextError("The context provider returned invalid JSON", {
      cause: payload.error,
    });
  const completion = z
    .object({
      choices: z
        .array(z.object({ message: z.object({ content: z.string() }) }))
        .min(1),
    })
    .safeParse(payload.data);
  if (!completion.success)
    throw new ReadContextError(
      "The context provider response did not contain a completion",
      { cause: completion.error },
    );
  const text = completion.data.choices[0]?.message.content;
  if (text === undefined)
    throw new ReadContextError("The context provider completion had no text");
  const parsed = ReadContextSchema.safeParse(parseJsonObject(text));
  if (!parsed.success)
    throw new ReadContextError(
      "The context provider returned data that does not match ReadContextSchema",
      { cause: parsed.error },
    );
  return parsed.data;
}
