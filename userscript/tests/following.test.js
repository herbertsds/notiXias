const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const Following = require('../src/following.js');
const { userCell } = require('./fixtures/builders.js');

const dom = (html, url = 'https://x.com/home') => new JSDOM(`<!doctype html><body>${html}</body>`, { url }).window.document;

test('ownHandle: lido do link do perfil na navegação', () => {
  const d = dom('<nav><a data-testid="AppTabBar_Profile_Link" href="/FORTEFORMALFeio">Perfil</a></nav>');
  assert.equal(Following.ownHandle(d), 'FORTEFORMALFeio');
  assert.equal(Following.ownHandle(dom('<nav></nav>')), null);
});

test('readCells: handle e nome de cada conta da lista (o @ nunca vira nome)', () => {
  const d = dom(userCell({ handle: 'obstatico', name: 'Cristiano Oliveira', id: '1' }) + userCell({ handle: 'sfpepior', name: 'Se Ficar Puto É Pior', id: '2' }));
  assert.deepEqual(Following.readCells(d), [
    { handle: 'obstatico', name: 'Cristiano Oliveira' },
    { handle: 'sfpepior', name: 'Se Ficar Puto É Pior' },
  ]);
});

test('buttonOf: acha o botão mesmo quando o clique cai num elemento interno', () => {
  const d = dom(userCell({ handle: 'ana', name: 'Ana', id: '55', following: false }));
  const inner = d.querySelector('button span span');
  const btn = Following.buttonOf(inner);
  assert.equal(btn.getAttribute('data-testid'), '55-follow');
  assert.equal(Following.buttonOf(d.querySelector('[data-testid="UserCell"] a')), null);
  assert.equal(Following.buttonOf(d.body), null);
});

test('infoFor: seguir/deixar de seguir dentro de uma célula de usuário', () => {
  const d = dom(userCell({ handle: 'ana', name: 'Ana Souza', id: '55', following: false }));
  const info = Following.infoFor(d.querySelector('button'), '/home');
  assert.deepEqual(info, { id: '55', kind: 'follow', handle: 'ana', name: 'Ana Souza' });
  const d2 = dom(userCell({ handle: 'beto', name: 'Beto', id: '66', following: true }));
  assert.deepEqual(Following.infoFor(d2.querySelector('button'), '/home'), { id: '66', kind: 'unfollow', handle: 'beto', name: 'Beto' });
});

test('infoFor: cartão que aparece ao passar o mouse (HoverCard)', () => {
  const d = dom('<div data-testid="HoverCard"><a href="/caio"><div dir="ltr"><span>Caio</span></div></a><button data-testid="77-follow">Seguir</button></div>');
  assert.deepEqual(Following.infoFor(d.querySelector('button'), '/home'), { id: '77', kind: 'follow', handle: 'caio', name: 'Caio' });
});

test('infoFor: cabeçalho da página de perfil usa o caminho da URL; sem pista, handle nulo', () => {
  const d = dom('<div><button data-testid="88-follow">Seguir</button></div>');
  assert.equal(Following.infoFor(d.querySelector('button'), '/dani').handle, 'dani');
  assert.equal(Following.infoFor(d.querySelector('button'), '/home').handle, null); // rota reservada
  assert.equal(Following.infoFor(d.querySelector('button'), '/dani/status/1').handle, null);
});

test('oppositeSelector: o botão que aparece quando a ação dá certo', () => {
  assert.equal(Following.oppositeSelector('55', 'follow'), '[data-testid="55-unfollow"]');
  assert.equal(Following.oppositeSelector('55', 'unfollow'), '[data-testid="55-follow"]');
});

test('o botão muda de seguir para seguindo: o seletor passa a existir (simulação do fluxo)', () => {
  const d = dom(userCell({ handle: 'ana', name: 'Ana', id: '55', following: false }));
  const info = Following.infoFor(d.querySelector('button'), '/home');
  assert.equal(d.querySelector(Following.oppositeSelector(info.id, info.kind)), null);   // ainda não seguiu
  d.querySelector('button').setAttribute('data-testid', '55-unfollow');                    // o X troca o botão
  assert.ok(d.querySelector(Following.oppositeSelector(info.id, info.kind)));
});

// ---- leitura completa com lista virtualizada ----
function fakeEnv(list, { win = 8, rowPx = 60, viewport = 480, cancelAt = Infinity, lag = 0 } = {}) {
  let scroll = 0, stale = 0, shown = 0, steps = 0;
  const total = () => list.length * rowPx;
  const env = {
    readCells: () => {
      if (stale > 0) stale--; else shown = scroll;
      const start = Math.floor(shown / rowPx);
      return list.slice(start, start + win);
    },
    scrollToTop: () => { scroll = 0; shown = 0; },
    scrollBy: (px) => { const prev = scroll; scroll = Math.min(scroll + px, Math.max(0, total() - viewport)); steps++; if (scroll !== prev) stale = lag; },
    viewportHeight: () => viewport,
    atBottom: () => scroll + viewport >= total() - 4,
    sleep: async () => {}, rand: (a) => a, onProgress: () => {},
    isCancelled: () => steps >= cancelAt,
  };
  return env;
}
const people = (n) => Array.from({ length: n }, (_, i) => ({ handle: 'user' + i, name: 'User ' + i }));
const O = { stepDelayMs: [0, 0], settleMs: 0, pollMs: 0 };

test('collect: lê a lista inteira (54 contas) e só então diz que está completa', async () => {
  const list = people(54);
  const r = await Following.collect(fakeEnv(list), O);
  assert.equal(r.complete, true);
  assert.deepEqual(r.accounts.map((a) => a.handle), list.map((a) => a.handle));
});

test('collect: lista curta cabe numa tela', async () => {
  const r = await Following.collect(fakeEnv(people(3)), O);
  assert.equal(r.complete, true);
  assert.equal(r.accounts.length, 3);
});

test('collect: lista vazia é completa e vazia', async () => {
  const r = await Following.collect(fakeEnv([]), O);
  assert.deepEqual(r, { accounts: [], complete: true, reason: 'end' });
});

test('collect: X lento para desenhar não faz perder contas', async () => {
  const list = people(40);
  const r = await Following.collect(fakeEnv(list, { lag: 2 }), { ...O, settlePolls: 4 });
  assert.equal(r.complete, true);
  assert.equal(r.accounts.length, 40);
});

test('collect: cancelar ou estourar o limite NÃO é completo (não se sobrescreve a lista com parcial)', async () => {
  const c = await Following.collect(fakeEnv(people(200), { cancelAt: 3 }), O);
  assert.deepEqual([c.complete, c.reason], [false, 'cancelled']);
  const m = await Following.collect(fakeEnv(people(500)), { ...O, maxSteps: 4 });
  assert.deepEqual([m.complete, m.reason], [false, 'max_steps']);
});

test('collect: repetidos (mesmo @, maiúsculas diferentes) não duplicam', async () => {
  const list = [{ handle: 'Ana', name: 'A' }, { handle: 'ana', name: 'A' }, { handle: 'beto', name: 'B' }];
  const r = await Following.collect(fakeEnv(list), O);
  assert.equal(r.accounts.length, 2);
});

test('collect: rolagem infinita — ao chegar no fim o X carrega mais itens depois de um tempo', async () => {
  const list = people(20);
  let waits = 0;
  const env = fakeEnv(list, { win: 8 });
  const baseSleep = env.sleep;
  env.sleep = async (ms) => {                      // depois de algumas esperas no fim, "chega" a próxima página
    await baseSleep(ms);
    if (env.atBottom() && ++waits === 3 && list.length === 20) list.push(...people(40).slice(20));
  };
  const r = await Following.collect(env, { ...O, settlePolls: 4 });
  assert.equal(r.complete, true);
  assert.equal(r.accounts.length, 40);
});
