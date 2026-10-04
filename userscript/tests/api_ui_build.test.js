const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const Api = require('../src/api.js');
const Ui = require('../src/ui.js');
const { bundle } = require('../build.js');

// ---------- Api ----------
function fakeApi(responder) {
  const calls = [];
  const api = Api.create({
    getConfig: () => ({ apiBaseUrl: 'http://localhost:8010/', apiKey: 'SEGREDO' }),
    request: async (req) => {
      calls.push(req);
      return responder(req);
    },
  });
  return { api, calls };
}

test('Api: monta URL, cabeçalhos e corpo; não vaza a chave na URL', async () => {
  const { api, calls } = fakeApi(() => ({ status: 200, json: { ok: 1 } }));
  await api.queue({ after: 3, limit: 1, include_covered: undefined });
  await api.putState({ cursor_seq: 4 });
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'http://localhost:8010/api/v1/queue?after=3&limit=1');
  assert.equal(calls[0].headers.Authorization, 'Bearer SEGREDO');
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[1].method, 'PUT');
  assert.equal(calls[1].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[1].body), { cursor_seq: 4 });
  assert.ok(calls.every((c) => !c.url.includes('SEGREDO')));
});

test('Api: erros viram ApiError com status e corpo', async () => {
  const { api } = fakeApi(() => ({ status: 409, json: { detail: 'version_conflict' } }));
  await assert.rejects(api.putState({}), (e) => e instanceof Api.ApiError && e.status === 409 && e.body.detail === 'version_conflict');
  const r401 = fakeApi(() => ({ status: 401, json: { detail: 'unauthorized' } }));
  await assert.rejects(r401.api.state(), (e) => e.status === 401);
});

test('Api: rotas usadas pelo script', async () => {
  const { api, calls } = fakeApi(() => ({ status: 200, json: {} }));
  await api.anchor(10); await api.append({}); await api.views({ seqs: [1] });
  await api.cover({}); await api.uncover({}); await api.skeleton({}); await api.entry(7); await api.exportAll();
  await api.patchEntry(2, { removed: true });
  assert.deepEqual(calls.map((c) => c.method + ' ' + c.url.replace('http://localhost:8010/api/v1', '')), [
    'GET /queue/anchor?depth=10', 'POST /queue/append', 'POST /views', 'POST /entries/cover',
    'POST /entries/uncover', 'POST /health/skeleton', 'GET /entries/7', 'GET /export', 'PATCH /entries/2',
  ]);
});

// ---------- Ui ----------
function mountUi() {
  const win = new JSDOM('<!doctype html><body></body>', { url: 'https://x.com/home' }).window;
  return { ui: Ui.create(win.document), doc: win.document };
}

test('Ui: barra mostra etiquetas e posição; botões chamam os handlers', () => {
  const { ui, doc } = mountUi();
  const hits = [];
  ui.renderBar({
    badges: ['↻ repostado por @ana', '👁 já visto em 03/10/2026 às 21:14'],
    position: 4, total: 9,
    onPrev: () => hits.push('prev'), onNext: () => hits.push('next'), nextLabel: 'Próxima ▶',
    menuItems: [{ label: 'Buscar novas agora', onClick: () => hits.push('fetch') }],
  });
  const root = doc.getElementById('notixias-bar').shadowRoot;
  const text = root.textContent;
  assert.match(text, /repostado por @ana/);
  assert.match(text, /já visto em 03\/10\/2026 às 21:14/);
  assert.match(text, /4 \/ 9/);
  root.querySelector('[data-act="next"]').click();
  root.querySelector('[data-act="prev"]').click();
  assert.deepEqual(hits, ['next', 'prev']);
  root.querySelector('[data-act="menu"]').click(); // abre o menu (re-renderiza)
  const item = [...doc.getElementById('notixias-bar').shadowRoot.querySelectorAll('.menu button')].find((b) => /Buscar novas/.test(b.textContent));
  item.click();
  assert.deepEqual(hits, ['next', 'prev', 'fetch']);
});

test('Ui: botões desabilitados sem handler ou ocupado', () => {
  const { ui, doc } = mountUi();
  ui.renderBar({ badges: [], position: null, total: null, onPrev: null, onNext: () => {}, busy: true, menuItems: [] });
  const root = doc.getElementById('notixias-bar').shadowRoot;
  assert.equal(root.querySelector('[data-act="prev"]').disabled, true);
  assert.equal(root.querySelector('[data-act="next"]').disabled, true);
});

test('Ui: overlay de busca e de erro; hideOverlay remove', () => {
  const { ui, doc } = mountUi();
  let cancelled = false;
  ui.showOverlay({ title: 'Buscando novas…', detail: '12 posts lidos', buttons: [{ label: 'Cancelar', onClick: () => { cancelled = true; } }] });
  const root = doc.getElementById('notixias-overlay').shadowRoot;
  assert.match(root.textContent, /Buscando novas/);
  assert.match(root.textContent, /12 posts lidos/);
  root.querySelector('button').click();
  assert.equal(cancelled, true);
  ui.showOverlay({ title: '⚠ falhou', error: true, buttons: [] });
  assert.ok(doc.getElementById('notixias-overlay').shadowRoot.querySelector('.ov.error'));
  ui.hideOverlay();
  assert.equal(doc.getElementById('notixias-overlay').shadowRoot.querySelector('.ov'), null);
});

// ---------- Build ----------
test('o userscript gerado está atualizado com src/ (rode `npm run build`)', () => {
  const onDisk = fs.readFileSync(path.join(__dirname, '..', 'notixias.user.js'), 'utf8');
  assert.equal(onDisk, bundle());
});

test('bundle: compila, tem cabeçalho correto e nenhum segredo/armazenamento indevido', () => {
  const src = bundle();
  new vm.Script(src); // erro de sintaxe lançaria aqui
  for (const g of ['GM_xmlhttpRequest', 'GM_getValue', 'GM_setValue']) assert.match(src, new RegExp('@grant\\s+' + g));
  assert.match(src, /@match\s+https:\/\/x\.com\/\*/);
  assert.match(src, /@connect\s+localhost/);
  assert.ok(!/localStorage|sessionStorage/.test(src), 'não deve usar o armazenamento do x.com');
  assert.ok(!/apiKey:\s*['"][^'"]+['"]/.test(src), 'chave de API não pode estar escrita no código');
  assert.ok(!/Bearer\s+[A-Za-z0-9_-]{20,}/.test(src));
});

test('bundle: nenhuma ação de escrita no X (curtir/repostar/seguir/postar)', () => {
  const src = bundle();
  assert.ok(!/data-testid=["']?(like|unlike|retweet|unretweet|follow|unfollow|tweetButton)/.test(src));
});

test('bundle: só um clique programático no X, o da aba do feed', () => {
  const clicks = bundle().split('\n').filter((l) => /\.click\(\)/.test(l) && !l.trim().startsWith('//'));
  // tab.click() (xdom) e a.click() do download do arquivo exportado (main)
  assert.equal(clicks.length, 2, clicks.join('\n'));
});
