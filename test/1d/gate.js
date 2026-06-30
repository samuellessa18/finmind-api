'use strict';

// [Consultor · 1D] Gate de ativação (chatProviderConfig) + seams (chatProvider). Prova a dormência
// (D1D-10) e a fonte única (provider×executor mesmo gate). isAvailable() lê process.env.ANTHROPIC_API_KEY.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  isChatProviderEnabled, describeGate, chatModel, chatMaxTokens, parseIds, DEFAULT_MODEL, DEFAULT_MAX_TOKENS,
} = require('../../src/config/chatProviderConfig');
const { buildChatProvider, buildToolExecutor } = require('../../src/services/conversation/chatProvider');

// env base que LIGARIA o gate (exceto o que cada teste varia). userId 'u1' no canário.
function onEnv(extra = {}) {
  return { AI_CHAT_PROVIDER: 'anthropic', AI_CHAT_CANARY_USER_IDS: 'u1,u2', ...extra };
}

function withApiKey(val, fn) {
  const prev = process.env.ANTHROPIC_API_KEY;
  if (val == null) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = val;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev;
  }
}

module.exports = () => {
  test('GATE · sem AI_CHAT_PROVIDER → desabilitado (dormente)', () => {
    withApiKey('sk-test', () => {
      assert.strictEqual(isChatProviderEnabled({ AI_CHAT_CANARY_USER_IDS: 'u1' }, 'u1'), false);
    });
  });

  test('GATE · provider inválido → desabilitado', () => {
    withApiKey('sk-test', () => {
      assert.strictEqual(isChatProviderEnabled(onEnv({ AI_CHAT_PROVIDER: 'openai' }), 'u1'), false);
    });
  });

  test('GATE · sem ANTHROPIC_API_KEY → desabilitado (nenhuma chamada externa)', () => {
    withApiKey(null, () => {
      assert.strictEqual(isChatProviderEnabled(onEnv(), 'u1'), false);
    });
  });

  test('GATE/D1D-10 · canário vazio → ninguém (mesmo com tudo configurado)', () => {
    withApiKey('sk-test', () => {
      assert.strictEqual(isChatProviderEnabled(onEnv({ AI_CHAT_CANARY_USER_IDS: '' }), 'u1'), false);
      assert.strictEqual(isChatProviderEnabled(onEnv({ AI_CHAT_CANARY_USER_IDS: '   ' }), 'u1'), false);
    });
  });

  test('GATE · userId fora do canário → desabilitado', () => {
    withApiKey('sk-test', () => {
      assert.strictEqual(isChatProviderEnabled(onEnv(), 'u9'), false);
      assert.strictEqual(isChatProviderEnabled(onEnv(), null), false);
    });
  });

  test('GATE · tudo presente + userId no canário → habilitado (anthropic|claude|llm)', () => {
    withApiKey('sk-test', () => {
      assert.strictEqual(isChatProviderEnabled(onEnv({ AI_CHAT_PROVIDER: 'anthropic' }), 'u1'), true);
      assert.strictEqual(isChatProviderEnabled(onEnv({ AI_CHAT_PROVIDER: 'claude' }), 'u2'), true);
      assert.strictEqual(isChatProviderEnabled(onEnv({ AI_CHAT_PROVIDER: 'llm' }), 'u1'), true);
    });
  });

  test('GATE · parseIds: CSV com espaços/vazios', () => {
    assert.deepStrictEqual([...parseIds(' a , b ,, c ')], ['a', 'b', 'c']);
    assert.deepStrictEqual([...parseIds('')], []);
    assert.deepStrictEqual([...parseIds(null)], []);
  });

  test('KNOBS · chatModel default = claude-opus-4-8 (D1D-2); override por env', () => {
    assert.strictEqual(chatModel({}), DEFAULT_MODEL);
    assert.strictEqual(DEFAULT_MODEL, 'claude-opus-4-8');
    assert.strictEqual(chatModel({ AI_CHAT_MODEL: 'claude-sonnet-4-6' }), 'claude-sonnet-4-6');
    assert.strictEqual(chatModel({ AI_CHAT_MODEL: '   ' }), DEFAULT_MODEL);
  });

  test('KNOBS · chatMaxTokens default + validação', () => {
    assert.strictEqual(chatMaxTokens({}), DEFAULT_MAX_TOKENS);
    assert.strictEqual(chatMaxTokens({ AI_CHAT_MAX_TOKENS: '2048' }), 2048);
    assert.strictEqual(chatMaxTokens({ AI_CHAT_MAX_TOKENS: '0' }), DEFAULT_MAX_TOKENS);
    assert.strictEqual(chatMaxTokens({ AI_CHAT_MAX_TOKENS: 'x' }), DEFAULT_MAX_TOKENS);
  });

  test('DESCRIBE-GATE · descritor de boot sem segredos (flags/contagem); armed reflete o gate', () => {
    withApiKey('sk-secreta', () => {
      const g = describeGate(onEnv());
      assert.deepStrictEqual(
        { provider: g.provider, providerValid: g.providerValid, hasApiKey: g.hasApiKey, canaryCount: g.canaryCount, armed: g.armed },
        { provider: 'anthropic', providerValid: true, hasApiKey: true, canaryCount: 2, armed: true },
      );
      // não vaza a key nem os ids
      assert.ok(!Object.values(g).includes('sk-secreta'));
      assert.strictEqual(JSON.stringify(g).includes('u1'), false);
    });
    withApiKey(null, () => {
      const g = describeGate(onEnv());
      assert.strictEqual(g.hasApiKey, false);
      assert.strictEqual(g.armed, false, 'sem key → não armado');
    });
    const g2 = describeGate({});
    assert.deepStrictEqual([g2.provider, g2.providerValid, g2.armed], [null, false, false]);
  });

  // ── Seams (chatProvider.js): mesmo gate p/ provider e executor ──────────────
  test('SEAM · gate OFF → buildChatProvider e buildToolExecutor retornam null (dormente)', () => {
    const prevP = process.env.AI_CHAT_PROVIDER; delete process.env.AI_CHAT_PROVIDER;
    try {
      assert.strictEqual(buildChatProvider({ id: 'u1' }), null);
      assert.strictEqual(buildToolExecutor({ id: 'u1' }), null);
    } finally { if (prevP !== undefined) process.env.AI_CHAT_PROVIDER = prevP; }
  });

  test('SEAM · gate ON → provider tem run(); executor é função (sem I/O na construção)', () => {
    const prev = {
      p: process.env.AI_CHAT_PROVIDER, c: process.env.AI_CHAT_CANARY_USER_IDS, k: process.env.ANTHROPIC_API_KEY,
    };
    process.env.AI_CHAT_PROVIDER = 'anthropic';
    process.env.AI_CHAT_CANARY_USER_IDS = 'u1';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      const prov = buildChatProvider({ id: 'u1' });
      assert.ok(prov && typeof prov.run === 'function', 'provider construído com run()');
      const exec = buildToolExecutor({ id: 'u1' });
      assert.strictEqual(typeof exec, 'function', 'executor é função');
      // usuário fora do canário → ambos null (mesmo gate)
      assert.strictEqual(buildChatProvider({ id: 'zzz' }), null);
      assert.strictEqual(buildToolExecutor({ id: 'zzz' }), null);
    } finally {
      for (const [name, v] of [['AI_CHAT_PROVIDER', prev.p], ['AI_CHAT_CANARY_USER_IDS', prev.c], ['ANTHROPIC_API_KEY', prev.k]]) {
        if (v === undefined) delete process.env[name]; else process.env[name] = v;
      }
    }
  });
};
