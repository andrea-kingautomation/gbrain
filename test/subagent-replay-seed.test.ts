/**
 * Regression test: crash-replay seed reconstruction (gbrain #1764 follow-up).
 *
 * Bug: tool-result messages are never persisted to `subagent_messages` (only
 * assistant turns are; tool outcomes live in `subagent_tool_executions`). On
 * crash-replay the seed was rebuilt from `subagent_messages` alone, yielding
 * `[user, assistant(tool_use), ...]` with NO tool answers. The first `chat()`
 * call on resume was then rejected with "Tool results are missing for tool
 * calls <id>", so any transient interruption mid-subagent became a PERMANENT
 * death across all retries (observed live: ~90% of subagent jobs dead,
 * attempts_made=3, all with this exact error).
 *
 * `reconstructReplaySeed` re-interleaves a `role:'tool'` message after every
 * assistant turn that issued tool calls, rebuilt from the persisted executions,
 * so the seed is a valid provider sequence again.
 */
import { describe, it, expect } from 'bun:test';
import { reconstructReplaySeed } from '../src/core/minions/handlers/subagent.ts';

// Mirrors the real dead job 2228: user(0), assistant(1) with two tool calls,
// both executions persisted as complete -- but no tool message in the seed.
const userMsg = {
  message_idx: 0,
  role: 'user' as const,
  content_blocks: [{ type: 'text', text: 'find recent notes' }] as any,
  tokens_in: null, tokens_out: null, tokens_cache_read: null, tokens_cache_create: null, model: null,
};
const assistantToolMsg = {
  message_idx: 1,
  role: 'assistant' as const,
  content_blocks: [
    { type: 'text', text: 'searching' },
    { type: 'tool_use', id: 'toolu_A', name: 'brain_search', input: { q: 'x' } },
    { type: 'tool_use', id: 'toolu_B', name: 'brain_list_pages', input: {} },
  ] as any,
  tokens_in: 10, tokens_out: 20, tokens_cache_read: 0, tokens_cache_create: 0, model: 'm',
};

describe('reconstructReplaySeed -- crash-replay seed validity', () => {
  it('re-interleaves a role:tool message after an assistant tool-use turn', () => {
    const execs = [
      { message_idx: 1, tool_use_id: 'toolu_A', tool_name: 'brain_search', input: {}, status: 'complete' as const, output: { hits: 3 }, error: null },
      { message_idx: 1, tool_use_id: 'toolu_B', tool_name: 'brain_list_pages', input: {}, status: 'complete' as const, output: 'page list text', error: null },
    ];
    const seed = reconstructReplaySeed([userMsg, assistantToolMsg], execs);

    expect(seed.map(m => m.role)).toEqual(['user', 'assistant', 'tool']);

    const parts = seed[2].content as any[];
    expect(parts.map(p => p.toolCallId).sort()).toEqual(['toolu_A', 'toolu_B']);
    const a = parts.find(p => p.toolCallId === 'toolu_A');
    const b = parts.find(p => p.toolCallId === 'toolu_B');
    expect(a.output).toEqual({ type: 'json', value: { hits: 3 } });
    expect(b.output).toEqual({ type: 'text', value: 'page list text' });
  });

  it('answers a failed tool with error-text so the sequence stays valid', () => {
    const execs = [
      { message_idx: 1, tool_use_id: 'toolu_A', tool_name: 'brain_search', input: {}, status: 'complete' as const, output: { hits: 1 }, error: null },
      { message_idx: 1, tool_use_id: 'toolu_B', tool_name: 'brain_list_pages', input: {}, status: 'failed' as const, output: null, error: 'boom' },
    ];
    const parts = (reconstructReplaySeed([userMsg, assistantToolMsg], execs)[2].content as any[]);
    const b = parts.find(p => p.toolCallId === 'toolu_B');
    expect(b.output.type).toBe('error-text');
    expect(b.output.value).toContain('boom');
  });

  it('synthesizes an answer for a missing/pending execution (no orphan tool_use)', () => {
    const execs = [
      { message_idx: 1, tool_use_id: 'toolu_A', tool_name: 'brain_search', input: {}, status: 'complete' as const, output: { hits: 1 }, error: null },
    ];
    const parts = (reconstructReplaySeed([userMsg, assistantToolMsg], execs)[2].content as any[]);
    expect(parts.map(p => p.toolCallId).sort()).toEqual(['toolu_A', 'toolu_B']);
    expect(parts.find(p => p.toolCallId === 'toolu_B').output.type).toBe('error-text');
  });

  it('leaves a fresh run (no prior messages) untouched', () => {
    expect(reconstructReplaySeed([], [])).toEqual([]);
  });

  it('does not add a tool message after an assistant turn with no tool calls', () => {
    const finalAnswer = {
      message_idx: 3,
      role: 'assistant' as const,
      content_blocks: [{ type: 'text', text: 'done' }] as any,
      tokens_in: 1, tokens_out: 1, tokens_cache_read: 0, tokens_cache_create: 0, model: 'm',
    };
    const seed = reconstructReplaySeed([userMsg, finalAnswer], []);
    expect(seed.map(m => m.role)).toEqual(['user', 'assistant']);
  });
});
