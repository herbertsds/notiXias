const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const Labels = require('../src/labels.js');
const { article, page } = require('./fixtures/builders.js');

const dom = (html) => new JSDOM(html, { url: 'https://x.com/ana/status/3' }).window.document;
const arts = (d) => Array.from(d.querySelectorAll('article'));
const nx = (art, kind) => (art.previousElementSibling && art.previousElementSibling.getAttribute('data-nx') === kind ? [art.previousElementSibling] : []);
const MODEL = { tweetId: '3', lines: ['↻ repostado por @ana'], seen: '👁 já visto em 03/10/2026 às 21:14', bannerText: '↻ uma mensagem dessa thread foi repostada por @ana' };

test('a faixa é IRMÃ imediatamente antes do article (não filha: os filhos do X ficam lado a lado)', () => {
  const d = dom(page(article({ id: '3', author: 'a' })));
  const r = Labels.sync(d, MODEL);
  const [art] = arts(d);
  assert.deepEqual(r, { label: true, seen: false, banner: false });
  assert.equal(art.previousElementSibling.getAttribute('data-nx'), 'label');
  assert.equal(art.querySelectorAll('[data-nx]').length, 0, 'nada injetado dentro do article');
  assert.match(art.previousElementSibling.textContent, /repostado por @ana/);
  assert.match(art.previousElementSibling.textContent, /já visto em 03\/10\/2026/);
  const st = art.previousElementSibling.getAttribute('style');
  assert.match(st, /width:100%/);
  assert.match(st, /color:#71767b/); // cinza discreto, sem fundo colorido
  assert.ok(!/background/.test(st));
});

test('@handle vira link para o perfil; o resto é texto', () => {
  const d = dom(page(article({ id: '3', author: 'a' })));
  Labels.sync(d, MODEL);
  const links = [...d.querySelectorAll('[data-nx="label"] a')];
  assert.deepEqual(links.map((a) => a.getAttribute('href')), ['https://x.com/ana']);
  assert.equal(links[0].textContent, '@ana');
  Labels.sync(d, { ...MODEL, lines: ['↻ repostado por @ana, @beto_2'] });
  assert.deepEqual([...d.querySelectorAll('[data-nx="label"] a')].map((a) => a.textContent), ['@ana', '@beto_2']);
});

test('linha de aviso (⚠) recebe cor de alerta', () => {
  const d = dom(page(article({ id: '3', author: 'a' })));
  Labels.sync(d, { ...MODEL, lines: ['⚠ pode haver posts não capturados antes deste'] });
  assert.match(d.querySelector('[data-nx="label"] div').getAttribute('style'), /#f0b429/);
});

test('sem aviso quando o primeiro post da tela já é o da fila', () => {
  const d = dom(page(article({ id: '3', author: 'a' }), article({ id: '9', author: 'b' })));
  Labels.sync(d, MODEL);
  assert.equal(d.querySelectorAll('[data-nx="banner"]').length, 0);
});

test('aviso de repost no primeiro post da tela quando o repostado vem depois (cadeia acima)', () => {
  const d = dom(page(article({ id: '1', author: 'a' }), article({ id: '3', author: 'a' })));
  const r = Labels.sync(d, MODEL);
  const [first, second] = arts(d);
  assert.deepEqual(r, { label: true, seen: false, banner: true });
  assert.equal(nx(first, 'banner').length, 1);
  assert.match(first.previousElementSibling.textContent, /uma mensagem dessa thread foi repostada por @ana/);
  assert.equal(nx(first, 'label').length, 0);
  assert.equal(nx(second, 'label').length, 1);
});

test('sem aviso quando não há texto de aviso (post não repostado)', () => {
  const d = dom(page(article({ id: '1', author: 'a' }), article({ id: '3', author: 'a' })));
  Labels.sync(d, { ...MODEL, bannerText: null });
  assert.equal(d.querySelectorAll('[data-nx="banner"]').length, 0);
});

test('idempotente: sync repetido não reescreve o DOM (sem laço de mutação)', () => {
  const d = dom(page(article({ id: '1', author: 'a' }), article({ id: '3', author: 'a' })));
  Labels.sync(d, MODEL);
  let mutations = 0;
  new d.defaultView.MutationObserver(() => { mutations++; }).observe(d.body, { childList: true, subtree: true, characterData: true, attributes: true });
  Labels.sync(d, MODEL);
  Labels.sync(d, MODEL);
  return new Promise((res) => setTimeout(() => { assert.equal(mutations, 0); res(); }, 20));
});

test('reinsere a etiqueta se o X redesenhar o post e ela sumir', () => {
  const d = dom(page(article({ id: '3', author: 'a' })));
  Labels.sync(d, MODEL);
  d.querySelector('[data-nx="label"]').remove();
  Labels.sync(d, MODEL);
  assert.equal(d.querySelectorAll('[data-nx="label"]').length, 1);
});

test('atualiza o texto quando o modelo muda e remove etiquetas de posts que não são mais o da fila', () => {
  const d = dom(page(article({ id: '3', author: 'a' }), article({ id: '4', author: 'a' })));
  Labels.sync(d, MODEL);
  Labels.sync(d, { ...MODEL, lines: ['⛓ inclui 2 posts desta thread'] });
  assert.match(d.querySelector('[data-nx="label"]').textContent, /inclui 2 posts/);
  Labels.sync(d, { tweetId: '4', lines: ['x'], bannerText: null });
  const [a3, a4] = arts(d);
  assert.equal(nx(a3, 'label').length, 0);
  assert.equal(nx(a4, 'label').length, 1);
});

test('post da fila ausente da página: nada é injetado; clear remove tudo', () => {
  const d = dom(page(article({ id: '1', author: 'a' })));
  assert.deepEqual(Labels.sync(d, { ...MODEL, tweetId: '99', bannerText: null }), { label: false, seen: false, banner: false });
  Labels.sync(d, { ...MODEL, tweetId: '1' });
  Labels.clear(d);
  assert.equal(d.querySelectorAll('[data-nx]').length, 0);
});

test('texto da etiqueta entra como texto (sem interpretar HTML)', () => {
  const d = dom(page(article({ id: '3', author: 'a' })));
  Labels.sync(d, { ...MODEL, lines: ['<img src=x onerror=alert(1)>'] });
  assert.equal(d.querySelectorAll('[data-nx="label"] img').length, 0);
});

// ---- posição do "já visto": logo abaixo da data ----
const SEEN = '👁 já visto em 03/10/2026 às 21:14';

test('"já visto" vai logo ABAIXO da linha da data; "repostado" continua acima do post', () => {
  const d = dom(page(article({ id: '3', author: 'a', detail: true })));
  const r = Labels.sync(d, MODEL);
  const [art] = arts(d);
  const row = art.querySelector('[data-testid="dateRow"]');
  assert.deepEqual(r, { label: true, seen: true, banner: false });
  assert.equal(row.nextElementSibling.getAttribute('data-nx'), 'seen');
  assert.equal(row.nextElementSibling.textContent.replace(/\s+/g, ''), SEEN.replace(/\s+/g, ''));
  assert.equal(art.previousElementSibling.getAttribute('data-nx'), 'label');
  assert.ok(!/já visto/.test(art.previousElementSibling.textContent), 'o topo não repete o "já visto"');
  assert.match(art.previousElementSibling.textContent, /repostado por @ana/);
});

test('sem linha de data (layout compacto): "já visto" cai para o fim da faixa de cima', () => {
  const d = dom(page(article({ id: '3', author: 'a' })));
  const r = Labels.sync(d, MODEL);
  assert.deepEqual(r, { label: true, seen: false, banner: false });
  assert.equal(d.querySelectorAll('[data-nx="seen"]').length, 0);
  const lines = [...arts(d)[0].previousElementSibling.children].map((c) => c.textContent);
  assert.match(lines[lines.length - 1], /já visto em 03\/10\/2026/);
});

test('"já visto" sozinho (sem etiquetas de cima): não cria faixa no topo', () => {
  const d = dom(page(article({ id: '3', author: 'a', detail: true })));
  Labels.sync(d, { tweetId: '3', lines: [], seen: SEEN, bannerText: null });
  assert.equal(arts(d)[0].previousElementSibling, null);
  assert.equal(d.querySelectorAll('[data-nx="label"]').length, 0);
  assert.equal(d.querySelectorAll('[data-nx="seen"]').length, 1);
});

test('"já visto" é idempotente, reinserido se sumir, atualizado e removido quando deixa de valer', async () => {
  const d = dom(page(article({ id: '3', author: 'a', detail: true })));
  Labels.sync(d, MODEL);
  let mutations = 0;
  new d.defaultView.MutationObserver(() => { mutations++; }).observe(d.body, { childList: true, subtree: true, characterData: true, attributes: true });
  Labels.sync(d, MODEL);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mutations, 0);
  d.querySelector('[data-nx="seen"]').remove();
  Labels.sync(d, MODEL);
  assert.equal(d.querySelectorAll('[data-nx="seen"]').length, 1);
  Labels.sync(d, { ...MODEL, seen: '👁 já visto em 04/10/2026 às 08:42 (2 vezes)' });
  assert.match(d.querySelector('[data-nx="seen"]').textContent, /04\/10\/2026.*2 vezes/);
  Labels.sync(d, { ...MODEL, seen: null });
  assert.equal(d.querySelectorAll('[data-nx="seen"]').length, 0);
});

test('visual: fonte maior, mais espaço abaixo do texto, ícone em coluna própria (texto à direita dele)', () => {
  const d = dom(page(article({ id: '3', author: 'a', detail: true })));
  Labels.sync(d, MODEL);
  const top = arts(d)[0].previousElementSibling;
  const st = top.getAttribute('style');
  assert.match(st, /font:600 16px/);
  assert.match(st, /padding:12px 16px 14px/);
  const icon = top.querySelector('div > span');
  assert.equal(icon.textContent, '↻');
  assert.match(icon.getAttribute('style'), /display:inline-block;width:34px/);
  assert.match(top.textContent, /^↻repostado por @ana$/);
});
