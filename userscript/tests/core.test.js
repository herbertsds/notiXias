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
    '👁 Visto em 03/10/2026 às 21:14 (2 vezes)',
    '⛓ inclui 3 posts desta thread',
    '⚠ pode haver posts não capturados antes deste',
  ]);
  assert.deepEqual(Core.buildBadges({ reposters: [], view_count: 1, views: [{ viewed_at: 'x' }], covered_count: 1 }, fmt), [
    '👁 Visto em 03/10/2026 às 21:14',
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
    seen: '👁 Visto em 03/10/2026 às 21:14 (2 vezes)',
  });
  assert.deepEqual(Core.buildLabelParts({ reposters: [], view_count: 0, views: [] }, fmt), { top: [], seen: null });
  assert.deepEqual(Core.buildLabelParts(null), { top: [], seen: null });
});

test('repost aparece também em entrada já vista: usa all_reposters (de outras entradas do mesmo tweet)', () => {
  const fmt = () => 'D';
  const lida = { reposters: [], all_reposters: ['ana'], view_count: 1, views: [{ viewed_at: 'x' }], covered_count: 0 };
  assert.deepEqual(Core.buildLabelParts(lida, fmt), { top: ['↻ repostado por @ana'], seen: '👁 Visto em D' });
  assert.deepEqual(Core.buildBadges(lida, fmt)[0], '↻ repostado por @ana');
  assert.equal(Core.buildBannerText(lida), '↻ uma mensagem dessa thread foi repostada por @ana');
  // sem all_reposters (API antiga) cai para reposters da entrada
  assert.deepEqual(Core.buildLabelParts({ reposters: ['zeca'], view_count: 0, views: [] }).top, ['↻ repostado por @zeca']);
  // all_reposters vazio e reposters vazio: nada
  assert.deepEqual(Core.buildLabelParts({ reposters: [], all_reposters: [] }), { top: [], seen: null });
});

test('splitConversation: ancestrais (acima do focal, qualquer autor) e o resto', () => {
  const items = [{ id: '1', author: 'a' }, { id: '2', author: 'b' }, { id: '3', author: 'c' }, { id: '4', author: 'c' }];
  assert.deepEqual(Core.splitConversation(items, '3').before.map((i) => i.id), ['1', '2']);
  assert.deepEqual(Core.splitConversation(items, '3').after.map((i) => i.id), ['4']);
  assert.deepEqual(Core.splitConversation(items, '1').before, []);
  assert.deepEqual(Core.splitConversation(items, '99'), { before: [], after: [] });
});

// ---- conversas no feed (IDs reais observados no Seguindo em 2026-10-04) ----
const f = (id, reposter) => ({ id, author: 'x', reposter: reposter || null });

test('clusterize: raiz + respostas (ID crescente de cima para baixo) formam uma conversa', () => {
  const feed = [
    f('2106722693630345290'),
    f('2106703818130149651'), f('2106711451792822638'), f('2106718319915217378'), // conversa 1: raiz, resposta, resposta
    f('2106716219420422521'), f('2106715963739807892'), f('2106714190031302934'),
    f('2106683929512005685', 'Videos_Dryzinho'),                                     // repost: nunca entra em conversa
    f('2106704479487926388'),
    f('2106348268871442511'), f('2106703509060211108'), f('2106703885448413661'),    // conversa 2
    f('2106443813606596653'),
  ];
  const c = Core.clusterize(feed);
  assert.deepEqual(c.map((i) => i.cluster || 0), [0, 1, 1, 1, 0, 0, 0, 0, 0, 2, 2, 2, 0]);
});

test('clusterize: repost no meio quebra a corrida; ordem normal (decrescente) nunca agrupa', () => {
  assert.deepEqual(Core.clusterize([f('1'), f('3', 'r'), f('5')]).map((i) => i.cluster || 0), [0, 0, 0]);
  assert.deepEqual(Core.clusterize([f('9'), f('8'), f('7')]).map((i) => i.cluster || 0), [0, 0, 0]);
  assert.deepEqual(Core.clusterize([f('5'), f('5')]).map((i) => i.cluster || 0), [0, 0]); // igual não é crescente
  assert.deepEqual(Core.clusterize([]), []);
});

test('clusterize não altera a entrada e toApiItem leva o cluster', () => {
  const feed = [f('10'), f('11')];
  const c = Core.clusterize(feed);
  assert.equal(feed[0].cluster, undefined);
  assert.equal(Core.toApiItem(c[0]).cluster, 1);
  assert.equal('cluster' in Core.toApiItem(f('3')), false);
  assert.equal(Core.toApiItem({ ...c[1], known: true }).known, undefined); // known não vai para a API
});

test('toApiItem envia o nome de quem repostou', () => {
  assert.deepEqual(Core.toApiItem({ id: '1', author: 'a', reposter: 'b', reposterName: 'Bia Souza' }), { tweet_id: '1', author: 'a', reposter: 'b', reposter_name: 'Bia Souza', kind: 'repost' });
  assert.equal('reposter_name' in Core.toApiItem({ id: '1', author: 'a', reposter: 'b' }), false);
  assert.equal('reposter_name' in Core.toApiItem({ id: '1', author: 'a', reposterName: 'x' }), false);
});
