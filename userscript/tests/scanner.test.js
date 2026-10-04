const test = require('node:test');
const assert = require('node:assert/strict');
const Scanner = require('../src/scanner.js');

// Feed simulado: lista do mais novo (índice 0) ao mais antigo. O "DOM" mostra uma janela
// de `win` itens a partir da posição de rolagem (feed virtualizado).
function fakeEnv(feed, { win = 5, itemPx = 100, viewport = 500, cancelAt = Infinity } = {}) {
  let scroll = 0;
  const total = () => feed.length * itemPx;
  const env = {
    log: { steps: 0 },
    readItems: () => {
      const start = Math.floor(scroll / itemPx);
      return feed.slice(start, start + win);
    },
    scrollToTop: () => { scroll = 0; },
    scrollBy: (px) => { scroll = Math.min(scroll + px, Math.max(0, total() - viewport)); env.log.steps++; },
    scrollHeight: () => total(),
    viewportHeight: () => viewport,
    atBottom: () => scroll + viewport >= total() - 4,
    sleep: async () => {},
    rand: (a) => a,
    onProgress: () => {},
    isCancelled: () => env.log.steps >= cancelAt,
  };
  return env;
}

const mk = (n, reposterFor = {}) => Array.from({ length: n }, (_, i) => {
  const id = String(1000 - i); // índice 0 = mais novo
  const reposter = reposterFor[id] || null;
  return { id, author: 'a', reposter, key: id + '|' + (reposter || '') };
});

const OPTS = { stepDelayMs: [0, 0], settleMs: 0 };

test('para ao reencontrar a âncora e devolve só o que é mais novo, do mais novo ao mais antigo', async () => {
  const feed = mk(60);
  const env = fakeEnv(feed, { win: 6 });
  const r = await Scanner.run(env, OPTS, ['970|']); // âncora = item de índice 30
  assert.equal(r.anchorFound, true);
  assert.equal(r.reason, 'anchor');
  assert.deepEqual(r.seq.map((i) => i.id), feed.slice(0, 30).map((i) => i.id));
});

test('não perde itens quando a rolagem pula (janela maior que o passo)', async () => {
  const feed = mk(40);
  const env = fakeEnv(feed, { win: 8, viewport: 600 }); // passo 420px = 4,2 itens; janela de 8
  const r = await Scanner.run(env, OPTS, ['970|']);
  assert.deepEqual(r.seq.map((i) => i.id), feed.slice(0, 30).map((i) => i.id));
});

test('âncora na primeira tela: nada novo', async () => {
  const feed = mk(20);
  const r = await Scanner.run(fakeEnv(feed), OPTS, ['1000|']);
  assert.equal(r.anchorFound, true);
  assert.equal(r.seq.length, 0);
});

test('âncora considera o reposter (mesmo post, outra aparição, não é âncora)', async () => {
  const feed = mk(20, { 990: 'ana' });
  const r = await Scanner.run(fakeEnv(feed), OPTS, ['990|']); // âncora sem reposter: não casa 990|ana
  assert.equal(r.anchorFound, false);
  const r2 = await Scanner.run(fakeEnv(feed), OPTS, ['990|ana']);
  assert.equal(r2.anchorFound, true);
  assert.deepEqual(r2.seq.map((i) => i.id), feed.slice(0, 10).map((i) => i.id));
});

test('sem âncoras (primeira carga): para em initialBackfill', async () => {
  const r = await Scanner.run(fakeEnv(mk(200)), { ...OPTS, initialBackfill: 20 }, []);
  assert.equal(r.reason, 'backfill');
  assert.ok(r.seq.length >= 20 && r.seq.length < 40);
});

test('âncora que não existe: percorre até o fim e sinaliza anchorFound=false', async () => {
  const r = await Scanner.run(fakeEnv(mk(30)), OPTS, ['1|']);
  assert.equal(r.anchorFound, false);
  assert.equal(r.reason, 'end');
  assert.equal(r.seq.length, 30);
});

test('limites maxSteps e maxCollect', async () => {
  const a = await Scanner.run(fakeEnv(mk(500)), { ...OPTS, maxSteps: 3 }, ['1|']);
  assert.equal(a.reason, 'max_steps');
  const b = await Scanner.run(fakeEnv(mk(500)), { ...OPTS, maxCollect: 15 }, ['1|']);
  assert.equal(b.reason, 'max_collect');
});

test('cancelamento interrompe a busca', async () => {
  const r = await Scanner.run(fakeEnv(mk(500), { cancelAt: 2 }), OPTS, ['1|']);
  assert.equal(r.reason, 'cancelled');
});

test('itens repetidos no DOM entre passos não duplicam', async () => {
  const feed = mk(25);
  const r = await Scanner.run(fakeEnv(feed, { win: 10 }), OPTS, ['976|']);
  const ids = r.seq.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('feed vazio termina por "end" sem travar', async () => {
  const r = await Scanner.run(fakeEnv([]), OPTS, ['1|']);
  assert.equal(r.reason, 'end');
  assert.equal(r.seq.length, 0);
});
