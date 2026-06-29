'use strict';

// [Consultor · 1C] conversate() — tool-loop sobre um provider INJETADO (Baseline §5).
//   - maxRetries:0 → NÃO re-tenta; qualquer falha do provider PROPAGA (o orquestrador captura → ERROR).
//   - usage* POR ROUND (metadado de observabilidade; jamais decide cota — o motor decide).
//   - structured-output + tool-use coexistem; fan-in OBRIGATÓRIO (Σtool_result == Σtool_use por round).
//   - MAX_TOOL_ITERATIONS (default 8, chatConfig) corta loop infinito (D1C-1 → orquestrador refunda ERROR).
//   - números das tools vêm SEMPRE do toolExecutor (motor determinístico); o provider só NARRA.
//
// Contrato do provider injetado (stub nos testes; adapter real do Anthropic em produção):
//   provider.run({ messages, tools, signal }) => Promise<{
//     stopReason: 'end_turn' | 'tool_use' | <outro>,
//     text: string,                      // texto (delta/preview ou resposta final)
//     toolUses: Array<{id, name, input}>, // presente quando stopReason==='tool_use'
//     usage: { input_tokens, output_tokens }
//   }>
//
// Contrato do toolExecutor injetado (seam; produção lê do motor financeiro determinístico):
//   toolExecutor({id,name,input}) => Promise<content>  // content do tool_result; undefined ⇒ fan-in mismatch

const FANIN_MISMATCH = 'conversate: fan-in mismatch (Σtool_result != Σtool_use)';

async function conversate(provider, opts) {
  const {
    userMessage,
    tools = [],
    toolExecutor = null,
    maxIterations,
    sse = null,
    signal = null,
  } = opts;
  if (!provider || typeof provider.run !== 'function') throw new Error('conversate: provider.run obrigatório');
  if (!Number.isInteger(maxIterations) || maxIterations < 1) throw new Error('conversate: maxIterations inválido');

  const messages = [{ role: 'user', content: userMessage }];
  const usagePerRound = [];

  // Loop: provider é chamado EXATAMENTE até end_turn ou até maxIterations (sem off-by-one — R1C-11).
  for (let round = 0; round < maxIterations; round++) {
    const res = await provider.run({ messages, tools, signal }); // pode lançar → propaga (maxRetries:0)
    usagePerRound.push(res && res.usage ? res.usage : null);

    if (res && typeof res.text === 'string' && res.text.length > 0 && sse) {
      sse.delta(res.text, round); // delta NÃO-autoritativo (preview); write best-effort
    }

    if (res && res.stopReason === 'end_turn') {
      return { assistantContent: typeof res.text === 'string' ? res.text : '', stopReason: 'end_turn', usagePerRound, rounds: round + 1 };
    }

    if (res && res.stopReason === 'tool_use' && Array.isArray(res.toolUses) && res.toolUses.length > 0) {
      if (typeof toolExecutor !== 'function') throw new Error('conversate: toolExecutor obrigatório p/ tool_use');
      // registra o assistant(tool_use) no histórico
      messages.push({ role: 'assistant', content: res.toolUses.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input })) });
      // FAN-IN: exatamente 1 tool_result por tool_use, ANTES de avançar (R1C-9)
      const results = [];
      for (const tu of res.toolUses) {
        const content = await toolExecutor(tu); // pode lançar → propaga
        if (content === undefined) throw new Error(FANIN_MISMATCH);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content });
      }
      if (results.length !== res.toolUses.length) throw new Error(FANIN_MISMATCH);
      messages.push({ role: 'user', content: results }); // payload do round seguinte (inspecionável)
      continue;
    }

    // stopReason inesperado (nem end_turn nem tool_use válido) → erro do loop (orquestrador → ERROR)
    throw new Error('conversate: stopReason inesperado: ' + (res && res.stopReason));
  }

  // Esgotou o teto sem end_turn → política D1C-1 fica com o orquestrador (refundTurn ERROR).
  return { assistantContent: null, stopReason: 'max_iterations', usagePerRound, rounds: maxIterations };
}

module.exports = { conversate, FANIN_MISMATCH };
