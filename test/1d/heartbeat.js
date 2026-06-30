'use strict';

// [Consultor · 1D] startHeartbeat (D1D-7). Guard isOpen: NUNCA emite antes do stream abrir (preserva o
// contrato JSON dos outcomes não-streaming); emite quando aberto; stop() idempotente; timer unref'd.
const { test } = require('node:test');
const assert = require('node:assert');
const { startHeartbeat } = require('../../src/services/conversation/heartbeat');

function fakeSse() {
  let n = 0;
  return { get beats() { return n; }, heartbeat: () => { n += 1; } };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = () => {
  test('HB · isOpen=false → NUNCA bate (não abre stream prematuramente)', async () => {
    const sse = fakeSse();
    const hb = startHeartbeat(sse, 5, { isOpen: () => false });
    await wait(40);
    hb.stop();
    assert.strictEqual(sse.beats, 0, 'nenhum heartbeat enquanto fechado');
  });

  test('HB · isOpen=true → bate periodicamente; stop() interrompe', async () => {
    const sse = fakeSse();
    const hb = startHeartbeat(sse, 5, { isOpen: () => true });
    await wait(40);
    const after = sse.beats;
    assert.ok(after >= 2, `bateu ao menos 2x (foi ${after})`);
    hb.stop();
    await wait(30);
    assert.strictEqual(sse.beats, after, 'após stop() não bate mais');
  });

  test('HB · transição fechado→aberto: só bate depois de abrir', async () => {
    const sse = fakeSse();
    let open = false;
    const hb = startHeartbeat(sse, 5, { isOpen: () => open });
    await wait(25);
    assert.strictEqual(sse.beats, 0, 'fechado: 0 beats');
    open = true;
    await wait(30);
    hb.stop();
    assert.ok(sse.beats >= 2, 'após abrir, passou a bater');
  });

  test('HB · stop() idempotente; default isOpen=()=>true', async () => {
    const sse = fakeSse();
    const hb = startHeartbeat(sse, 5);
    await wait(20);
    hb.stop(); hb.stop(); // 2x não deve lançar
    const snap = sse.beats;
    await wait(20);
    assert.strictEqual(sse.beats, snap);
  });

  test('HB · heartbeat que lança é engolido (best-effort, não derruba o timer)', async () => {
    const sse = { heartbeat: () => { throw new Error('epipe'); } };
    const hb = startHeartbeat(sse, 5, { isOpen: () => true });
    await wait(20); // se não engolisse, o setInterval lançaria (unhandled)
    hb.stop();
    assert.ok(true);
  });
};
