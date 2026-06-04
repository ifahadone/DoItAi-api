/**
 * Structured-output runner (ApiSpec §9.2). Forces a tool call, validates its `input` with the SAME Zod
 * schema that generated the tool's `input_schema`, and re-prompts ONCE with the validation error on a
 * mismatch. A second failure throws `ai_unavailable` so the route fails closed and the client falls
 * back to its on-device/manual path. AI never writes the data layer — it only returns a proposal.
 */
import type { ZodType } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { addUsage, zeroUsage, type AiClient, type AiUsage, type ModelTier } from './client.js';
import { errors } from '@/lib/errors.js';

export interface StructuredRequest<T> {
  tier: ModelTier;
  system: string;
  toolName: string;
  toolDescription: string;
  schema: ZodType<T>;
  stableContext?: string | undefined;
  userContent: string;
  maxTokens?: number | undefined;
}

export interface StructuredResult<T> {
  value: T;
  /** Token usage summed across the (≤ 2) attempts. */
  usage: AiUsage;
}

export async function runStructured<T>(
  client: AiClient,
  req: StructuredRequest<T>,
): Promise<StructuredResult<T>> {
  // `$refStrategy: 'none'` inlines defs so the schema is self-contained for the tool input_schema.
  const inputSchema = zodToJsonSchema(req.schema, {
    target: 'openApi3',
    $refStrategy: 'none',
  }) as Record<string, unknown>;

  let usage = zeroUsage();
  let lastError: string | undefined;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const userContent =
      attempt === 0
        ? req.userContent
        : `${req.userContent}\n\nYour previous tool call failed schema validation with: ${lastError}\n` +
          'Return a corrected tool call whose arguments match the schema exactly.';

    const result = await client.toolCall({
      tier: req.tier,
      system: req.system,
      toolName: req.toolName,
      toolDescription: req.toolDescription,
      inputSchema,
      stableContext: req.stableContext,
      userContent,
      maxTokens: req.maxTokens,
    });
    usage = addUsage(usage, result.usage);

    const parsed = req.schema.safeParse(result.input);
    if (parsed.success) {
      return { value: parsed.data, usage };
    }
    lastError = JSON.stringify(parsed.error.issues);
  }

  throw errors.aiUnavailable('AI output failed validation twice', { lastError });
}
