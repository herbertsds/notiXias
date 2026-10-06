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
    '↻ @ana e @beto repostaram',
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
  assert.equal(Core.buildBannerText({ reposters: ['ana', 'beto'] }), '↻ @ana e @beto repostaram uma mensagem dessa thread');
  assert.equal(Core.buildBannerText({ reposters: [] }), null);
  assert.equal(Core.buildBannerText(null), null);
});

test('buildLabelParts: topo (repost, thread, lacuna) separado do "já visto"', () => {
  const fmt = () => '03/10/2026 às 21:14';
  const e = { reposters: ['ana'], view_count: 2, views: [{ viewed_at: 'x' }, { viewed_at: 'y' }], covered_count: 2, gap_before: true };
  assert.deepEqual(Core.buildLabelParts(e, fmt), {
    top: ['↻ @ana repostou', '⛓ inclui 2 posts desta thread', '⚠ pode haver posts não capturados antes deste'],
    seen: '👁 Visto em 03/10/2026 às 21:14 (2 vezes)',
  });
  assert.deepEqual(Core.buildLabelParts({ reposters: [], view_count: 0, views: [] }, fmt), { top: [], seen: null });
  assert.deepEqual(Core.buildLabelParts(null), { top: [], seen: null });
});

test('repost aparece também em entrada já vista: usa all_reposters (de outras entradas do mesmo tweet)', () => {
  const fmt = () => 'D';
  const lida = { reposters: [], all_reposters: ['ana'], view_count: 1, views: [{ viewed_at: 'x' }], covered_count: 0 };
  assert.deepEqual(Core.buildLabelParts(lida, fmt), { top: ['↻ @ana repostou'], seen: '👁 Visto em D' });
  assert.deepEqual(Core.buildBadges(lida, fmt)[0], '↻ @ana repostou');
  assert.equal(Core.buildBannerText(lida), '↻ @ana repostou uma mensagem dessa thread');
  // sem all_reposters (API antiga) cai para reposters da entrada
  assert.deepEqual(Core.buildLabelParts({ reposters: ['zeca'], view_count: 0, views: [] }).top, ['↻ @zeca repostou']);
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

test('parseLaunch: comando pela URL (atalho do iPhone) e limpeza do parâmetro', () => {
  assert.deepEqual(Core.parseLaunch('?nx=update'), { cmd: 'update', search: '' });
  assert.deepEqual(Core.parseLaunch('?nx=deep'), { cmd: 'deep', search: '' });
  assert.deepEqual(Core.parseLaunch('?nx=following'), { cmd: 'following', search: '' });
  assert.deepEqual(Core.parseLaunch('?nx=read'), { cmd: 'read', search: '' });
  assert.deepEqual(Core.parseLaunch('?a=1&nx=update&b=2'), { cmd: 'update', search: '?a=1&b=2' });   // preserva o resto
  assert.deepEqual(Core.parseLaunch('?nx=apagar-tudo'), { cmd: null, search: '' });                    // desconhecido: ignorado e removido
  assert.deepEqual(Core.parseLaunch(''), { cmd: null, search: '' });
  assert.deepEqual(Core.parseLaunch('?q=x'), { cmd: null, search: '?q=x' });
  assert.deepEqual(Core.parseLaunch(undefined), { cmd: null, search: '' });
});

test('texto do repost: "Fulano repostou" no singular, lista com "e" no plural', () => {
  const t = (reposters) => Core.buildLabelParts({ reposters }).top[0];
  assert.equal(t(['ana']), '↻ @ana repostou');
  assert.equal(t(['ana', 'beto']), '↻ @ana e @beto repostaram');
  assert.equal(t(['ana', 'beto', 'caio']), '↻ @ana, @beto e @caio repostaram');
  assert.equal(Core.buildBannerText({ reposters: ['ana', 'beto', 'caio'] }), '↻ @ana, @beto e @caio repostaram uma mensagem dessa thread');
});

test('formatRun: manual/automática, normal/profunda, horário e resultado', () => {
  const at = new Date(2026, 9, 6, 7, 58).toISOString();
  const ok = Core.formatRun({ at, source: 'robot', mode: 'deep', ok: true, created: 10, updated: 2, gap: false, reason: 'anchor', steps: 23 });
  assert.equal(ok.main, '06/10/2026 07:58 · Automática · Profunda');
  assert.equal(ok.sub, '10 novos · 2 com resposta nova · chegou ao que já estava salvo (23 passos)');
  assert.equal(ok.tone, 'ok');
  const man = Core.formatRun({ at, source: 'manual', mode: 'normal', ok: true, created: 1, updated: 0, gap: false });
  assert.equal(man.main, '06/10/2026 07:58 · Manual · Normal');
  assert.equal(man.sub, '1 novo');
  assert.equal(Core.formatRun({ at, source: 'manual', mode: 'normal', ok: true, created: 0, updated: 0 }).sub, 'nada novo');
  const gap = Core.formatRun({ at, source: 'manual', mode: 'normal', ok: true, created: 3, updated: 0, gap: true, reason: 'max_steps', steps: 150 });
  assert.equal(gap.tone, 'warn');
  assert.match(gap.sub, /⚠ pode haver lacuna · parou no limite de rolagem \(150 passos\)/);
  const bad = Core.formatRun({ at, source: 'robot', mode: 'normal', ok: false, error: 'sessão expirada' });
  assert.equal(bad.tone, 'error');
  assert.equal(bad.sub, '⚠ Falhou: sessão expirada');
});

test('formatNext: próxima automática com tipo e tempo restante; pausa e espera de sessão', () => {
  const now = new Date(2026, 9, 6, 8, 0);
  const at = new Date(2026, 9, 6, 8, 38).toISOString();
  const n = Core.formatNext({ at, mode: 'deep', state: 'scheduled' }, now);
  assert.equal(n.main, 'Próxima automática: 06/10/2026 08:38 · Profunda');
  assert.equal(n.sub, 'em 38 min');
  assert.equal(n.tone, 'next');
  assert.equal(Core.formatNext({ at: new Date(2026, 9, 6, 12, 5).toISOString(), mode: 'normal', state: 'scheduled' }, now).sub, 'em 4 h 05 min');
  const late = Core.formatNext({ at: new Date(2026, 9, 6, 7, 0).toISOString(), mode: 'normal', state: 'scheduled' }, now);
  assert.equal(late.tone, 'warn');
  assert.match(late.sub, /atrasada 60 min/);
  assert.equal(Core.formatNext({ state: 'paused', at: null }, now).tone, 'error');
  assert.match(Core.formatNext({ state: 'waiting_session', at: null }, now).main, /aguardando a sessão/);
  assert.equal(Core.formatNext(null, now), null);
});

test('ageLabel: só min ou h, nunca dias', () => {
  const idAt = (ms) => String(BigInt(ms - 1288834974657) << 22n);
  const now = Date.UTC(2026, 9, 6, 12, 0);
  assert.equal(Core.ageLabel(idAt(now - 20 * 1000), now), '1 min');
  assert.equal(Core.ageLabel(idAt(now - 35 * 60000), now), '35 min');
  assert.equal(Core.ageLabel(idAt(now - 60 * 60000), now), '1 h');
  assert.equal(Core.ageLabel(idAt(now - 119 * 60000), now), '1 h');
  assert.equal(Core.ageLabel(idAt(now - 35 * 3600000), now), '35 h');
  assert.equal(Core.ageLabel(idAt(now - 90 * 24 * 3600000), now), '2160 h');
  assert.equal(Core.ageLabel('abc', now), '');
});

test('velocidades do vídeo: de 0,1x a 3x, rótulo com vírgula', () => {
  assert.deepEqual(Core.SPEEDS, [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 2.75, 3]);
  assert.equal(Core.SPEEDS[0], 0.1);
  assert.equal(Core.SPEEDS[Core.SPEEDS.length - 1], 3);
  assert.equal(Core.formatSpeed(0.1), '0,1x');
  assert.equal(Core.formatSpeed(0.25), '0,25x');
  assert.equal(Core.formatSpeed(1), '1x');
  assert.equal(Core.formatSpeed(1.75), '1,75x');
  assert.equal(Core.formatSpeed(2.75), '2,75x');
  assert.equal(Core.formatSpeed(3), '3x');
});
