const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../src/core.js');

test('parseStatusPath: aceita só /usuario/status/ID exato', () => {
  assert.deepEqual(Core.parseStatusPath('/conta_a/status/123'), { author: 'conta_a', id: '123' });
  assert.equal(Core.parseStatusPath('/conta_a/status/123/photo/1'), null);
  assert.equal(Core.parseStatusPath('/conta_a/status/abc'), null);
  assert.equal(Core.parseStatusPath('/conta_a'), null);
  assert.equal(Core.parseStatusPath(''), null);
});

test('parseStatusHref: relativo, absoluto e hosts estranhos', () => {
  const o = 'https://x.com';
  assert.deepEqual(Core.parseStatusHref('/a/status/9', o), { author: 'a', id: '9' });
  assert.deepEqual(Core.parseStatusHref('https://twitter.com/a/status/9', o), { author: 'a', id: '9' });
  assert.equal(Core.parseStatusHref('https://evil.com/a/status/9', o), null);
  assert.equal(Core.parseStatusHref('https://notx.com/a/status/9', o), null);
});

test('parseProfileHref: perfil sim; rotas reservadas e subcaminhos não', () => {
  const o = 'https://x.com';
  assert.equal(Core.parseProfileHref('/fulano', o), 'fulano');
  assert.equal(Core.parseProfileHref('/fulano/', o), 'fulano');
  assert.equal(Core.parseProfileHref('/home', o), null);
  assert.equal(Core.parseProfileHref('/i', o), null);
  assert.equal(Core.parseProfileHref('/fulano/status/1', o), null);
  assert.equal(Core.parseProfileHref('/nome_longo_demais_x', o), null);
});

test('appearanceKey ignora maiúsculas do reposter', () => {
  assert.equal(Core.appearanceKey('10', 'Ana'), '10|ana');
  assert.equal(Core.appearanceKey('10', null), '10|');
});

test('formatDateBR: dd/mm/aaaa às hh:mm', () => {
  assert.equal(Core.formatDateBR(new Date(2026, 9, 3, 21, 14)), '03/10/2026 às 21:14');
  assert.equal(Core.formatDateBR(new Date(2026, 0, 5, 7, 5)), '05/01/2026 às 07:05');
  assert.equal(Core.formatDateBR('lixo'), '');
});

const item = (id, author) => ({ id: String(id), author });

test('pickThreadTarget: cadeia contígua do mesmo autor, último é o destino', () => {
  const items = [item(1, 'pai'), item(10, 'autor'), item(11, 'autor'), item(12, 'Autor'), item(13, 'outro')];
  const r = Core.pickThreadTarget(items, '10', 'autor');
  assert.equal(r.target.id, '12');
  assert.deepEqual(r.chain.map((i) => i.id), ['11', '12']);
});

test('pickThreadTarget: sem encadeamento -> null (posts independentes não são agrupados)', () => {
  const items = [item(10, 'autor'), item(20, 'outro'), item(30, 'autor')];
  assert.equal(Core.pickThreadTarget(items, '10', 'autor'), null);
});

test('pickThreadTarget: para quando o ID deixa de crescer', () => {
  const items = [item(10, 'autor'), item(11, 'autor'), item(5, 'autor'), item(12, 'autor')];
  assert.deepEqual(Core.pickThreadTarget(items, '10', 'autor').chain.map((i) => i.id), ['11']);
});

test('pickThreadTarget: focal ausente -> null; IDs grandes (BigInt) funcionam', () => {
  assert.equal(Core.pickThreadTarget([item(1, 'a')], '99', 'a'), null);
  const big = [item('1840000000000000001', 'a'), item('1840000000000000002', 'a')];
  assert.equal(Core.pickThreadTarget(big, '1840000000000000001', 'a').target.id, '1840000000000000002');
});

test('buildBadges: repost, já visto (com contagem), thread e lacuna', () => {
  const fmt = () => '03/10/2026 às 21:14';
  const e = {
    reposters: ['ana', 'beto'],
    view_count: 2,
    views: [{ viewed_at: 'x' }, { viewed_at: 'y' }],
    covered_count: 3,
    gap_before: true,
  };
  assert.deepEqual(Core.buildBadges(e, fmt), [
    '↻ repostado por @ana, @beto',
    '👁 já visto em 03/10/2026 às 21:14 (2 vezes)',
    '⛓ inclui 3 posts desta thread',
    '⚠ pode haver posts não capturados antes deste',
  ]);
  assert.deepEqual(Core.buildBadges({ reposters: [], view_count: 1, views: [{ viewed_at: 'x' }], covered_count: 1 }, fmt), [
    '👁 já visto em 03/10/2026 às 21:14',
    '⛓ inclui 1 post desta thread',
  ]);
  assert.deepEqual(Core.buildBadges({ reposters: [], view_count: 0, views: [], covered_count: 0 }, fmt), []);
  assert.deepEqual(Core.buildBadges(null), []);
});

test('isFeedPath: home e listas, com/sem barra final', () => {
  assert.equal(Core.isFeedPath('https://x.com/home', '/home'), true);
  assert.equal(Core.isFeedPath('https://x.com/home', '/home/'), true);
  assert.equal(Core.isFeedPath('https://x.com/i/lists/123', '/i/lists/123'), true);
  assert.equal(Core.isFeedPath('https://x.com/home', '/explore'), false);
});

test('toApiItem e newBatchId', () => {
  assert.deepEqual(Core.toApiItem({ id: '1', author: 'a', reposter: 'b' }), { tweet_id: '1', author: 'a', reposter: 'b', kind: 'repost' });
  assert.deepEqual(Core.toApiItem({ id: '1', author: 'a', reposter: null }), { tweet_id: '1', author: 'a', reposter: null, kind: 'post' });
  assert.notEqual(Core.newBatchId(), Core.newBatchId());
  assert.match(Core.newBatchId(), /^[\w.:-]+$/);
});

test('buildBannerText: só quando há repost', () => {
  assert.equal(Core.buildBannerText({ reposters: ['ana', 'beto'] }), '↻ uma mensagem dessa thread foi repostada por @ana, @beto');
  assert.equal(Core.buildBannerText({ reposters: [] }), null);
  assert.equal(Core.buildBannerText(null), null);
});

test('buildLabelParts: topo (repost, thread, lacuna) separado do "já visto"', () => {
  const fmt = () => '03/10/2026 às 21:14';
  const e = { reposters: ['ana'], view_count: 2, views: [{ viewed_at: 'x' }, { viewed_at: 'y' }], covered_count: 2, gap_before: true };
  assert.deepEqual(Core.buildLabelParts(e, fmt), {
    top: ['↻ repostado por @ana', '⛓ inclui 2 posts desta thread', '⚠ pode haver posts não capturados antes deste'],
    seen: '👁 já visto em 03/10/2026 às 21:14 (2 vezes)',
  });
  assert.deepEqual(Core.buildLabelParts({ reposters: [], view_count: 0, views: [] }, fmt), { top: [], seen: null });
  assert.deepEqual(Core.buildLabelParts(null), { top: [], seen: null });
});
