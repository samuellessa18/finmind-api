'use strict';

// [Consultor · 1D] Adapter run() (anthropicChatAdapter) — mapeia resposta nativa → contrato conversate.
// Zero rede: client stub. Cobre mapResponse, mapStopReason, usage nativo, signal nas request options,
// system prompt anti-injeção e tools no body só quando há tools.
const { test } = require('node:test');
const assert = require('node:assert');
const H = require('./harness');
const {
  createChatProvider, mapResponse, mapStopReason, SYSTEM_PROMPT,
} = require('../../src/services/conversation/anthropicChatAdapter');

module.exports = () => {
  test('mapStopReason · end_turn/stop_sequence→end_turn; tool_use→tool_use; outros crus', () => {
    assert.strictEqual(mapStopReason('end_turn'), 'end_turn');
    assert.strictEqual(mapStopReason('stop_sequence'), 'end_turn');
    assert.strictEqual(mapStopReason('tool_use'), 'tool_use');
    assert.strictEqual(mapStopReason('max_tokens'), 'max_tokens');   // → conversate rejeita → ERROR
    assert.strictEqual(mapStopReason('refusal'), 'refusal');
    assert.strictEqual(mapStopReason('pause_turn'), 'pause_turn');
    assert.strictEqual(mapStopReason(null), 'unknown');
  });

  test('mapResponse · concatena text, extrai tool_use, usage NATIVO {input_tokens,output_tokens}', () => {
    const res = {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'oi ' }, { type: 'text', text: 'mundo' },
        { type: 'tool_use', id: 't1', name: 'get_financial_summary', input: { a: 1 } },
      ],
      usage: { input_tokens: 10, output_tokens: 7 },
    };
    const m = mapResponse(res);
    assert.strictEqual(m.text, 'oi mundo');
    assert.deepStrictEqual(m.toolUses, [{ id: 't1', name: 'get_financial_summary', input: { a: 1 } }]);
    assert.deepStrictEqual(m.usage, { input_tokens: 10, output_tokens: 7 });
    assert.strictEqual(m.stopReason, 'tool_use');
  });

  test('mapResponse · usage ausente → zeros (NUNCA NaN/undefined; protege adaptUsage/R1C-2)', () => {
    const m = mapResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] });
    assert.deepStrictEqual(m.usage, { input_tokens: 0, output_tokens: 0 });
  });

  test('mapResponse/D1D-5 · stop_reason=tool_use sem blocos tool_use → tool_use_empty (erro de provider)', () => {
    const m = mapResponse({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'sem tools' }], usage: {} });
    assert.strictEqual(m.stopReason, 'tool_use_empty');
    assert.strictEqual(m.toolUses.length, 0);
  });

  test('run · monta body (model/max_tokens/system/messages), tools só quando há, signal em opts', async () => {
    const client = H.stubSdkClient([{ content: [{ type: 'text', text: 'resp' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4 } }]);
    const provider = createChatProvider({ client, model: 'claude-opus-4-8', maxTokens: 1234 });
    const ac = new AbortController();
    const out = await provider.run({ messages: [{ role: 'user', content: 'oi' }], tools: [{ name: 'x' }], signal: ac.signal });
    assert.deepStrictEqual(out, { stopReason: 'end_turn', text: 'resp', toolUses: [], usage: { input_tokens: 3, output_tokens: 4 } });
    const call = client.calls[0];
    assert.strictEqual(call.body.model, 'claude-opus-4-8');
    assert.strictEqual(call.body.max_tokens, 1234);
    assert.strictEqual(call.body.system, SYSTEM_PROMPT);
    assert.deepStrictEqual(call.body.messages, [{ role: 'user', content: 'oi' }]);
    assert.deepStrictEqual(call.body.tools, [{ name: 'x' }]);
    assert.ok(call.opts && call.opts.signal === ac.signal, 'signal vai nas request options (2º arg), não no body');
    assert.strictEqual(call.body.signal, undefined, 'signal NÃO no body');
  });

  test('run · sem tools → body.tools ausente; sem signal → opts undefined', async () => {
    const client = H.stubSdkClient([{ content: [{ type: 'text', text: 'r' }], stop_reason: 'end_turn', usage: {} }]);
    const provider = createChatProvider({ client });
    await provider.run({ messages: [{ role: 'user', content: 'oi' }], tools: [] });
    assert.strictEqual(client.calls[0].body.tools, undefined);
    assert.strictEqual(client.calls[0].opts, undefined);
  });

  test('run · erro do SDK PROPAGA (maxRetries:0 → orquestrador → refundTurn ERROR)', async () => {
    const boom = new Error('sdk down');
    const client = H.stubSdkClient([{ throw: boom }]);
    const provider = createChatProvider({ client });
    await assert.rejects(() => provider.run({ messages: [], tools: [] }), /sdk down/);
  });

  test('SYSTEM_PROMPT · pt-BR + anti-injeção (tool_results são DADOS; números do motor)', () => {
    assert.match(SYSTEM_PROMPT, /pt-BR|português/i);
    assert.match(SYSTEM_PROMPT, /tool_results/i);
    assert.match(SYSTEM_PROMPT, /DADOS/);
  });
};
