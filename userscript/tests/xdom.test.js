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


test('setHeaderStatic (computador): barra sticky DENTRO da coluna é escondida e a nossa entra no fluxo antes do conteúdo', () => {
  const w = new JSDOM(
    '<body style="background-color:rgb(0,0,0);color:rgb(231,233,234)"><div data-testid="primaryColumn"><div id="wrap">' +
    '<div id="orig" style="position:sticky;top:0"><div data-testid="TopNavBar"><button data-testid="app-bar-back"></button><h2 role="heading">Conversa</h2></div></div>' +
    '<div id="posts"><article data-testid="tweet"></article></div></div></div></body>',
    { url: 'https://x.com/a/status/1' }
  ).window;
  const d = w.document;
  let backs = 0;
  w.history.back = () => { backs++; };
  assert.equal(Xdom.setHeaderStatic(d, w), 1);
  assert.ok(d.getElementById('orig').hasAttribute('data-nx-hidden'), 'a original some por inteiro');
  const own = d.querySelector('[data-nx-header]');
  assert.equal(own.parentElement.id, 'wrap');
  assert.equal(own, d.getElementById('wrap').firstElementChild, 'a nossa é a primeira do conteúdo (no fluxo)');
  assert.equal(own.querySelector('[data-nx-title]').textContent, 'Conversa');
  assert.match(own.getAttribute('style'), /position:\s*static/);
  assert.doesNotMatch(own.getAttribute('style'), /sticky|fixed/);
  assert.match(own.getAttribute('style'), /background:\s*rgb\(0, 0, 0\)/);
  own.querySelector('button').click();
  assert.equal(backs, 1);
  assert.equal(Xdom.setHeaderStatic(d, w), 0);                                           // idempotente
  assert.equal(d.querySelectorAll('[data-nx-header]').length, 1);
  assert.ok(!d.getElementById('posts').hasAttribute('data-nx-hidden'));
});

test('setHeaderStatic (CELULAR): barra fixa numa camada FORA da coluna é escondida inteira e a nossa entra no fluxo da coluna', () => {
  // estrutura real do X no celular: camada absoluta com um contêiner fixo (h=0) que guarda a barra fixa (h=53); a coluna
  // principal é outra árvore, e o primeiro post começa em y=0, por baixo da barra.
  const w = new JSDOM(
    '<body><div id="layers"><div id="abs" style="position:absolute;top:0"><div id="fixwrap" style="position:fixed;top:0">' +
    '<div id="relwrap" style="position:relative"><div id="fixbar" style="position:fixed;top:0"><div data-testid="TopNavBar" id="tnb">' +
    '<button data-testid="app-bar-back"></button><h2 role="heading">Post</h2></div></div></div></div></div></div>' +
    '<header role="banner" id="spacer"><div style="height:50px"></div></header>' +
    '<div data-testid="primaryColumn" id="col"><div id="inner"><section><h1 style="position:absolute">Conversa</h1><div id="list"><article data-testid="tweet"></article></div></section></div></div>' +
    '<nav role="navigation" id="bottom"><a href="/home">h</a></nav></body>',
    { url: 'https://x.com/a/status/1' }
  ).window;
  const d = w.document;
  assert.equal(Xdom.setHeaderStatic(d, w), 1);
  assert.ok(d.getElementById('fixwrap').hasAttribute('data-nx-hidden'), 'o maior ancestral fixo é escondido');
  assert.ok(!d.getElementById('abs').hasAttribute('data-nx-hidden'), 'mas não a camada que pode conter outras coisas');
  assert.ok(!d.getElementById('bottom').hasAttribute('data-nx-hidden'), 'nem a barra de baixo');
  const own = d.querySelector('[data-nx-header]');
  assert.ok(d.getElementById('spacer').hasAttribute('data-nx-hidden'), 'o espaçador vazio de 50 px que o X reserva também some');
  assert.equal(own.parentElement.id, 'inner');                                           // dentro da coluna, no fluxo
  assert.equal(d.getElementById('inner').firstElementChild, own);                       // antes da lista de posts
  assert.equal(own.querySelector('[data-nx-title]').textContent, 'Post');
  assert.doesNotMatch(own.getAttribute('style'), /fixed|sticky|absolute/);
  assert.equal(Xdom.setHeaderStatic(d, w), 0);
  // a barra lateral (header com links) NÃO é um espaçador e nunca é escondida
  const sb = new JSDOM('<body><header role="banner" id="side"><nav role="navigation"><a href="/home">Início</a></nav></header><div id="tnb"><div data-testid="TopNavBar" style="position:fixed"></div></div><div data-testid="primaryColumn"><div><article data-testid="tweet"></article></div></div></body>', { url: 'https://x.com/a/status/1' }).window;
  Xdom.setHeaderStatic(sb.document, sb);
  assert.ok(!sb.document.getElementById('side').hasAttribute('data-nx-hidden'));
  // o X recria a camada da barra: some de novo e continua UMA só barra nossa, na primeira posição
  d.getElementById('fixwrap').remove();
  d.getElementById('abs').insertAdjacentHTML('beforeend', '<div id="fix2" style="position:fixed;top:0"><div data-testid="TopNavBar"><button data-testid="app-bar-back"></button><h2 role="heading">Post</h2></div></div>');
  Xdom.setHeaderStatic(d, w);
  assert.ok(d.getElementById('fix2').hasAttribute('data-nx-hidden'));
  assert.equal(d.querySelectorAll('[data-nx-header]').length, 1);
  assert.equal(d.getElementById('inner').firstElementChild, d.querySelector('[data-nx-header]'));
  // sem coluna principal: não faz nada
  assert.equal(Xdom.setHeaderStatic(new JSDOM('<body></body>').window.document, w), 0);
  // um ancestral que contém os posts nunca é escondido
  const w2 = new JSDOM('<body><div data-testid="primaryColumn"><div id="big" style="position:sticky;top:0"><div data-testid="TopNavBar"></div><article data-testid="tweet"></article></div></div></body>', { url: 'https://x.com/a/status/1' }).window;
  Xdom.setHeaderStatic(w2.document, w2);
  assert.ok(!w2.document.getElementById('big').hasAttribute('data-nx-hidden'));
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


test('threadLinks / readItems: lê as linhas de conversa do X (fim da célula de cima, começo da de baixo)', () => {
  const html =
    '<body><div data-testid="primaryColumn">' +
    '<div data-testid="cellInnerDiv" id="c1"><article data-testid="tweet"><a href="/ana/status/10"><time>1</time></a><div id="l1" style="background-color:rgb(51,54,57)"></div></article></div>' +
    '<div data-testid="cellInnerDiv" id="c2"><article data-testid="tweet"><a href="/ana/status/20"><time>2</time></a><div id="l2" style="background-color:rgb(51,54,57)"></div></article></div>' +
    '<div data-testid="cellInnerDiv" id="c3"><article data-testid="tweet"><a href="/beto/status/30"><time>3</time></a><div id="l3" style="background-color:transparent"></div></article></div>' +
    '</div></body>';
  const w = new JSDOM(html, { url: 'https://x.com/home' }).window;
  const d = w.document;
  const box = (id, top, height, width = 600, left = 0) => { d.getElementById(id).getBoundingClientRect = () => ({ top, left, width, height, bottom: top + height, right: left + width }); };
  box('c1', 0, 177); box('l1', 56, 121, 2, 35);          // linha da foto até o fim da célula: liga PARA BAIXO
  box('c2', 177, 383); box('l2', 177, 8, 2, 35);         // pedacinho de linha no começo da célula: liga PARA CIMA
  box('c3', 560, 300); box('l3', 560, 8, 2, 35);         // linha sem cor (transparente) não conta
  const [a, b, c] = Xdom.readItems(d);
  assert.deepEqual([a.linkPrev, a.linkNext], [false, true]);
  assert.deepEqual([b.linkPrev, b.linkNext], [true, false]);
  assert.deepEqual([c.linkPrev, c.linkNext], [false, false]);
  // sem layout (altura 0 / jsdom puro): desconhecido, os campos nem existem
  const w2 = new JSDOM(html, { url: 'https://x.com/home' }).window;
  const [u] = Xdom.readItems(w2.document);
  assert.ok(!('linkPrev' in u) && !('linkNext' in u));
});


test('blockEndedAdvance: o fim do vídeo não chega aos ouvintes do X (que pulariam para o próximo); liga/desliga sem remover', () => {
  const w = new JSDOM('<body><div id="player"><video id="v"></video></div></body>', { url: 'https://x.com/i/status/1' }).window;
  const d = w.document;
  const seen = { video: 0, ancestor: 0, window: 0, paused: 0 };
  const v = d.getElementById('v');
  v.pause = () => { seen.paused++; };
  v.addEventListener('ended', () => seen.video++);                                  // ouvinte do X no próprio <video>
  d.getElementById('player').addEventListener('ended', () => seen.ancestor++, true); // e num ancestral (captura)
  let on = true;
  const remove = Xdom.blockEndedAdvance(w, () => on);                                // registrado depois, mas em window: roda primeiro
  v.dispatchEvent(new w.Event('ended'));
  assert.deepEqual(seen, { video: 0, ancestor: 0, window: 0, paused: 1 });          // nenhum ouvinte do X viu; o vídeo só pausou
  on = false;                                                                        // desligado no menu: o X vê normalmente
  v.dispatchEvent(new w.Event('ended'));
  assert.deepEqual([seen.video, seen.ancestor, seen.paused], [1, 1, 1]);
  on = true;
  d.getElementById('player').dispatchEvent(new w.Event('ended'));                    // só <video> é bloqueado
  assert.equal(seen.ancestor, 2);
  remove();                                                                          // removido: tudo volta ao normal
  v.dispatchEvent(new w.Event('ended'));
  assert.deepEqual([seen.video, seen.ancestor], [2, 3]);
});


test('setHeaderStatic: compensa o começo do conteúdo acima da tela (margem negativa do X), uma vez só', () => {
  const w = new JSDOM('<body><div data-testid="primaryColumn"><div id="inner"><div id="o" style="position:sticky;top:0"><div data-testid="TopNavBar"></div></div><article data-testid="tweet"></article></div></div></body>', { url: 'https://x.com/a/status/1' }).window;
  const d = w.document;
  let top = -10;
  const orig = w.Element.prototype.getBoundingClientRect;
  w.Element.prototype.getBoundingClientRect = function () {
    return this.hasAttribute && this.hasAttribute('data-nx-header') ? { top, left: 0, width: 400, height: 53, bottom: top + 53, right: 400 } : orig.call(this);
  };
  Xdom.setHeaderStatic(d, w);
  const own = d.querySelector('[data-nx-header]');
  assert.equal(own.style.marginTop, '10px');                       // topo cortado em 10 px: empurrado para dentro
  top = 0;                                                         // já na tela: nada a mais, e não acumula
  Xdom.setHeaderStatic(d, w);
  assert.equal(own.style.marginTop, '10px');
});


test('setHeaderStatic: a barra nossa usa a fonte e a cor do título do X (sem serifa), e sans-serif se não puder ler', () => {
  const html = (title) =>
    '<body><div data-testid="primaryColumn"><div id="inner"><div id="o" style="position:fixed;top:0"><div data-testid="TopNavBar">' +
    '<button data-testid="app-bar-back"></button>' + title + '</div></div><article data-testid="tweet"></article></div></div></body>';
  const w = new JSDOM(html('<h2 role="heading" style="font-family: TwitterChirp, sans-serif; color: rgb(15, 20, 25)">Post</h2>'), { url: 'https://x.com/a/status/1' }).window;
  Xdom.setHeaderStatic(w.document, w);
  const own = w.document.querySelector('[data-nx-header]');
  assert.match(own.getAttribute('style'), /font-family:\s*TwitterChirp, sans-serif/);
  assert.match(own.getAttribute('style'), /color:\s*rgb\(15, 20, 25\)/);
  assert.doesNotMatch(own.getAttribute('style'), /(?<!sans-)serif|Times/);   // nada de fonte com serifa
  // o X recria a barra (e a original some): a nossa mantém a fonte lida na criação
  w.document.getElementById('o').remove();
  Xdom.setHeaderStatic(w.document, w);
  assert.match(w.document.querySelector('[data-nx-header]').getAttribute('style'), /TwitterChirp/);
  // sem título legível: cai na pilha sem serifa
  const w2 = new JSDOM(html(''), { url: 'https://x.com/a/status/1' }).window;
  Xdom.setHeaderStatic(w2.document, w2);
  assert.match(w2.document.querySelector('[data-nx-header]').getAttribute('style'), /font-family:\s*[^;]*sans-serif/i);
});


test('leaveFullscreen: sai do player nativo, do Fullscreen API e do visualizador de vídeo do X; senão não faz nada', () => {
  const mk = (url = 'https://x.com/home') => {
    const w = new JSDOM('<body><video id="v"></video></body>', { url }).window;
    const calls = [];
    w.history.back = () => calls.push('back');
    const v = w.document.getElementById('v');
    return { w, v, calls };
  };
  // 1) player nativo do iPhone
  let c = mk();
  c.v.webkitDisplayingFullscreen = true;
  c.v.webkitExitFullscreen = () => c.calls.push('nativo');
  assert.equal(Xdom.leaveFullscreen(c.v, c.w), true);
  assert.deepEqual(c.calls, ['nativo']);
  // 2) modo de apresentação do WebKit
  c = mk();
  c.v.webkitPresentationMode = 'fullscreen';
  c.v.webkitSetPresentationMode = (m) => c.calls.push('modo:' + m);
  assert.equal(Xdom.leaveFullscreen(c.v, c.w), true);
  assert.deepEqual(c.calls, ['modo:inline']);
  // 3) Fullscreen API
  c = mk();
  Object.defineProperty(c.w.document, 'fullscreenElement', { value: c.v, configurable: true });
  c.w.document.exitFullscreen = () => { c.calls.push('api'); return Promise.resolve(); };
  assert.equal(Xdom.leaveFullscreen(c.v, c.w), true);
  assert.deepEqual(c.calls, ['api']);
  // 4) visualizador de vídeo do X (rota própria): volta uma página
  c = mk('https://x.com/geglobo/status/2108/video/1');
  assert.equal(Xdom.leaveFullscreen(c.v, c.w), true);
  assert.deepEqual(c.calls, ['back']);
  // 5) vídeo comum na linha do tempo (nada em tela cheia): não faz nada, nem volta página
  c = mk('https://x.com/geglobo/status/2108');
  assert.equal(Xdom.leaveFullscreen(c.v, c.w), false);
  assert.deepEqual(c.calls, []);
  // quando o player nativo já tratou, não volta também a página
  c = mk('https://x.com/a/status/9/video/1');
  c.v.webkitDisplayingFullscreen = true;
  c.v.webkitExitFullscreen = () => c.calls.push('nativo');
  Xdom.leaveFullscreen(c.v, c.w);
  assert.deepEqual(c.calls, ['nativo']);
});

test('blockEndedAdvance: sair da tela cheia e bloquear o avanço são independentes', () => {
  const w = new JSDOM('<body><video id="v"></video></body>', { url: 'https://x.com/home' }).window;
  const v = w.document.getElementById('v');
  const seen = { x: 0, left: 0, paused: 0 };
  v.pause = () => { seen.paused++; };
  v.webkitDisplayingFullscreen = true;
  v.webkitExitFullscreen = () => { seen.left++; };
  v.addEventListener('ended', () => seen.x++);
  let block = true;
  let leave = true;
  Xdom.blockEndedAdvance(w, () => block, () => leave);
  v.dispatchEvent(new w.Event('ended'));
  assert.deepEqual(seen, { x: 0, left: 1, paused: 1 });                       // X não viu; saiu da tela cheia; pausou
  leave = false;
  v.dispatchEvent(new w.Event('ended'));
  assert.deepEqual(seen, { x: 0, left: 1, paused: 2 });                       // só bloqueia
  block = false;
  leave = true;
  v.dispatchEvent(new w.Event('ended'));
  assert.deepEqual(seen, { x: 1, left: 2, paused: 2 });                       // só sai da tela cheia; o X ainda vê o fim
  leave = false;
  v.dispatchEvent(new w.Event('ended'));
  assert.deepEqual(seen, { x: 2, left: 2, paused: 2 });                       // tudo desligado: nada muda
});


test('blockEndedAdvance: avisa o fim (onEnded) com o que foi feito; visualizador /immersive também fecha', () => {
  const w = new JSDOM('<body><video id="v"></video></body>', { url: 'https://x.com/i/immersive/123' }).window;
  const v = w.document.getElementById('v');
  const calls = [];
  w.history.back = () => calls.push('back');
  const ended = [];
  Xdom.blockEndedAdvance(w, () => true, () => true, (video, r) => ended.push(r));
  v.dispatchEvent(new w.Event('ended'));
  assert.deepEqual(calls, ['back']);                                           // rota imersiva: voltou uma página
  assert.deepEqual(ended, [{ block: true, leave: true, left: true }]);
  // página de post comum: nada em tela cheia, não volta, e avisa que não saiu (para o diagnóstico)
  const w2 = new JSDOM('<body><video id="v"></video></body>', { url: 'https://x.com/geglobo/status/2108' }).window;
  const back2 = [];
  w2.history.back = () => back2.push('back');
  const ended2 = [];
  Xdom.blockEndedAdvance(w2, () => false, () => true, (video, r) => ended2.push(r));
  w2.document.getElementById('v').dispatchEvent(new w2.Event('ended'));
  assert.deepEqual(back2, []);
  assert.deepEqual(ended2, [{ block: false, leave: true, left: false }]);
});


test('leaveFullscreen: no visualizador do X (/mediaViewer) aperta o botão voltar do vídeo; sem o botão, volta a página', () => {
  const html = (url) => new JSDOM(
    '<body><div data-testid="vss-scroll-view">' +
    '<div data-testid="cellInnerDiv-tweet-111"><button data-testid="immersive-tweet-back-button-111"></button><video id="v1"></video></div>' +
    '<div data-testid="cellInnerDiv-tweet-222"><button data-testid="immersive-tweet-back-button-222"></button><video id="v2"></video></div>' +
    '</div></body>', { url }).window;
  const w = html('https://x.com/geglobo/status/222/mediaViewer?currentTweet=222&currentTweetUser=geglobo');
  const clicked = [];
  w.document.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => clicked.push(b.getAttribute('data-testid'))));
  w.history.back = () => clicked.push('history.back');
  assert.equal(Xdom.leaveFullscreen(w.document.getElementById('v2'), w), true);
  assert.deepEqual(clicked, ['immersive-tweet-back-button-222']);                       // o botão do vídeo que acabou, não o do vizinho
  // sem botão (X mudou o markup): cai na rota /mediaViewer e volta uma página
  const w2 = new JSDOM('<body><video id="v"></video></body>', { url: 'https://x.com/a/status/9/mediaViewer?currentTweet=9' }).window;
  const back = [];
  w2.history.back = () => back.push('back');
  assert.equal(Xdom.leaveFullscreen(w2.document.getElementById('v'), w2), true);
  assert.deepEqual(back, ['back']);
  // página de post comum com vídeo: nada
  const w3 = new JSDOM('<body><video id="v"></video></body>', { url: 'https://x.com/a/status/9' }).window;
  assert.equal(Xdom.leaveFullscreen(w3.document.getElementById('v'), w3), false);
});

test('watchVideoLoop: liga o loop ao tocar e avisa a cada volta ao começo (o "fim" que o X nunca vê)', () => {
  const w = new JSDOM('<body><video id="v"></video></body>', { url: 'https://x.com/home' }).window;
  const v = w.document.getElementById('v');
  let on = true;
  const loops = [];
  Xdom.watchVideoLoop(w, { loopOn: () => on, onLoop: (video) => loops.push(video.id) });
  Object.defineProperty(v, 'duration', { value: 10, configurable: true });
  const time = (t) => { Object.defineProperty(v, 'currentTime', { value: t, configurable: true }); v.dispatchEvent(new w.Event('timeupdate')); };
  v.dispatchEvent(new w.Event('play'));
  assert.equal(v.loop, true);                                         // o vídeo não termina: o X não vê o `ended`
  time(1); time(5); time(9.7);
  assert.deepEqual(loops, []);                                        // ainda tocando
  time(0.2);                                                          // deu a volta ao começo = o vídeo "terminou"
  assert.deepEqual(loops, ['v']);
  time(0.6); time(1.2);                                               // continua tocando: sem novo aviso
  assert.deepEqual(loops, ['v']);
  on = false;                                                         // desligado no menu
  time(9.9); time(0.1);
  assert.deepEqual(loops, ['v']);
  // duração desconhecida (transmissão ao vivo): nada
  on = true;
  Object.defineProperty(v, 'duration', { value: Infinity, configurable: true });
  time(5); time(0.1);
  assert.deepEqual(loops, ['v']);
});
