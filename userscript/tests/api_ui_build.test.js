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
  await api.cover({}); await api.uncover({}); await api.settle({}); await api.skeleton({}); await api.entry(7); await api.exportAll();
  await api.patchEntry(2, { removed: true });
  await api.following(); await api.following(true); await api.putFollowing({ accounts: [] }); await api.followAdd({ handle: 'a' }); await api.followRemove({ handle: 'a' });
  assert.deepEqual(calls.map((c) => c.method + ' ' + c.url.replace('http://localhost:8010/api/v1', '')), [
    'GET /queue/anchor?depth=10', 'POST /queue/append', 'POST /views', 'POST /entries/cover',
    'POST /entries/uncover', 'POST /entries/settle', 'POST /health/skeleton', 'GET /entries/7', 'GET /export', 'PATCH /entries/2',
    'GET /accounts/following', 'GET /accounts/following?include=true', 'PUT /accounts/following', 'POST /accounts/following/add', 'POST /accounts/following/remove',
  ]);
});

// ---------- Ui ----------
function mountUi(extra) {
  const win = new JSDOM('<!doctype html><body></body>', { url: 'https://x.com/home' }).window;
  if (extra) extra(win);
  return { ui: Ui.create(win.document), doc: win.document, win };
}
const barRoot = (doc) => doc.getElementById('notixias-bar').shadowRoot;
const base = (o) => Object.assign({ mode: 'read', layout: 'full', buttons: 'both', position: 4, total: 9, notice: null,
  onPrev: () => {}, onNext: () => {}, onToggle: () => {}, navItems: [], menuItems: [], busy: false }, o);
const basis = (btn) => btn.closest('.cell').style.flexBasis;

test('Ui: leitura com os dois botões = 40% / 20% / 40%', () => {
  const { ui, doc } = mountUi();
  ui.renderBar(base());
  const r = barRoot(doc);
  assert.equal(basis(r.querySelector('[data-act="prev"]')), '40%');
  assert.equal(basis(r.querySelector('[data-act="toggle"]')), '20%');
  assert.equal(basis(r.querySelector('[data-act="next"]')), '40%');
  assert.match(r.textContent, /4 \/ 9/);
});

test('Ui: escolha de botões (só avançar / só voltar) redistribui a largura', () => {
  const { ui, doc } = mountUi();
  ui.renderBar(base({ buttons: 'next' }));
  let r = barRoot(doc);
  assert.equal(r.querySelector('[data-act="prev"]'), null);
  assert.equal(basis(r.querySelector('[data-act="next"]')), '80%');
  ui.renderBar(base({ buttons: 'prev' }));
  r = barRoot(doc);
  assert.equal(r.querySelector('[data-act="next"]'), null);
  assert.equal(basis(r.querySelector('[data-act="prev"]')), '80%');
});

test('Ui: modo uma mão aplica a classe do lado escolhido', () => {
  const { ui, doc } = mountUi();
  for (const layout of ['full', 'left', 'right']) {
    ui.renderBar(base({ layout }));
    assert.ok(barRoot(doc).querySelector('.wrap.' + layout), layout);
  }
});

test('Ui: botões chamam handlers; centro alterna o modo; desabilita sem handler/ocupado', () => {
  const { ui, doc } = mountUi();
  const hits = [];
  ui.renderBar(base({ onPrev: () => hits.push('prev'), onNext: () => hits.push('next'), onToggle: () => hits.push('toggle') }));
  const r = barRoot(doc);
  r.querySelector('[data-act="prev"]').click();
  r.querySelector('[data-act="next"]').click();
  r.querySelector('[data-act="toggle"]').click();
  assert.deepEqual(hits, ['prev', 'next', 'toggle']);
  ui.renderBar(base({ onPrev: null, busy: false }));
  assert.equal(barRoot(doc).querySelector('[data-act="prev"]').disabled, true);
  ui.renderBar(base({ busy: true }));
  assert.equal(barRoot(doc).querySelector('[data-act="next"]').disabled, true);
});

test('Ui: aviso aparece no miolo, junto da posição', () => {
  const { ui, doc } = mountUi();
  ui.renderBar(base({ notice: '12 novos · ⚠ pode haver lacuna' }));
  const center = barRoot(doc).querySelector('[data-act="toggle"]');
  assert.match(center.querySelector('.notice').textContent, /12 novos/);
  assert.match(center.querySelector('.pos').textContent, /4 \/ 9/);
});

test('Ui: modo navegação mostra ⋯, 3 atalhos e o centro; atalhos chamam handlers', () => {
  const { ui, doc } = mountUi();
  const hits = [];
  const navItems = ['Início', 'Notificações', 'Mensagens'].map((t) => ({ label: t[0], title: t, onClick: () => hits.push(t) }));
  ui.renderBar(base({ mode: 'nav', navItems }));
  const r = barRoot(doc);
  assert.equal(r.querySelector('[data-act="prev"]'), null);
  assert.equal(r.querySelector('[data-act="next"]'), null);
  for (const act of ['menu', 'nav-0', 'nav-1', 'nav-2', 'toggle']) assert.equal(basis(r.querySelector(`[data-act="${act}"]`)), '20%', act);
  r.querySelector('[data-act="nav-0"]').click();
  r.querySelector('[data-act="nav-2"]').click();
  assert.deepEqual(hits, ['Início', 'Mensagens']);
});

test('Ui: menu abre pelo ⋯ no modo navegação e executa o item', () => {
  const { ui, doc } = mountUi();
  const hits = [];
  ui.renderBar(base({ mode: 'nav', menuItems: [{ label: 'Buscar novas agora', onClick: () => hits.push('fetch') }] }));
  barRoot(doc).querySelector('[data-act="menu"]').click();
  const item = [...barRoot(doc).querySelectorAll('.menu button')].find((b) => /Buscar novas/.test(b.textContent));
  item.click();
  assert.deepEqual(hits, ['fetch']);
  assert.equal(barRoot(doc).querySelector('.menu'), null); // fechou
});

test('Ui: pressão longa no centro abre o menu e não alterna o modo', async () => {
  const { ui, doc, win } = mountUi();
  const hits = [];
  ui.renderBar(base({ onToggle: () => hits.push('toggle'), menuItems: [{ label: 'Item', onClick: () => {} }] }));
  const center = barRoot(doc).querySelector('[data-act="toggle"]');
  center.dispatchEvent(new win.Event('pointerdown'));
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(barRoot(doc).querySelector('.menu'), 'menu deveria estar aberto');
  barRoot(doc).querySelector('[data-act="toggle"]').click();
  assert.deepEqual(hits, []); // o clique que segue a pressão longa é ignorado
});

test('Ui: reserva espaço no fim da página (padding-bottom) e libera ao esconder', () => {
  let cb;
  const { ui, doc } = mountUi((win) => {
    win.ResizeObserver = class { constructor(f) { cb = f; } observe() {} disconnect() {} };
  });
  ui.renderBar(base());
  cb([{ borderBoxSize: [{ blockSize: 90.2 }], target: {} }]);
  assert.equal(doc.documentElement.style.getPropertyValue('padding-bottom'), '91px');
  assert.equal(doc.documentElement.style.getPropertyPriority('padding-bottom'), 'important');
  ui.hideBar();
  assert.equal(doc.documentElement.style.getPropertyValue('padding-bottom'), '');
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

test('Ui: lista rolável de execuções (mais recente primeiro) e estado vazio', () => {
  const { ui, doc } = mountUi();
  ui.showOverlay({ title: 'Execuções', rows: [{ main: 'A', sub: 'a', tone: 'ok' }, { main: 'B', sub: 'b', tone: 'error' }], buttons: [] });
  const root = doc.getElementById('notixias-overlay').shadowRoot;
  assert.ok(root.querySelector('.ov.list .rows'));
  assert.deepEqual([...root.querySelectorAll('.rw .m')].map((n) => n.textContent), ['A', 'B']);
  assert.ok(root.querySelector('.rw.error'));
  ui.showOverlay({ title: 'Execuções', rows: [], buttons: [] });
  assert.match(root.textContent, /Nenhuma execução registrada/);
});

test('Api: runs e runFailed', async () => {
  const { api, calls } = fakeApi(() => ({ status: 200, json: { items: [] } }));
  await api.runs(50);
  await api.runFailed({ source: 'manual', mode: 'normal', error: 'x' });
  assert.equal(calls[0].url, 'http://localhost:8010/api/v1/runs?limit=50');
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].url, 'http://localhost:8010/api/v1/runs');
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
  assert.match(src, /@connect\s+notixias\.163\.176\.176\.10\.nip\.io/);   // API de produção
  assert.ok(!/localStorage|sessionStorage/.test(src), 'não deve usar o armazenamento do x.com');
  assert.ok(!/apiKey:\s*['"][^'"]+['"]/.test(src), 'chave de API não pode estar escrita no código');
  assert.ok(!/Bearer\s+[A-Za-z0-9_-]{20,}/.test(src));
});

test('bundle: nenhuma ação de escrita no X (curtir/repostar/seguir/postar)', () => {
  const src = bundle();
  assert.ok(!/data-testid=["']?(like|unlike|retweet|unretweet|follow|unfollow|tweetButton)/.test(src));
});

test('bundle: os únicos cliques programáticos são os esperados (aba, lacuna "Mostrar mais", "Ver novos posts")', () => {
  const clicks = bundle().split('\n').filter((l) => /\.click\(\)/.test(l) && !l.trim().startsWith('//')).map((l) => l.trim());
  assert.equal(clicks.length, 3, clicks.join('\n'));
  assert.ok(clicks.some((l) => /tab\.click\(\)/.test(l)), 'aba do feed');
  assert.ok(clicks.some((l) => /btns\[0\]\.click\(\)/.test(l)), 'lacuna Mostrar mais');
  assert.ok(clicks.some((l) => /pill\.click\(\)/.test(l)), 'Ver novos posts');
});
