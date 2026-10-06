// core: funções puras (sem DOM, sem rede). Testáveis em Node.
const Core = (function () {
  const STATUS_RE = /^\/([^/]+)\/status\/(\d+)$/;
  const PROFILE_RE = /^\/([A-Za-z0-9_]{1,15})$/;
  const RESERVED = new Set([
    'home', 'explore', 'notifications', 'messages', 'search', 'settings',
    'compose', 'i', 'login', 'signup', 'tos', 'privacy',
  ]);
  const HOST_RE = /(^|\.)(x|twitter)\.com$/i;

  function toUrl(href, origin) {
    try {
      return new URL(href, origin);
    } catch (e) {
      return null;
    }
  }

  // "/usuario/status/123" -> { author, id }. Qualquer sufixo (ex.: /photo/1) não casa.
  function parseStatusPath(pathname) {
    const m = STATUS_RE.exec(pathname || '');
    return m ? { author: m[1], id: m[2] } : null;
  }

  function parseStatusHref(href, origin) {
    const u = toUrl(href, origin);
    if (!u || !HOST_RE.test(u.hostname)) return null;
    return parseStatusPath(u.pathname);
  }

  // "/fulano" -> "fulano" (perfil). Rotas reservadas do X não são perfis.
  function parseProfileHref(href, origin) {
    const u = toUrl(href, origin);
    if (!u || !HOST_RE.test(u.hostname)) return null;
    const m = PROFILE_RE.exec(u.pathname.replace(/\/+$/, ''));
    if (!m || RESERVED.has(m[1].toLowerCase())) return null;
    return m[1];
  }

  function appearanceKey(id, reposter) {
    return id + '|' + (reposter || '').toLowerCase();
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  // dd/mm/aaaa às hh:mm, no fuso do aparelho.
  function formatDateBR(input) {
    const d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) return '';
    return (
      pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() +
      ' às ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    );
  }

  // Idade do post a partir do ID (snowflake: ms desde 2010-11-04 nos 42 bits altos). Sempre "N min" ou "N h", nunca dias.
  function ageLabel(id, nowMs) {
    let created;
    try { created = Number(BigInt(id) >> 22n) + 1288834974657; } catch (e) { return ''; }
    const mins = Math.max(1, Math.floor(((nowMs === undefined ? Date.now() : nowMs) - created) / 60000));
    return mins < 60 ? mins + ' min' : Math.floor(mins / 60) + ' h';
  }

  // Velocidades do vídeo (o X no celular não tem controle). Cada toque passa para a próxima, voltando a 1x.
  const SPEEDS = [1, 1.25, 1.5, 2, 0.75];
  function nextSpeed(cur) {
    const i = SPEEDS.indexOf(cur);
    return SPEEDS[(i + 1) % SPEEDS.length];
  }
  const formatSpeed = (r) => r + 'x';

  // ---- histórico de execuções (menu ⋯ -> Execuções) ----
  const STOP_REASON = {
    anchor: 'chegou ao que já estava salvo',
    backfill: 'primeira carga',
    max_steps: 'parou no limite de rolagem',
    max_collect: 'parou no limite de posts',
    end: 'chegou ao fim do feed',
    gap_unresolved: 'ficou lacuna "Mostrar mais" sem abrir',
  };

  // Uma execução da API ({at, source, mode, ok, created, updated, gap, reason, steps, error}) em duas linhas de texto.
  // Devolve { main, sub, tone } com tone = 'ok' | 'warn' | 'error'.
  function formatRun(run) {
    const d = new Date(run.at);
    const when = isNaN(d.getTime()) ? '?' : pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    const main = when + ' · ' + (run.source === 'robot' ? 'Automática' : 'Manual') + ' · ' + (run.mode === 'deep' ? 'Profunda' : 'Normal');
    if (!run.ok) return { main, sub: '⚠ Falhou: ' + (run.error || 'erro desconhecido'), tone: 'error' };
    const parts = [];
    if (run.created) parts.push(run.created + (run.created === 1 ? ' novo' : ' novos'));
    if (run.updated) parts.push(run.updated + ' com resposta nova');
    if (!parts.length) parts.push('nada novo');
    if (run.gap) parts.push('⚠ pode haver lacuna');
    const why = STOP_REASON[run.reason];
    if (why) parts.push(why + (run.steps ? ' (' + run.steps + ' passos)' : ''));
    return { main, sub: parts.join(' · '), tone: run.gap ? 'warn' : 'ok' };
  }

  // Linha "próxima execução automática" no topo do histórico. `next` vem de GET /runs ({at, mode, state} ou null).
  function formatNext(next, now) {
    if (!next) return null;
    if (next.state === 'paused') return { main: 'Robô pausado', sub: 'Falhas seguidas ou sessão do X expirada: envie uma sessão nova ou reinicie o contêiner (docs/11-robo.md).', tone: 'error' };
    if (next.state === 'waiting_session') return { main: 'Robô aguardando a sessão do X', sub: 'Rode scripts/robot_login.sh e scripts/robot_install_session.sh no computador.', tone: 'warn' };
    const d = new Date(next.at);
    if (isNaN(d.getTime())) return null;
    const when = pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    const mins = Math.round((d.getTime() - (now || new Date()).getTime()) / 60000);
    const rel = mins >= 60 ? 'em ' + Math.floor(mins / 60) + ' h ' + pad(mins % 60) + ' min' : mins >= 1 ? 'em ' + mins + ' min' : mins > -10 ? 'agora' : 'atrasada ' + Math.abs(mins) + ' min: confira o robô';
    return {
      main: 'Próxima automática: ' + when + ' · ' + (next.mode === 'deep' ? 'Profunda' : 'Normal'),
      sub: rel,
      tone: mins <= -10 ? 'warn' : 'next',
    };
  }

  // Thread: depois do post focal, posts do MESMO autor em sequência contígua, com IDs crescentes.
  // `items` = posts da página, em ordem de DOM: [{id, author}].
  // Devolve { target, chain } (target = último da cadeia) ou null.
  function pickThreadTarget(items, focalId, focalAuthor) {
    const idx = items.findIndex((i) => i.id === focalId);
    if (idx < 0) return null;
    const author = (focalAuthor || items[idx].author).toLowerCase();
    const chain = [];
    let prev = BigInt(focalId);
    for (let j = idx + 1; j < items.length; j++) {
      const it = items[j];
      if (it.author.toLowerCase() !== author) break;
      const cur = BigInt(it.id);
      if (cur <= prev) break;
      chain.push(it);
      prev = cur;
    }
    if (!chain.length) return null;
    return { target: chain[chain.length - 1], chain };
  }

  // "@ana repostou" / "@ana e @beto repostaram" / "@ana, @beto e @caio repostaram". O @ vira o nome de exibição na tela.
  function repostPhrase(reps) {
    const h = reps.map((r) => '@' + r);
    const who = h.length === 1 ? h[0] : h.slice(0, -1).join(', ') + ' e ' + h[h.length - 1];
    return who + (h.length === 1 ? ' repostou' : ' repostaram');
  }

  // Quem repostou o tweet em qualquer entrada (lida ou não); cai para os reposters da própria entrada.
  function repostersOf(entry) {
    if (!entry) return [];
    if (entry.all_reposters && entry.all_reposters.length) return entry.all_reposters;
    return entry.reposters || [];
  }

  // Separa a conversa da página em: posts ACIMA do focal (cadeia de ancestrais, de qualquer autor) e abaixo.
  // `items` = [{id, author}] em ordem de DOM; `focalId` = ID do post da URL.
  function splitConversation(items, focalId) {
    const idx = items.findIndex((i) => i.id === focalId);
    if (idx < 0) return { before: [], after: [] };
    return { before: items.slice(0, idx), after: items.slice(idx + 1) };
  }

  // Etiquetas exibidas na barra para uma entrada (formato da API).
  function buildBadges(entry, fmt) {
    const f = fmt || formatDateBR;
    const out = [];
    if (!entry) return out;
    const reps = repostersOf(entry);
    if (reps.length) {
      out.push('↻ ' + repostPhrase(reps));
    }
    if (entry.view_count > 0 && entry.views && entry.views.length) {
      let t = '👁 Visto em ' + f(entry.views[0].viewed_at);
      if (entry.view_count > 1) t += ' (' + entry.view_count + ' vezes)';
      out.push(t);
    }
    if (entry.covered_count > 0) {
      out.push('⛓ inclui ' + entry.covered_count + (entry.covered_count === 1 ? ' post' : ' posts') + ' desta thread');
    }
    if (entry.gap_before) out.push('⚠ pode haver posts não capturados antes deste');
    return out;
  }

  // Divide as etiquetas: `top` fica acima do post; `seen` ("já visto") vai logo abaixo da data do post.
  function buildLabelParts(entry, fmt) {
    const f = fmt || formatDateBR;
    const parts = { top: [], seen: null };
    if (!entry) return parts;
    const reps = repostersOf(entry);
    if (reps.length) {
      parts.top.push('↻ ' + repostPhrase(reps));
    }
    if (entry.covered_count > 0) {
      parts.top.push('⛓ inclui ' + entry.covered_count + (entry.covered_count === 1 ? ' post' : ' posts') + ' desta thread');
    }
    if (entry.gap_before) parts.top.push('⚠ pode haver posts não capturados antes deste');
    if (entry.view_count > 0 && entry.views && entry.views.length) {
      parts.seen = '👁 Visto em ' + f(entry.views[0].viewed_at) + (entry.view_count > 1 ? ' (' + entry.view_count + ' vezes)' : '');
    }
    return parts;
  }

  // Aviso no topo da página, quando o post repostado não é o primeiro da tela.
  function buildBannerText(entry) {
    const reps = repostersOf(entry);
    if (!reps.length) return null;
    return '↻ ' + repostPhrase(reps) + ' uma mensagem dessa thread';
  }

  // Comando de abertura pela URL (atalho do iPhone, favorito...): `https://x.com/home?nx=update`.
  //   update    -> busca novas;  deep -> busca com varredura profunda;
  //   following -> lê as contas seguidas;  read -> continua a leitura.
  // Devolve o comando (ou null, se ausente/desconhecido) e a query SEM o parâmetro, para limpar a barra de endereço
  // (recarregar a página não repete a ação).
  const LAUNCH_CMDS = ['update', 'deep', 'following', 'read'];
  function parseLaunch(search) {
    const p = new URLSearchParams(search || '');
    const raw = p.get('nx');
    if (raw === null) return { cmd: null, search: search || '' };
    p.delete('nx');
    const rest = p.toString();
    return { cmd: LAUNCH_CMDS.includes(raw) ? raw : null, search: rest ? '?' + rest : '' };
  }

  function normPath(p) {
    return (p || '').replace(/\/+$/, '') || '/';
  }

  function isFeedPath(feedUrl, pathname) {
    const u = toUrl(feedUrl, 'https://x.com');
    return !!u && normPath(u.pathname) === normPath(pathname);
  }

  // Conversas no feed: o X mostra raiz e respostas em sequência, com IDs CRESCENTES de cima para baixo (o
  // contrário do normal, que é do mais novo ao mais antigo). Uma corrida de posts consecutivos, sem reposts,
  // com ID crescente é uma conversa. Devolve cópias com `cluster` (1, 2, ...) nos itens que a formam.
  function clusterize(items) {
    const out = items.map((i) => Object.assign({}, i));
    let n = 0;
    let i = 0;
    while (i < out.length) {
      let j = i;
      if (!out[i].reposter) {
        while (j + 1 < out.length && !out[j + 1].reposter && BigInt(out[j + 1].id) > BigInt(out[j].id)) j++;
      }
      if (j > i) {
        n++;
        for (let k = i; k <= j; k++) out[k].cluster = n;
      }
      i = j + 1;
    }
    return out;
  }

  function toApiItem(item) {
    const o = {
      tweet_id: item.id,
      author: item.author,
      reposter: item.reposter || null,
      kind: item.reposter ? 'repost' : 'post',
    };
    if (item.reposter && item.reposterName) o.reposter_name = item.reposterName;
    if (item.cluster) o.cluster = item.cluster;
    return o;
  }

  function newBatchId() {
    return 'b-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  return {
    parseStatusPath, parseStatusHref, parseProfileHref, appearanceKey, formatDateBR, formatRun, formatNext, ageLabel, nextSpeed, formatSpeed,
    pickThreadTarget, splitConversation, clusterize, parseLaunch, buildBadges, buildLabelParts, buildBannerText, isFeedPath, toApiItem, newBatchId,
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Core;
