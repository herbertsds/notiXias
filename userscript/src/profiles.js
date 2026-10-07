// profiles: verificação de UM perfil (aba Posts ou Respostas) na busca profunda. Lê só o que a própria conta publicou,
// do mais novo para o mais antigo, e para ao achar `olderStop` posts feitos ANTES da última verificação profunda.
// Nunca clica em nada: só rola e lê. Todo efeito colateral passa por `env` (testável com um perfil simulado).
const Profiles = (function () {
  const C = () => (typeof Core !== 'undefined' ? Core : require('./core.js'));
  const DEFAULTS = {
    olderStop: 5, // posts mais antigos que a fronteira para encerrar
    maxSteps: 150,
    stepFraction: 0.7,
    stepDelayMs: [800, 1500],
    settleMs: 800,
    settlePolls: 4,
    pollMs: 500,
  };

  // env: { readItems(), scrollToTop(), scrollBy(px), scrollHeight(), viewportHeight(), atBottom(), sleep(ms),
  //        rand(a,b), isCancelled(), onStep(steps)? }
  // Devolve { items, reason, steps, older }:
  //   items  = posts da conta com horário >= fronteira (sem reposts, sem fixado), do mais novo ao mais antigo;
  //   reason = 'older' (achou os posts antigos) | 'end' (fim da página) | 'max_steps' | 'cancelled'.
  // Posts de OUTRAS contas (a resposta mostra o post respondido acima, por exemplo) e reposts não contam nem entram:
  // o horário de um repost não está no ID, e quem reposta já aparece no Seguindo.
  async function scan(env, handle, boundaryMs, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const me = String(handle).toLowerCase();
    const seen = new Set();
    const items = [];
    let older = 0;
    let steps = 0;
    let stagnant = 0;
    env.scrollToTop();
    await env.sleep(o.settleMs);
    for (;;) {
      for (const it of env.readItems()) {
        if (seen.has(it.key)) continue;
        seen.add(it.key);
        if (it.author.toLowerCase() !== me || it.reposter || it.pinned) continue;
        const created = C().snowflakeMs(it.id);
        if (created !== null && created < boundaryMs) {
          older++;
          if (older >= o.olderStop) return { items, reason: 'older', steps, older };
        } else {
          items.push(it);
        }
      }
      if (env.isCancelled()) return { items, reason: 'cancelled', steps, older };
      if (steps >= o.maxSteps) return { items, reason: 'max_steps', steps, older };
      const before = env.scrollHeight();
      env.scrollBy(Math.round(env.viewportHeight() * o.stepFraction));
      await env.sleep(env.rand(o.stepDelayMs[0], o.stepDelayMs[1]));
      // o X desenha aos poucos (e carrega mais no fim da página): espera antes de contar como parado
      for (let p = 0; p < o.settlePolls; p++) {
        if (env.readItems().some((x) => !seen.has(x.key))) break;
        await env.sleep(o.pollMs);
      }
      steps++;
      if (env.onStep) env.onStep(steps);
      if (env.atBottom() && env.scrollHeight() === before) {
        if (++stagnant >= 3) return { items, reason: 'end', steps, older };
      } else {
        stagnant = 0;
      }
    }
  }

  return { scan };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Profiles;
