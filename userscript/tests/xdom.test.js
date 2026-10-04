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
