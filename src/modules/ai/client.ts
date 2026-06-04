/**
 * AI client — the Claude proxy surface (ApiSpec §9). The server is the ONLY place the API key lives;
 * the client's on-device path is the offline fallback. Defined as an interface so routes depend on an
 * injectable seam (tests pass a fake — no network, no key). The real impl wraps `@anthropic-ai/sdk`.
 *
 * Structured outputs use a FORCED tool call (`tool_choice: { type: 'tool', name }`) with a JSON-Schema
 * `input_schema`, validated by the same Zod schema (see `structured.ts`). Prompt caching follows
 * ApiSpec §9.4: cache breakpoints on tool definitions → system → per-user stable context; the volatile
 * request tail comes last and is never cached.
 */
import Anthropic from '@anthropic-ai/sdk';
import { env } from '@/config/env.js';
import { errors } from '@/lib/errors.js';

export type ModelTier = 'fast' | 'mid' | 'strong';

/** Tier → current Claude model (verified against the live model catalog, 2026-06). */
export const MODEL_BY_TIER: Record<ModelTier, string> = {
  fast: 'claude-haiku-4-5', // parsing, NL→filter — latency-sensitive, cheap
  mid: 'claude-sonnet-4-6', // scheduling intent, brief, routine discovery
  strong: 'claude-opus-4-8', // weekly narrative review
};

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export const zeroUsage = (): AiUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

export const addUsage = (a: AiUsage, b: AiUsage): AiUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
});

export interface ToolCallRequest {
  tier: ModelTier;
  system: string;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  /** Per-user stable context (lists, tags, working hours) — cached separately from the volatile tail. */
  stableContext?: string | undefined;
  /** Volatile request data (the NL string, today's open tasks). Never cached. */
  userContent: string;
  maxTokens?: number | undefined;
}

export interface ToolCallResult {
  input: unknown;
  usage: AiUsage;
}

export interface StreamRequest {
  tier: ModelTier;
  system: string;
  stableContext?: string | undefined;
  userContent: string;
  maxTokens?: number | undefined;
}

/** SDK 0.32 types predate prompt-caching fields; the API honors `cache_control` at runtime. */
type CachedTextBlock = Anthropic.TextBlockParam & { cache_control?: { type: 'ephemeral' } };
type CachedTool = Anthropic.Tool & { cache_control?: { type: 'ephemeral' } };
type UsageWithCache = Anthropic.Usage & {
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

export interface StreamChunk {
  /** A text delta (present on narrative chunks). */
  text?: string;
  /** Token usage — present only on the final chunk. */
  usage?: AiUsage;
}

/** The AI surface the routes depend on. Injectable so tests use a fake (no network/key). */
export interface AiClient {
  toolCall(req: ToolCallRequest): Promise<ToolCallResult>;
  stream(req: StreamRequest): AsyncIterable<StreamChunk>;
}

function usageFrom(u: Anthropic.Usage): AiUsage {
  const uc = u as UsageWithCache;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: uc.cache_read_input_tokens ?? 0,
    cacheCreationTokens: uc.cache_creation_input_tokens ?? 0,
  };
}

/** Two cache-friendly user turns: the stable (cached) context, then the volatile tail. */
function buildMessages(stableContext: string | undefined, userContent: string): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  if (stableContext) {
    const block: CachedTextBlock = {
      type: 'text',
      text: stableContext,
      cache_control: { type: 'ephemeral' },
    };
    messages.push({ role: 'user', content: [block] });
  }
  messages.push({ role: 'user', content: userContent });
  return messages;
}

/** Production client backed by the Anthropic SDK. */
export class AnthropicAiClient implements AiClient {
  private readonly sdk: Anthropic;

  constructor(apiKey: string) {
    this.sdk = new Anthropic({ apiKey });
  }

  async toolCall(req: ToolCallRequest): Promise<ToolCallResult> {
    const system: CachedTextBlock[] = [
      { type: 'text', text: req.system, cache_control: { type: 'ephemeral' } },
    ];
    const tools: CachedTool[] = [
      {
        name: req.toolName,
        description: req.toolDescription,
        input_schema: req.inputSchema as Anthropic.Tool.InputSchema,
        cache_control: { type: 'ephemeral' },
      },
    ];
    const message = await this.sdk.messages.create({
      model: MODEL_BY_TIER[req.tier],
      max_tokens: req.maxTokens ?? 1024,
      system,
      tools,
      tool_choice: { type: 'tool', name: req.toolName },
      messages: buildMessages(req.stableContext, req.userContent),
    });
    const toolUse = message.content.find((block) => block.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw errors.aiUnavailable('Model did not return the forced tool call');
    }
    return { input: toolUse.input, usage: usageFrom(message.usage) };
  }

  async *stream(req: StreamRequest): AsyncIterable<StreamChunk> {
    const system: CachedTextBlock[] = [
      { type: 'text', text: req.system, cache_control: { type: 'ephemeral' } },
    ];
    const stream = this.sdk.messages.stream({
      model: MODEL_BY_TIER[req.tier],
      max_tokens: req.maxTokens ?? 1024,
      system,
      messages: buildMessages(req.stableContext, req.userContent),
    });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { text: event.delta.text };
      }
    }
    const final = await stream.finalMessage();
    yield { usage: usageFrom(final.usage) };
  }
}

// --- Injectable singleton -----------------------------------------------------
let injected: AiClient | null | undefined;
let real: AiClient | null | undefined;

/** Test seam: override the AI client (pass a fake, or `undefined` to reset to env-derived). */
export function setAiClient(client: AiClient | null | undefined): void {
  injected = client;
}

/**
 * The active AI client, or `null` when no API key is configured (routes then fail closed with
 * `ai_unavailable`, and the client uses its on-device/rules fallback — ApiSpec §9.6).
 */
export function getAiClient(): AiClient | null {
  if (injected !== undefined) return injected;
  if (real === undefined) {
    real = env.ANTHROPIC_API_KEY ? new AnthropicAiClient(env.ANTHROPIC_API_KEY) : null;
  }
  return real;
}
