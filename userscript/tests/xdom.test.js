const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const Xdom = require('../src/xdom.js');
const { article, page, SECRET } = require('./fixtures/builders.js');

const dom = (html) => new JSDOM(html, { url: 'https://x.com/home' }).window.document;

test('parseArticle: post comum', () => {
  const d = dom(page(article({ id: '100', author: 'conta_a' })));
  const [it] = Xdom.readItems(d);
  assert.deepEqual(it, { id: '100', author: 'conta_a', reposter: null, reposterName: null, pinned: false, key: '100|', url: 'https://x.com/conta_a/status/100' });
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

test('nome de exibição de quem repostou: lido do elemento com dir (independe do idioma do verbo)', () => {
  const d = dom(page(article({ id: '1', author: 'orig', reposter: 'dryzinho', reposterName: 'Dryzinho' })));
  const [it] = Xdom.readItems(d);
  assert.equal(it.reposter, 'dryzinho');
  assert.equal(it.reposterName, 'Dryzinho');
  // outro idioma/verbo: o nome continua o mesmo
  const html = page(article({ id: '2', author: 'orig', reposter: 'ana' })).replace('repostou', 'reposted');
  assert.equal(Xdom.readItems(dom(html))[0].reposterName, 'ana Silva');
});

test('sem elemento com dir, o nome é nulo (a etiqueta cai para o @)', () => {
  const d = dom(page(article({ id: '3', author: 'orig', reposter: 'beto', repostStyle: 'div-contains-anchor' })));
  const [it] = Xdom.readItems(d);
  assert.equal(it.reposter, 'beto');
  assert.equal(it.reposterName, null);
});

// ---- lacunas ("Mostrar mais") e "Ver novos posts" ----
const cell = (inner) => `<div data-testid="cellInnerDiv">${inner}</div>`;
const col = (...cells) => `<div data-testid="primaryColumn">${cells.join('')}</div><div data-testid="sidebarColumn"><button>Mostrar mais</button></div>`;

test('findGapButtons: célula sem post com um botão "Mostrar mais" (pt, en e com contagem)', () => {
  for (const label of ['Mostrar mais', 'Show more', 'Mostrar 12 posts', 'Ver mais', 'Load more']) {
    const d = dom(col(cell(article({ id: '1', author: 'a' })), cell(`<div><button>${label}</button></div>`)));
    const found = Xdom.findGapButtons(d, d.defaultView);
    assert.equal(found.length, 1, label);
    assert.equal(found[0].textContent.trim(), label);
  }
});

test('findGapButtons: NUNCA devolve promoção, "Quem seguir", "Mostrar mais" dentro de post ou células com link', () => {
  const html = col(
    cell('<div><button>Inscrever-se</button></div>'),                                           // promoção
    cell('<div><button>Assine o Premium</button></div>'),
    cell(`<div data-testid="UserCell"><a href="/x"><span>X</span></a><button data-testid="9-follow">Seguir</button></div><button>Mostrar mais</button>`), // Quem seguir
    cell(article({ id: '2', author: 'a' }).replace('</article>', '<button data-testid="tweet-text-show-more-link">Mostrar mais</button></article>')),   // texto longo
    cell('<div><a href="/explore">Mostrar mais</a><button>Mostrar mais</button></div>'),         // tem link
    cell('<div><button>Mostrar mais</button><button>Fechar</button></div>'),                      // dois botões
    cell('<div><button data-testid="5-follow">Mostrar mais</button></div>'),                      // botão de seguir
    cell('<div><button>Mostrar mais ' + 'x'.repeat(60) + '</button></div>'),                      // texto longo demais
  );
  const d = dom(html);
  assert.equal(Xdom.findGapButtons(d, d.defaultView).length, 0);
});

test('findGapButtons: só a coluna principal (o "Mostrar mais" da lateral é ignorado) e só o que está na tela', () => {
  const d = dom(col(cell('<div><button>Mostrar mais</button></div>')));
  assert.equal(Xdom.findGapButtons(d, d.defaultView).length, 1);
  const sideOnly = dom('<div data-testid="primaryColumn"></div><div data-testid="sidebarColumn"><div data-testid="cellInnerDiv"><button>Mostrar mais</button></div></div>');
  assert.equal(Xdom.findGapButtons(sideOnly, sideOnly.defaultView).length, 0);
  const w = d.defaultView;
  Object.defineProperty(w, 'innerHeight', { value: 800 });
  const btn = d.querySelector('button');
  btn.getBoundingClientRect = () => ({ top: 3000, bottom: 3040, height: 40 });   // fora da tela
  assert.equal(Xdom.findGapButtons(d, w).length, 0);
  btn.getBoundingClientRect = () => ({ top: 400, bottom: 440, height: 40 });     // na tela
  assert.equal(Xdom.findGapButtons(d, w).length, 1);
});

test('findNewPostsPill: botão do topo "Ver novos posts"; ignora outros botões', () => {
  const d = dom('<div data-testid="primaryColumn"><button><div data-testid="pillLabel"><span>Ver novos posts</span></div></button><button>Mostrar mais</button></div>');
  const pill = Xdom.findNewPostsPill(d);
  assert.ok(pill && /novos posts/.test(pill.textContent));
  assert.equal(Xdom.findNewPostsPill(dom('<div><button>Ver novos posts</button></div>')), null);   // sem pillLabel
  assert.equal(Xdom.findNewPostsPill(dom('<button><div data-testid="pillLabel">Outra coisa</div></button>')), null);
});

test('findAppBanners: acha a faixa "Abrir no app X" no topo e não engole o conteúdo do X', () => {
  const w = new JSDOM(
    '<body><div id="root"><div id="banner"><div id="inner"><span>X</span><span id="t">Abrir no app X</span><a>ABRIR</a></div></div>' +
    '<div id="col" data-testid="primaryColumn"><article><span>Abrir no app de outro jeito</span></article></div></div></body>',
    { url: 'https://x.com/home' }
  ).window;
  Object.defineProperty(w, 'innerWidth', { value: 400 });
  const rect = (r) => () => Object.assign({ top: 0, left: 0, width: 0, height: 0 }, r);
  const el = (id) => w.document.getElementById(id);
  el('inner').getBoundingClientRect = rect({ width: 400, height: 70 });
  el('banner').getBoundingClientRect = rect({ width: 400, height: 70 });
  el('t').getBoundingClientRect = rect({ width: 200, height: 20 });
  el('root').getBoundingClientRect = rect({ width: 400, height: 3000 });
  const found = Xdom.findAppBanners(w.document, w);
  assert.deepEqual(found.map((n) => n.id), ['banner']);
});


function agesDom(id) {
  const w = new JSDOM(
    '<body><div data-testid="primaryColumn"><article data-testid="tweet"><div data-testid="User-Name">' +
    '<div><div><a id="n" href="/opta"><div id="nr"><div dir="ltr"><span><span>Opta</span></span></div><div dir="ltr"><span>✓</span></div></div></a></div></div>' +
    '<div><div id="hr"><div><a id="h" href="/opta"><div dir="ltr"><span>@opta</span></div></a></div><div dir="ltr"><span id="dot">·</span></div>' +
    `<div><a href="/opta/status/${id}"><time datetime="2026-10-06T09:00:00.000Z">6 de out</time></a></div></div></div>` +
    `</div><a href="/opta/status/${id}"><time>x</time></a></article></div></body>`,
    { url: 'https://x.com/opta/status/' + id }
  ).window;
  const rect = (top) => () => ({ top, left: 0, width: 80, height: 20, bottom: top + 20, right: 80 });
  return { w, place: (handleTop) => { w.document.getElementById('n').getBoundingClientRect = rect(0); w.document.getElementById('h').getBoundingClientRect = rect(handleTop); } };
}
const AGE_ID = String(BigInt(Date.UTC(2026, 9, 6, 9, 0) - 1288834974657) << 22n);          // post de 09:00 UTC
const AGE_NOW = Date.UTC(2026, 9, 6, 11, 30);                                                // 2 h 30 depois

test('setAges: @ abaixo do nome -> "· N h" logo depois do nome e do selo; esconde o horário do X', () => {
  const { w, place } = agesDom(AGE_ID);
  place(22);                                                                                // @ na linha de baixo
  assert.equal(Xdom.setAges(w.document, w, AGE_NOW), 1);
  const sp = w.document.querySelector('[data-nx-age]');
  assert.equal(sp.textContent, '· 2 h');
  assert.equal(sp.parentElement.id, 'nr');                                                  // dentro da linha do nome
  assert.ok(sp.previousElementSibling.textContent.includes('✓'));                           // depois do selo
  assert.equal(w.document.querySelectorAll('[data-nx-hidden]').length, 2);                  // "·" e horário do X
  Xdom.setAges(w.document, w, AGE_NOW + 40 * 60000);                                        // só atualiza, sem duplicar
  assert.equal(w.document.querySelectorAll('[data-nx-age]').length, 1);
  assert.equal(w.document.querySelector('[data-nx-age]').textContent, '· 3 h');
});

test('setAges: @ na mesma linha do nome -> idade no FIM de tudo (depois do @); acompanha a mudança de layout', () => {
  const { w, place } = agesDom(AGE_ID);
  place(1);                                                                                 // @ na mesma linha
  Xdom.setAges(w.document, w, AGE_NOW);
  let sp = w.document.querySelector('[data-nx-age]');
  assert.equal(sp.parentElement.id, 'hr');
  assert.equal(sp.parentElement.lastElementChild, sp);
  assert.equal(sp.textContent, '· 2 h');
  assert.equal(w.document.querySelectorAll('[data-nx-hidden]').length, 2);
  place(22);                                                                                // janela ficou estreita: @ desceu
  Xdom.setAges(w.document, w, AGE_NOW);
  sp = w.document.querySelector('[data-nx-age]');
  assert.equal(sp.parentElement.id, 'nr');
  assert.equal(w.document.querySelectorAll('[data-nx-age]').length, 1);
});

test('setAges: sem medidas de layout assume @ abaixo do nome', () => {
  const { w } = agesDom(AGE_ID);                                                            // jsdom: tudo zero
  Xdom.setAges(w.document, w, AGE_NOW);
  assert.equal(w.document.querySelector('[data-nx-age]').parentElement.id, 'nr');
});


test('findTextMoreButtons: todos os "Mostrar mais" da conversa (acima, o aberto e as respostas), só da coluna principal', () => {
  const art = (id, author, more) =>
    `<article data-testid="tweet"><a href="/${author}/status/${id}"><time>1</time></a>` +
    (more ? `<button data-testid="tweet-text-show-more-link">Mostrar mais</button>` : '') + '</article>';
  const w = new JSDOM(
    `<body><div data-testid="primaryColumn">${art('10', 'raiz', true)}${art('20', 'meio', false)}${art('30', 'foco', true)}${art('40', 'resp', true)}</div>` +
    `<aside>${art('99', 'lateral', true)}</aside></body>`,
    { url: 'https://x.com/foco/status/30' }
  ).window;
  const btns = Xdom.findTextMoreButtons(w.document);
  assert.equal(btns.length, 3);                                                   // raiz, foco e resposta; a lateral não
  btns[0].remove();
  assert.equal(Xdom.findTextMoreButtons(w.document).length, 2);                   // o que já abriu some da lista
});


test('visibleVideo: pega o vídeo mais visível e ignora o minúsculo ou o fora da tela', () => {
  const w = new JSDOM('<body><video id="gif"></video><video id="fora"></video><video id="ok"></video></body>', { url: 'https://x.com/home' }).window;
  Object.defineProperty(w, 'innerWidth', { value: 400 });
  Object.defineProperty(w, 'innerHeight', { value: 800 });
  const rect = (id, top, left, width, height) => { w.document.getElementById(id).getBoundingClientRect = () => ({ top, left, width, height, bottom: top + height, right: left + width }); };
  rect('gif', 100, 10, 60, 60);                       // pequeno demais
  rect('fora', 900, 0, 400, 300);                     // abaixo da tela
  rect('ok', 500, 0, 400, 300);                       // parte para fora: 300 de 300 -> 100% dentro? (500..800)
  const v = Xdom.visibleVideo(w.document, w);
  assert.equal(v.video.id, 'ok');
  assert.deepEqual(v.rect, { top: 500, left: 0, bottom: 800, right: 400 });
  assert.equal(Xdom.visibleVideo(new JSDOM('<body></body>').window.document, w), null);
});


test('visibleVideo devolve o player (videoComponent); controlsVisible segue a opacidade dos controles do X', () => {
  const w = new JSDOM(
    '<body><div data-testid="videoComponent" id="vc"><video id="v"></video><div id="ctl" style="opacity:1"><button data-testid="mute-button"></button></div></div></body>',
    { url: 'https://x.com/home' }
  ).window;
  Object.defineProperty(w, 'innerWidth', { value: 400 });
  Object.defineProperty(w, 'innerHeight', { value: 800 });
  w.document.getElementById('v').getBoundingClientRect = () => ({ top: 100, left: 0, width: 400, height: 225, bottom: 325, right: 400 });
  const v = Xdom.visibleVideo(w.document, w);
  assert.equal(v.component.id, 'vc');
  assert.equal(Xdom.controlsVisible(v.component, w), true);
  w.document.getElementById('ctl').style.opacity = '0';                          // controles sumiram
  assert.equal(Xdom.controlsVisible(v.component, w), false);
  w.document.getElementById('ctl').style.opacity = '1';
  w.document.getElementById('ctl').style.display = 'none';
  assert.equal(Xdom.controlsVisible(v.component, w), false);
  assert.equal(Xdom.controlsVisible(null, w), true);                              // sem player conhecido: não esconde
  w.document.querySelector('[data-testid="mute-button"]').remove();
  w.document.getElementById('ctl').style.display = '';
  assert.equal(Xdom.controlsVisible(v.component, w), true);                       // sem botão de som: não dá para saber
});


test('applyPlaybackRate: 1x devolve o vídeo ao normal depois de outra velocidade; sem escolha não mexe em nada', () => {
  const touched = new WeakSet();
  const video = { playbackRate: 1 };
  assert.equal(Xdom.applyPlaybackRate(video, 1, touched), false);              // padrão: deixa o X em paz
  assert.equal(video.playbackRate, 1);
  Xdom.applyPlaybackRate(video, 2, touched);                                    // escolheu 2x
  assert.equal(video.playbackRate, 2);
  video.playbackRate = 1;                                                       // o X recriou/zerou: reaplica
  Xdom.applyPlaybackRate(video, 2, touched);
  assert.equal(video.playbackRate, 2);
  Xdom.applyPlaybackRate(video, 1, touched);                                    // escolheu 1x: volta ao normal
  assert.equal(video.playbackRate, 1);
  video.playbackRate = 1.5;                                                     // depois disso o script não mexe mais
  assert.equal(Xdom.applyPlaybackRate(video, 1, touched), false);
  assert.equal(video.playbackRate, 1.5);
  const recusa = { get playbackRate() { return 1; }, set playbackRate(v) { throw new Error('não suportado'); } };
  assert.equal(Xdom.applyPlaybackRate(recusa, 0.1, new WeakSet()), false);      // o navegador recusou: não quebra
});


test('parseArticle: marca post fixado (contexto social sem link) e não confunde com repost', () => {
  const html = (ctx) => `<body><article data-testid="tweet">${ctx}<a href="/fulano/status/55"><time>1</time></a></article></body>`;
  const w = (ctx) => new JSDOM(html(ctx), { url: 'https://x.com/fulano' }).window.document.querySelector('article');
  assert.equal(Xdom.parseArticle(w('<div data-testid="socialContext"><span>Fixado</span></div>')).pinned, true);
  assert.equal(Xdom.parseArticle(w('<div data-testid="socialContext"><span>Pinned</span></div>')).pinned, true);
  assert.equal(Xdom.parseArticle(w('')).pinned, false);
  const rp = Xdom.parseArticle(w('<a href="/zeca"><span data-testid="socialContext"><span dir="ltr">Zeca</span> repostou</span></a>'));
  assert.equal(rp.pinned, false);
  assert.equal(rp.reposter, 'zeca');
});


test('pageMissing: reconhece página/post que não existe, sem confundir com a página ainda carregando nem com posts', () => {
  const dom = (html) => new JSDOM(`<body><div data-testid="primaryColumn">${html}</div></body>`, { url: 'https://x.com/a/status/1' }).window.document;
  assert.equal(Xdom.pageMissing(dom('<div data-testid="error-detail"><span>Esta página não existe</span></div>')), true);
  assert.equal(Xdom.pageMissing(dom('<div data-testid="emptyState">Essa conta foi suspensa</div>')), true);
  assert.equal(Xdom.pageMissing(dom('<div data-testid="cellInnerDiv"><span>Este post foi excluído.</span></div>')), true);
  assert.equal(Xdom.pageMissing(dom('<div data-testid="cellInnerDiv"><span>This post is unavailable</span></div>')), true);
  assert.equal(Xdom.pageMissing(dom('')), false);                                       // ainda carregando
  assert.equal(Xdom.pageMissing(dom('<div data-testid="cellInnerDiv"><div role="progressbar"></div></div>')), false);
  // frase "não existe" DENTRO de um post (ou de uma recomendação) não conta
  assert.equal(Xdom.pageMissing(dom('<div data-testid="cellInnerDiv"><article data-testid="tweet">isso não existe mais, sério</article></div>')), false);
});


test('setHeaderStatic: solta a barra "← Post" (sticky) para fazer parte da página; não mexe no que não é fixo', () => {
  const w = new JSDOM(
    '<body><div data-testid="primaryColumn"><div id="sticky" style="position:sticky;top:0"><div id="mid" style="position:relative">' +
    '<button data-testid="app-bar-back"></button><h2 role="heading">Post</h2></div></div><div id="posts"><article data-testid="tweet"></article></div></div></body>',
    { url: 'https://x.com/a/status/1' }
  ).window;
  const d = w.document;
  assert.equal(Xdom.setHeaderStatic(d, w), 1);
  assert.ok(d.getElementById('sticky').hasAttribute('data-nx-static'));
  assert.ok(!d.getElementById('mid').hasAttribute('data-nx-static'));                 // só o que é sticky/fixed
  assert.ok(!d.getElementById('posts').hasAttribute('data-nx-static'));
  assert.match(d.getElementById('nx-style').textContent, /\[data-nx-static\]\{position:static!important\}/);
  assert.equal(Xdom.setHeaderStatic(d, w), 0);                                        // idempotente
  // sem botão de voltar: usa o título; o X pode recriar a barra e ela volta a ser solta
  d.getElementById('sticky').remove();
  d.querySelector('[data-testid="primaryColumn"]').insertAdjacentHTML('afterbegin', '<div id="s2" style="position:fixed"><h2 role="heading">Post</h2></div>');
  assert.equal(Xdom.setHeaderStatic(d, w), 1);
  assert.ok(d.getElementById('s2').hasAttribute('data-nx-static'));
  assert.equal(Xdom.setHeaderStatic(new JSDOM('<body></body>').window.document, w), 0);   // sem coluna principal
});


test('setAges: o horário do X que o X recria ao redesenhar volta a ser escondido (sem duplicar), em qualquer aninhamento', () => {
  const id = String(BigInt(Date.UTC(2026, 9, 6, 9, 0) - 1288834974657) << 22n);
  // layout "celular": o horário e o "·" ficam um nível acima do @, não dentro da mesma linha que o desktop
  const html = (extra = '') =>
    '<body><div data-testid="primaryColumn"><article data-testid="tweet"><div data-testid="User-Name">' +
    '<div><div><a id="n" href="/jp"><div id="nr"><div dir="ltr"><span>Nação Fla</span></div></div></a></div></div>' +
    '<div><a id="h" href="/jp"><span>@jphora</span></a>' + extra + '</div>' +
    `</div><a href="/jp/status/${id}"><time>x</time></a></article></div></body>`;
  const own = `<div id="dot">·</div><div id="own"><a href="/jp/status/${id}"><time datetime="2026-10-06T09:00:00.000Z">16 h</time></a></div>`;
  const w = new JSDOM(html(own), { url: 'https://x.com/jp/status/' + id }).window;
  const d = w.document;
  const rect = (top) => () => ({ top, left: 0, width: 80, height: 20, bottom: top + 20, right: 80 });
  d.getElementById('n').getBoundingClientRect = rect(0);
  d.getElementById('h').getBoundingClientRect = rect(1);                            // @ na mesma linha
  const now = Date.UTC(2026, 9, 6, 11, 0);
  Xdom.setAges(d, w, now);
  assert.ok(d.getElementById('own').hasAttribute('data-nx-hidden') && d.getElementById('dot').hasAttribute('data-nx-hidden'));
  // o X redesenha: troca os elementos por novos, sem o atributo
  d.getElementById('own').remove();
  d.getElementById('dot').remove();
  d.getElementById('h').parentElement.insertAdjacentHTML('beforeend', own);
  assert.ok(!d.getElementById('own').hasAttribute('data-nx-hidden'));
  Xdom.setAges(d, w, now);
  assert.ok(d.getElementById('own').hasAttribute('data-nx-hidden') && d.getElementById('dot').hasAttribute('data-nx-hidden'));
  assert.equal(d.querySelectorAll('[data-nx-age]').length, 1);
  assert.equal(d.querySelector('[data-nx-age]').textContent, '· 2 h');
  assert.ok(!d.querySelector('[data-nx-age]').hasAttribute('data-nx-hidden'));       // o nosso nunca é escondido
});
