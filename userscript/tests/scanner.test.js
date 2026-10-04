const test = require('node:test');
const assert = require('node:assert/strict');
const Scanner = require('../src/scanner.js');

// Feed simulado: lista do mais novo (índice 0) ao mais antigo. O "DOM" mostra uma janela
// de `win` itens a partir da posição de rolagem (feed virtualizado). `lag` = leituras "atrasadas" depois de cada
// rolagem (o X ainda não desenhou os itens novos).
function fakeEnv(feed, { win = 5, itemPx = 100, viewport = 500, cancelAt = Infinity, lag = 0 } = {}) {
  let scroll = 0;
  let stale = 0;
  let shown = 0; // posição "desenhada" (pode ficar para trás da posição real)
  const total = () => feed.length * itemPx;
  const env = {
    log: { steps: 0 },
    readItems: () => {
      if (stale > 0) stale--; else shown = scroll;
      const start = Math.floor(shown / itemPx);
      return feed.slice(start, start + win);
    },
    scrollToTop: () => { scroll = 0; shown = 0; },
    scrollBy: (px) => { const prev = scroll; scroll = Math.min(scroll + px, Math.max(0, total() - viewport)); env.log.steps++; if (scroll !== prev) stale = lag; },
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
const keys = (items) => items.map((i) => i.key);
const fresh = (r) => r.seq.filter((i) => !i.known);
const ids = (items) => items.map((i) => i.id);

const OPTS = { stepDelayMs: [0, 0], settleMs: 0, pollMs: 0 };

test('para depois de 5 itens conhecidos seguidos e devolve os novos, do mais novo ao mais antigo', async () => {
  const feed = mk(60);
  const r = await Scanner.run(fakeEnv(feed, { win: 6 }), OPTS, keys(feed.slice(30, 40))); // conhecidos: índices 30..39
  assert.equal(r.anchorFound, true);
  assert.equal(r.reason, 'anchor');
  assert.deepEqual(ids(fresh(r)), ids(feed.slice(0, 30)));
  assert.deepEqual(ids(r.seq.filter((i) => i.known)), ids(feed.slice(30, 40))); // contexto: as 10 âncoras vistas
});

test('REGRESSÃO: um item conhecido ACIMA de itens novos (conversa que subiu no feed) não encerra a busca', async () => {
  // índices 0..9 novos | 10 conhecido (o "703") | 11..15 novos (os que estavam ausentes) | 16..25 conhecidos
  const feed = mk(40);
  const known = [feed[10], ...feed.slice(16, 26)];
  const r = await Scanner.run(fakeEnv(feed, { win: 6 }), OPTS, keys(known));
  assert.equal(r.anchorFound, true);
  assert.deepEqual(ids(fresh(r)), ids([...feed.slice(0, 10), ...feed.slice(11, 16)]));
});

test('âncoras já na primeira tela: nada novo, só as conhecidas de contexto', async () => {
  const feed = mk(20);
  const r = await Scanner.run(fakeEnv(feed), OPTS, keys(feed.slice(0, 8)));
  assert.equal(r.anchorFound, true);
  assert.equal(fresh(r).length, 0);
  assert.equal(r.seq.length, 8);
});

test('com poucas âncoras (menos que o limite), basta a quantidade delas', async () => {
  const feed = mk(30);
  const r = await Scanner.run(fakeEnv(feed), OPTS, keys(feed.slice(10, 12))); // só 2 conhecidos
  assert.equal(r.anchorFound, true);
  assert.deepEqual(ids(fresh(r)), ids(feed.slice(0, 10)));
});

test('âncora considera o reposter (mesmo post, outra aparição, não é conhecida)', async () => {
  const feed = mk(30, { 990: 'ana' });
  const semRepost = await Scanner.run(fakeEnv(feed), OPTS, ['990|', '989|', '988|', '987|', '986|']);
  assert.equal(semRepost.seq.find((i) => i.id === '990').known, false);
  const comRepost = await Scanner.run(fakeEnv(feed), OPTS, ['990|ana', '989|', '988|', '987|', '986|']);
  assert.equal(comRepost.anchorFound, true);
  assert.deepEqual(ids(fresh(comRepost)), ids(feed.slice(0, 10)));
});

test('sem âncoras (primeira carga): para em initialBackfill', async () => {
  const r = await Scanner.run(fakeEnv(mk(200)), { ...OPTS, initialBackfill: 20 }, []);
  assert.equal(r.reason, 'backfill');
  assert.ok(fresh(r).length >= 20 && fresh(r).length < 40);
});

test('âncora que não existe: percorre até o fim e sinaliza anchorFound=false', async () => {
  const r = await Scanner.run(fakeEnv(mk(30)), OPTS, ['1|']);
  assert.equal(r.anchorFound, false);
  assert.equal(r.reason, 'end');
  assert.equal(fresh(r).length, 30);
});

test('não perde itens quando a rolagem pula (janela maior que o passo)', async () => {
  const feed = mk(40);
  const r = await Scanner.run(fakeEnv(feed, { win: 8, viewport: 600 }), OPTS, keys(feed.slice(30, 40)));
  assert.deepEqual(ids(fresh(r)), ids(feed.slice(0, 30)));
});

test('X lento para desenhar: espera os itens aparecerem em vez de pular', async () => {
  const feed = mk(40);
  const r = await Scanner.run(fakeEnv(feed, { win: 6, lag: 2 }), { ...OPTS, settlePolls: 4 }, keys(feed.slice(30, 40)));
  assert.deepEqual(ids(fresh(r)), ids(feed.slice(0, 30)));
  assert.equal(new Set(ids(r.seq)).size, r.seq.length);
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
  const r = await Scanner.run(fakeEnv(feed, { win: 10 }), OPTS, keys(feed.slice(20, 25)));
  const all = ids(r.seq);
  assert.equal(new Set(all).size, all.length);
});

test('feed vazio termina por "end" sem travar', async () => {
  const r = await Scanner.run(fakeEnv([]), OPTS, ['1|']);
  assert.equal(r.reason, 'end');
  assert.equal(r.seq.length, 0);
});

test('REGRESSÃO (banco real): sequência longa de conhecidos no topo e posts ausentes bem abaixo', async () => {
  // 0..1 novos | 2..17 conhecidos (16) | 18 conhecido solto | 19..24 AUSENTES | 25..30 conhecidos
  const feed = mk(40);
  const known = [...feed.slice(2, 19), ...feed.slice(25, 31)];
  const r = await Scanner.run(fakeEnv(feed, { win: 6 }), OPTS, keys(known));
  assert.equal(r.anchorFound, true);
  assert.deepEqual(ids(fresh(r)), ids([...feed.slice(0, 2), ...feed.slice(19, 25)]));
});

test('minKnown limita a profundidade: com poucas âncoras a busca termina logo', async () => {
  const feed = mk(60);
  const r = await Scanner.run(fakeEnv(feed), { ...OPTS, minKnown: 25 }, keys(feed.slice(3, 8))); // 5 âncoras
  assert.equal(r.seq.length, 8);
});

test('varredura profunda: minKnown alto continua além dos primeiros conhecidos', async () => {
  const feed = mk(60);
  const known = keys(feed.slice(0, 40));
  const r = await Scanner.run(fakeEnv(feed), { ...OPTS, minKnown: 40 }, known);
  assert.equal(r.seq.length, 40);
});

test('rolagem infinita: no fim da página o X carrega mais posts; o scanner espera em vez de encerrar', async () => {
  const feed = mk(20);
  let waits = 0;
  const env = fakeEnv(feed, { win: 6 });
  const baseSleep = env.sleep;
  env.sleep = async (ms) => {
    await baseSleep(ms);
    if (env.atBottom() && ++waits === 3 && feed.length === 20) feed.push(...mk(40).slice(20));
  };
  const r = await Scanner.run(env, { ...OPTS, settlePolls: 4 }, ['1|']);   // âncora inexistente: lê tudo
  assert.equal(fresh(r).length, 40);
  assert.equal(r.reason, 'end');
});

// ---- lacunas "Mostrar mais" no meio do feed ----
function gapEnv({ win = 6, itemPx = 100, viewport = 500 } = {}) {
  const full = mk(40);
  let opened = false, scroll = 0, clicks = 0, topClicks = 0;
  const list = () => (opened ? full : [...full.slice(0, 10), { gap: true }, ...full.slice(30)]); // 10..29 escondidos
  const windowAt = () => { const l = list(); const start = Math.floor(scroll / itemPx); return l.slice(start, start + win); };
  const env = {
    log: () => ({ clicks, topClicks, opened }),
    readItems: () => windowAt().filter((i) => !i.gap),
    scrollToTop: () => { scroll = 0; },
    scrollBy: (px) => { scroll = Math.min(scroll + px, Math.max(0, list().length * itemPx - viewport)); },
    scrollHeight: () => list().length * itemPx,
    viewportHeight: () => viewport,
    atBottom: () => scroll + viewport >= list().length * itemPx - 4,
    sleep: async () => {}, rand: (a) => a, onProgress: () => {}, isCancelled: () => false,
    expand: (click) => {
      const visible = !opened && windowAt().some((i) => i.gap);
      if (!visible) return { found: 0, clicked: false };
      if (click) { opened = true; clicks++; return { found: 1, clicked: true }; }
      return { found: 1, clicked: false };
    },
    expandTop: () => { topClicks++; return true; },
  };
  return { env, full };
}

test('lacuna "Mostrar mais" no meio: abre e captura TODOS os posts escondidos', async () => {
  const { env, full } = gapEnv();
  const r = await Scanner.run(env, OPTS, keys(full.slice(30, 40)));
  assert.equal(env.log().clicks, 1);
  assert.equal(r.expanded, 1);
  assert.equal(r.gapUnresolved, 0);
  assert.equal(r.anchorFound, true);
  assert.deepEqual(ids(fresh(r)), ids(full.slice(0, 30)));      // inclui os 10..29 que estavam escondidos
});

test('sem o gancho de expansão, os posts escondidos seriam pulados (por que o gancho existe)', async () => {
  const { env, full } = gapEnv();
  delete env.expand;
  const r = await Scanner.run(env, OPTS, keys(full.slice(30, 40)));
  assert.deepEqual(ids(fresh(r)), ids(full.slice(0, 10)));
});

test('limite de cliques: lacuna não aberta fica registrada como pendente', async () => {
  const { env, full } = gapEnv();
  const r = await Scanner.run(env, { ...OPTS, maxExpand: 0 }, keys(full.slice(30, 40)));
  assert.equal(env.log().clicks, 0);
  assert.ok(r.gapUnresolved >= 1);
});

test('"Ver novos posts" do topo é clicado antes de começar', async () => {
  const { env, full } = gapEnv();
  await Scanner.run(env, OPTS, keys(full.slice(30, 40)));
  assert.equal(env.log().topClicks, 1);
});

test('duas lacunas no feed são abertas uma a uma e nada fica de fora', async () => {
  const full = mk(80);
  const gaps = [{ at: 10, hide: 12 }, { at: 40, hide: 12 }];       // 10..21 e 40..51 escondidos
  const opened = [false, false];
  const hiddenIdx = new Set();
  const view = () => {
    const out = [];
    for (let i = 0; i < full.length; i++) {
      const g = gaps.findIndex((x) => i === x.at);
      if (g >= 0 && !opened[g]) { out.push({ gap: g }); i += gaps[g].hide - 1; continue; }
      out.push(full[i]);
    }
    return out;
  };
  let scroll = 0, clicks = 0;
  const win = 6, itemPx = 100, viewport = 500;
  const at = () => view().slice(Math.floor(scroll / itemPx), Math.floor(scroll / itemPx) + win);
  const env = {
    readItems: () => at().filter((i) => !('gap' in i)),
    scrollToTop: () => { scroll = 0; },
    scrollBy: (px) => { scroll = Math.min(scroll + px, Math.max(0, view().length * itemPx - viewport)); },
    scrollHeight: () => view().length * itemPx,
    viewportHeight: () => viewport,
    atBottom: () => scroll + viewport >= view().length * itemPx - 4,
    sleep: async () => {}, rand: (a) => a, onProgress: () => {}, isCancelled: () => false,
    expand: (click) => {
      const g = at().find((i) => 'gap' in i);
      if (!g) return { found: 0, clicked: false };
      if (click) { opened[g.gap] = true; clicks++; return { found: 1, clicked: true }; }
      return { found: 1, clicked: false };
    },
  };
  const r = await Scanner.run(env, OPTS, keys(full.slice(60, 70)));
  assert.equal(clicks, 2);
  assert.equal(r.gapUnresolved, 0);
  assert.deepEqual(ids(fresh(r)), ids(full.slice(0, 60)));
});
