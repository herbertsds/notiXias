const test = require('node:test');
const assert = require('node:assert/strict');
const Profiles = require('../src/profiles.js');
const Core = require('../src/core.js');

const idAt = (ms) => String(BigInt(ms - 1288834974657) << 22n);
const H = 3600 * 1000;
const T0 = Date.UTC(2026, 9, 6, 12, 0);

// Perfil simulado: lista do mais novo ao mais antigo, mostrada em janela (feed virtualizado).
function fakeProfile(list, { win = 6, itemPx = 100, viewport = 500, cancelAt = Infinity } = {}) {
  let scroll = 0;
  const total = () => list.length * itemPx;
  const env = {
    log: { steps: 0 },
    readItems: () => list.slice(Math.floor(scroll / itemPx), Math.floor(scroll / itemPx) + win),
    scrollToTop: () => { scroll = 0; },
    scrollBy: (px) => { scroll = Math.min(scroll + px, Math.max(0, total() - viewport)); env.log.steps++; },
    scrollHeight: () => total(),
    viewportHeight: () => viewport,
    atBottom: () => scroll + viewport >= total() - 4,
    sleep: async () => {},
    rand: (a) => a,
    isCancelled: () => env.log.steps >= cancelAt,
  };
  return env;
}
const post = (ageMs, extra = {}) => {
  const id = idAt(T0 - ageMs);
  return Object.assign({ id, author: 'fulano', reposter: null, pinned: false, key: id + '|' }, extra);
};
const OPTS = { stepDelayMs: [0, 0], settleMs: 0, pollMs: 0 };
const BOUNDARY = T0 - 3 * H;

test('perfil: inclui só posts da conta depois da fronteira e para ao achar 5 anteriores', async () => {
  const list = [
    post(1 * H),                                   // novo
    post(2 * H, { author: 'outro' }),              // post respondido (de outra conta): ignora
    post(2.5 * H),                                 // novo
    post(4 * H), post(5 * H), post(6 * H), post(7 * H), post(8 * H),   // 5 antigos
    post(9 * H), post(10 * H),
  ];
  const r = await Profiles.scan(fakeProfile(list), 'Fulano', BOUNDARY, OPTS);
  assert.equal(r.reason, 'older');
  assert.equal(r.older, 5);
  assert.deepEqual(r.items.map((i) => i.id), [list[0].id, list[2].id]);
  assert.ok(!r.items.some((i) => i.author === 'outro'));
});

test('perfil: fixado antigo e reposts não contam como antigos nem entram', async () => {
  const list = [
    post(30 * H, { pinned: true }),                // fixado no topo (velho)
    post(1 * H),
    post(40 * H, { reposter: 'fulano' }),          // repost de tweet antigo
    post(2 * H),
    post(4 * H), post(5 * H), post(6 * H), post(7 * H), post(8 * H),
  ];
  const r = await Profiles.scan(fakeProfile(list), 'fulano', BOUNDARY, OPTS);
  assert.equal(r.reason, 'older');
  assert.deepEqual(r.items.map((i) => i.id), [list[1].id, list[3].id]);
});

test('perfil: fim da página, limite de passos e cancelamento', async () => {
  const curto = [post(1 * H), post(2 * H)];
  const end = await Profiles.scan(fakeProfile(curto), 'fulano', BOUNDARY, OPTS);
  assert.equal(end.reason, 'end');
  assert.equal(end.items.length, 2);
  const vazio = await Profiles.scan(fakeProfile([]), 'fulano', BOUNDARY, OPTS);
  assert.deepEqual([vazio.reason, vazio.items.length], ['end', 0]);                // perfil vazio/privado
  const longo = Array.from({ length: 300 }, (_, i) => post((i + 1) * 60000));    // 300 posts, todos novos
  const max = await Profiles.scan(fakeProfile(longo), 'fulano', BOUNDARY, { ...OPTS, maxSteps: 10 });
  assert.equal(max.reason, 'max_steps');
  const canc = await Profiles.scan(fakeProfile(longo, { cancelAt: 3 }), 'fulano', BOUNDARY, OPTS);
  assert.equal(canc.reason, 'cancelled');
});

test('perfil: o mesmo post visto duas vezes entra uma vez só; nome com caixa diferente', async () => {
  const a = post(1 * H);
  const r = await Profiles.scan(fakeProfile([a, a, post(2 * H)], { win: 3 }), 'FULANO', BOUNDARY, OPTS);
  assert.equal(r.items.length, 2);
  assert.equal(typeof Core.snowflakeMs(a.id), 'number');
});
