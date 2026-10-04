const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const Xdom = require('../src/xdom.js');
const { article, page, SECRET } = require('./fixtures/builders.js');

const dom = (html) => new JSDOM(html, { url: 'https://x.com/home' }).window.document;

test('parseArticle: post comum', () => {
  const d = dom(page(article({ id: '100', author: 'conta_a' })));
  const [it] = Xdom.readItems(d);
  assert.deepEqual(it, { id: '100', author: 'conta_a', reposter: null, key: '100|', url: 'https://x.com/conta_a/status/100' });
});

test('repost: reposter lido pelo href do perfil (os dois formatos de markup)', () => {
  const d = dom(page(
    article({ id: '1', author: 'orig', reposter: 'Ana', repostStyle: 'anchor-wraps' }),
    article({ id: '2', author: 'orig', reposter: 'beto', repostStyle: 'div-contains-anchor' }),
  ));
  const [a, b] = Xdom.readItems(d);
  assert.equal(a.reposter, 'Ana');
  assert.equal(a.key, '1|ana');
  assert.equal(b.reposter, 'beto');
});

test('contexto "Fixado" (sem link de perfil) não é repost', () => {
  const d = dom(page(article({ id: '1', author: 'a', pinned: true })));
  assert.equal(Xdom.readItems(d)[0].reposter, null);
});

test('autor repostando a si mesmo não conta como repost', () => {
  const d = dom(page(article({ id: '1', author: 'ana', reposter: 'ana' })));
  assert.equal(Xdom.readItems(d)[0].reposter, null);
});

test('anúncio (sem link de post com <time>) é ignorado', () => {
  const d = dom(page(article({ id: '1', author: 'a', ad: true }), article({ id: '2', author: 'b' })));
  assert.deepEqual(Xdom.readItems(d).map((i) => i.id), ['2']);
});

test('post com citação: vale o post externo, não o citado', () => {
  const d = dom(page(article({ id: '5', author: 'a', quoted: { id: '3', author: 'q' } })));
  const items = Xdom.readItems(d);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, '5');
});

test('link de foto (/status/ID/photo/1) não é confundido com o post', () => {
  const d = dom(page(article({ id: '7', author: 'a' })));
  assert.equal(Xdom.readItems(d)[0].id, '7');
});

test('readItems preserva a ordem de DOM; pageItems deduplica por ID', () => {
  const d = dom(page(article({ id: '3', author: 'a' }), article({ id: '2', author: 'b' }), article({ id: '3', author: 'a', reposter: 'x' })));
  assert.deepEqual(Xdom.readItems(d).map((i) => i.id), ['3', '2', '3']);
  assert.deepEqual(Xdom.pageItems(d), [{ id: '3', author: 'a' }, { id: '2', author: 'b' }]);
});

test('fallback para <article> sem data-testid', () => {
  const html = '<main><article><a href="/a/status/9"><time datetime="x">1</time></a></article></main>';
  assert.equal(Xdom.readItems(dom(html))[0].id, '9');
});

test('hasStatus / hasArticles', () => {
  const d = dom(page(article({ id: '9', author: 'a' })));
  assert.equal(Xdom.hasStatus(d, '9'), true);
  assert.equal(Xdom.hasStatus(d, '10'), false);
  assert.equal(Xdom.hasArticles(d), true);
  assert.equal(Xdom.hasArticles(dom('<main></main>')), false);
});

test('selectTab: seleciona por posição; não clica se já selecionada', () => {
  const d = dom(page());
  const second = d.querySelectorAll('[role="tab"]')[1];
  let clicked = 0;
  second.addEventListener('click', () => clicked++);
  assert.deepEqual(Xdom.selectTab(d, 1), { found: true, clicked: true });
  assert.equal(clicked, 1);
  assert.deepEqual(Xdom.selectTab(d, 0), { found: true, clicked: false });
  assert.deepEqual(Xdom.selectTab(d, 7), { found: false, clicked: false });
  assert.deepEqual(Xdom.selectTab(dom('<main></main>'), 1), { found: false, clicked: false });
});

test('skeleton: estrutura sem NENHUM texto de post e com hrefs mascarados', () => {
  const d = dom(page(article({ id: '1840000000000000009', author: 'conta_secreta', reposter: 'ana' })));
  const sk = Xdom.skeleton(Xdom.articles(d)[0]);
  assert.match(sk, /^article data-testid=tweet role=article/);
  assert.match(sk, /data-testid=socialContext/);
  assert.match(sk, /time \[datetime\]/);
  assert.match(sk, /a href~\/@u\/status\/N/);
  assert.ok(!sk.includes(SECRET), 'texto do post vazou');
  assert.ok(!sk.includes('conta_secreta'), 'handle vazou');
  assert.ok(!sk.includes('1840000000000000009'), 'ID vazou');
  assert.ok(!sk.includes('ana'), 'reposter vazou');
});

test('skeleton respeita limites de nós e profundidade', () => {
  let html = '<div id="r">';
  for (let i = 0; i < 600; i++) html += '<span></span>';
  html += '</div>';
  const d = dom(html);
  const lines = Xdom.skeleton(d.getElementById('r')).split('\n');
  assert.ok(lines.length <= 400);
  let deep = '<div id="r">' + '<div>'.repeat(30) + '</div>'.repeat(30) + '</div>';
  const maxIndent = Math.max(...Xdom.skeleton(dom(deep).getElementById('r')).split('\n').map((l) => l.search(/\S/)));
  assert.ok(maxIndent <= 28);
});

test('isLoginPath', () => {
  assert.equal(Xdom.isLoginPath('/i/flow/login'), true);
  assert.equal(Xdom.isLoginPath('/login'), true);
  assert.equal(Xdom.isLoginPath('/home'), false);
});

// jsdom não calcula layout: simulamos a posição/tamanho dos elementos.
function bottomBarDom({ position = 'fixed', top = 700, width = 400 } = {}) {
  const w = new JSDOM(
    `<body><div id="bar" style="position:${position}"><nav role="navigation" aria-label="Primary"><a href="/home">h</a></nav></div>` +
    `<div id="side" style="position:fixed"><nav role="navigation"><a href="/home">h</a></nav></div></body>`,
    { url: 'https://x.com/home' }
  ).window;
  Object.defineProperty(w, 'innerHeight', { value: 800 });
  Object.defineProperty(w, 'innerWidth', { value: 400 });
  const rect = (r) => () => Object.assign({ top: 0, left: 0, width: 0, height: 0 }, r);
  w.document.getElementById('bar').getBoundingClientRect = rect({ top, width, height: 60 });
  w.document.getElementById('side').getBoundingClientRect = rect({ top: 0, width: 80, height: 800 });
  return w;
}

test('findBottomBars: acha o nav fixo colado embaixo e ignora a barra lateral', () => {
  const w = bottomBarDom();
  const bars = Xdom.findBottomBars(w.document, w);
  assert.deepEqual(bars.map((b) => b.id), ['bar']);
});

test('findBottomBars: não é barra inferior se não for fixa, não estiver embaixo ou for estreita', () => {
  for (const o of [{ position: 'static' }, { top: 100 }, { width: 100 }]) {
    const w = bottomBarDom(o);
    assert.deepEqual(Xdom.findBottomBars(w.document, w), [], JSON.stringify(o));
  }
});

test('setBottomBarsHidden: esconde (atributo + CSS injetado) e desfaz', () => {
  const w = bottomBarDom();
  const d = w.document;
  assert.equal(Xdom.setBottomBarsHidden(d, w, true), 1);
  assert.equal(d.getElementById('bar').hasAttribute('data-nx-hidden'), true);
  assert.equal(d.getElementById('side').hasAttribute('data-nx-hidden'), false);
  assert.match(d.getElementById('nx-style').textContent, /display:none!important/);
  Xdom.setBottomBarsHidden(d, w, true); // idempotente
  assert.equal(d.querySelectorAll('#nx-style').length, 1);
  Xdom.setBottomBarsHidden(d, w, false);
  assert.equal(d.querySelectorAll('[data-nx-hidden]').length, 0);
});

test('a barra do próprio notiXias nunca é escondida', () => {
  const w = bottomBarDom();
  const host = w.document.createElement('div');
  host.id = 'notixias-bar';
  host.style.position = 'fixed';
  host.innerHTML = '<nav></nav>';
  host.getBoundingClientRect = () => ({ top: 740, width: 400, height: 60, left: 0 });
  w.document.body.append(host);
  Xdom.setBottomBarsHidden(w.document, w, true);
  assert.equal(host.hasAttribute('data-nx-hidden'), false);
});

test('findDateRow: no layout de detalhe devolve a linha inteira (data + visualizações)', () => {
  const d = dom(page(article({ id: '5', author: 'a', detail: true })));
  const row = Xdom.findDateRow(Xdom.articles(d)[0]);
  assert.equal(row.getAttribute('data-testid'), 'dateRow');
  assert.match(row.textContent, /3 de out de 2026/);
  assert.match(row.textContent, /Visualizações/);
});

test('findDateRow: layout compacto (hora relativa) ou sem contêiner de linha -> null', () => {
  const compact = '<main><article data-testid="tweet"><div><div><a href="/a/status/9"><time datetime="x">11 h</time></a></div></div></article></main>';
  assert.equal(Xdom.findDateRow(Xdom.articles(dom(compact))[0]), null);
  const d = dom(page(article({ id: '5', author: 'a' }))); // time direto no article
  assert.equal(Xdom.findDateRow(Xdom.articles(d)[0]), null);
});

// Regressão: recomendação do mesmo autor em "Descubra mais" era tratada como continuação de thread.
const convPage = (...parts) => `<!doctype html><html><body><main><div data-testid="primaryColumn"><h2 role="heading">Post</h2>${parts.join('\n')}</div><div data-testid="sidebarColumn"><h2 role="heading">O que está acontecendo</h2></div></main></body></html>`;
const SECTION = '<div><h2 role="heading" aria-level="2">Descubra mais</h2></div>';

test('pageItems: para no título de seção; recomendação do mesmo autor NÃO entra', () => {
  const d = dom(convPage(article({ id: '660', author: 'geglobo', detail: true }), '<div data-testid="composer">Poste sua resposta</div>', SECTION, article({ id: '692', author: 'geglobo' })));
  assert.deepEqual(Xdom.pageItems(d), [{ id: '660', author: 'geglobo' }]);
});

test('pageItems: respostas ANTES do título contam (thread legítima do mesmo autor)', () => {
  const d = dom(convPage(article({ id: '1', author: 'a' }), article({ id: '2', author: 'a' }), article({ id: '3', author: 'a' }), SECTION, article({ id: '9', author: 'a' })));
  assert.deepEqual(Xdom.pageItems(d).map((i) => i.id), ['1', '2', '3']);
});

test('pageItems: cadeia acima do focal vem antes e não é cortada pelo cabeçalho "Post"', () => {
  const d = dom(convPage(article({ id: '1', author: 'pai' }), article({ id: '2', author: 'a' }), SECTION, article({ id: '5', author: 'a' })));
  assert.deepEqual(Xdom.pageItems(d).map((i) => i.id), ['1', '2']);
});

test('pageItems: sem título de seção, considera todos; sem primaryColumn usa a página inteira', () => {
  assert.deepEqual(Xdom.pageItems(dom(convPage(article({ id: '1', author: 'a' }), article({ id: '2', author: 'a' })))).map((i) => i.id), ['1', '2']);
  assert.deepEqual(Xdom.pageItems(dom(page(article({ id: '1', author: 'a' }), article({ id: '2', author: 'b' })))).map((i) => i.id), ['1', '2']);
});

test('a sequência da recomendação nunca vira alvo de thread (fluxo completo)', () => {
  const Core = require('../src/core.js');
  const d = dom(convPage(article({ id: '2106660288065843460', author: 'geglobo', detail: true }), SECTION, article({ id: '2106692885886144656', author: 'geglobo' })));
  assert.equal(Core.pickThreadTarget(Xdom.pageItems(d), '2106660288065843460', 'geglobo'), null);
});
