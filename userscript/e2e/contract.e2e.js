const assert = require('node:assert/strict');
const Api = require('../src/api.js');
const Core = require('../src/core.js');
const KEY = 'e2e-key-0123456789';
const api = Api.create({
  getConfig: () => ({ apiBaseUrl: 'http://nx-e2e-api:8000', apiKey: KEY }),
  request: async ({ method, url, headers, body }) => {
    const r = await fetch(url, { method, headers, body });
    let json = null; try { json = await r.json(); } catch (e) {}
    return { status: r.status, json };
  },
});
const feedItem = (id, author, reposter) => ({ id: String(id), author, reposter: reposter || null });
(async () => {
  let st = await api.state();
  assert.equal(st.cursor_seq, null);
  // 1ª busca: fila vazia, feed (mais novo primeiro)
  const feed1 = [feedItem(50, 'a'), feedItem(40, 'b', 'ana'), feedItem(30, 'a'), feedItem(20, 'c')];
  let r = await api.append({ items: feed1.map(Core.toApiItem), anchor_found: false, batch_id: Core.newBatchId() });
  assert.equal(r.created, 4);
  // fluxo de leitura como no main.js
  st = await api.state();
  let q = await api.queue({ after: st.cursor_seq || 0, limit: 1 });
  assert.equal(q.items[0].tweet_id, '20');                       // o mais antigo primeiro
  await api.putState({ cursor_seq: q.items[0].seq });
  st = await api.state();
  assert.equal(st.current.tweet_id, '20'); assert.equal(st.position, 1); assert.equal(st.unread_after, 3);
  await api.views({ seqs: [st.current.seq] });
  q = await api.queue({ after: st.current.seq, limit: 1 });
  assert.equal(q.items[0].tweet_id, '30');
  await api.putState({ cursor_seq: q.items[0].seq });
  // thread: página do 30 mostra o 50 (mesmo autor 'a') -> cobre
  const dest = (await api.queue({ after: 0, limit: 10 })).items.find((e) => e.tweet_id === '50');
  const cov = await api.cover({ covered_by: dest.seq, tweet_ids: ['30', '50', '999'] });
  assert.equal(cov.covered, 1);
  // âncora e 2ª busca: reencontra a âncora, repost de lido vira nova entrada
  const anc = await api.anchor(10);
  assert.ok(anc.keys.includes('50|') && anc.keys.includes('40|ana'));
  r = await api.append({ items: [feedItem(60, 'd'), feedItem(20, 'c', 'zeca')].map(Core.toApiItem), anchor_found: true, batch_id: Core.newBatchId() });
  assert.equal(r.created, 2); assert.equal(r.gap, false);
  const repost = (await api.queue({ after: 0, limit: 10 })).items.find((e) => e.tweet_id === '20' && e.reposters.length);
  const det = await api.entry(repost.seq);
  assert.equal(det.view_count, 1);                                // "já visto" do repost
  assert.match(Core.buildBadges(det).join(' | '), /repostado por @zeca.*já visto em \d\d\/\d\d\/\d{4} às \d\d:\d\d/);
  // 401 vira ApiError
  const bad = Api.create({ getConfig: () => ({ apiBaseUrl: 'http://nx-e2e-api:8000', apiKey: 'errada' }), request: async ({ method, url, headers }) => { const r = await fetch(url, { method, headers }); return { status: r.status, json: await r.json() }; } });
  await assert.rejects(bad.state(), (e) => e.status === 401);
  const ex = await api.exportAll();
  assert.equal(ex.entries.length, 6);
  console.log('E2E OK: contrato cliente JS <-> API validado');
})().catch((e) => { console.error('E2E FALHOU:', e); process.exit(1); });
