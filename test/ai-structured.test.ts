import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { runStructured } from '@/modules/ai/structured.js';
import type { AiClient, ToolCallRequest, ToolCallResult, AiUsage } from '@/modules/ai/client.js';
import { AppError } from '@/lib/errors.js';

const usage = (n: number): AiUsage => ({
  inputTokens: n,
  outputTokens: n,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

/** Fake client that returns canned tool inputs in order and records the requests it received. */
class FakeAiClient implements AiClient {
  readonly calls: ToolCallRequest[] = [];
  constructor(private readonly inputs: unknown[]) {}
  async toolCall(req: ToolCallRequest): Promise<ToolCallResult> {
    this.calls.push(req);
    const input = this.inputs[this.calls.length - 1];
    return { input, usage: usage(10) };
  }
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<never> {
    throw new Error('not used');
  }
}

const Schema = z.object({ title: z.string(), priority: z.enum(['none', 'p1']) }).strict();

describe('runStructured', () => {
  it('returns the validated value on a first-try valid tool call', async () => {
    const client = new FakeAiClient([{ title: 'Buy milk', priority: 'none' }]);
    const { value, usage: u } = await runStructured(client, {
      tier: 'fast',
      system: 'sys',
      toolName: 't',
      toolDescription: 'd',
      schema: Schema,
      userContent: 'parse this',
    });
    expect(value).toEqual({ title: 'Buy milk', priority: 'none' });
    expect(client.calls).toHaveLength(1);
    expect(u.inputTokens).toBe(10);
  });

  it('re-prompts ONCE with the validation error, then succeeds', async () => {
    const client = new FakeAiClient([
      { title: 'x', priority: 'WRONG' }, // invalid enum
      { title: 'x', priority: 'p1' }, // corrected
    ]);
    const { value, usage: u } = await runStructured(client, {
      tier: 'fast',
      system: 'sys',
      toolName: 't',
      toolDescription: 'd',
      schema: Schema,
      userContent: 'parse this',
    });
    expect(value).toEqual({ title: 'x', priority: 'p1' });
    expect(client.calls).toHaveLength(2);
    // The retry carries the validation error so the model can self-correct.
    expect(client.calls[1].userContent).toContain('failed schema validation');
    // Usage is summed across both attempts.
    expect(u.inputTokens).toBe(20);
  });

  it('fails closed (ai_unavailable) after two invalid attempts', async () => {
    const client = new FakeAiClient([
      { title: 'x', priority: 'WRONG' },
      { nope: true }, // still invalid
    ]);
    await expect(
      runStructured(client, {
        tier: 'fast',
        system: 'sys',
        toolName: 't',
        toolDescription: 'd',
        schema: Schema,
        userContent: 'parse this',
      }),
    ).rejects.toMatchObject({ code: 'ai_unavailable' });
    expect(client.calls).toHaveLength(2); // never more than one retry
  });

  it('throws an AppError (not a raw error) on fail-closed', async () => {
    const client = new FakeAiClient([{ bad: 1 }, { bad: 2 }]);
    const err = await runStructured(client, {
      tier: 'fast',
      system: 'sys',
      toolName: 't',
      toolDescription: 'd',
      schema: Schema,
      userContent: 'x',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(503);
  });
});
