"""Política de horários do robô (funções puras, testáveis).

Regras (decididas pelo dono):
- A cada X minutos, com X sorteado a CADA execução, busca novas. A faixa de X depende de quantas mensagens ainda não foram
  lidas (a API calcula): menos de 50 -> 10 a 25 min; de 50 a 99 -> 30 a 45; 100 ou mais -> 45 a 60.
- Madrugada: depois de 01:00 roda UMA única vez e fica parado até 05:10; às 05:10 volta a buscar, e essa primeira
  busca do dia é PROFUNDA (varredura mais longa, para recuperar algo que tenha ficado para trás durante a pausa).

Leitura adotada da segunda regra: a execução "depois de 1h" é a primeira que cairia entre 01:00 e 05:10 pelo
sorteio normal; ela roda no horário sorteado e, a partir daí, o próximo horário é 05:10. Fuso: America/Sao_Paulo.
A busca profunda DO FEED é a primeira a partir das 05:10 ou a primeira a partir das 12:30 (`is_deep`).
A verificação dos PERFIS (profunda dos perfis) é diária, num horário sorteado entre 03:00 e 03:30 (`next_profiles`); roda dentro
da parada da madrugada sem contar como a "única" busca dela.
"""
import random
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Sao_Paulo")
MIN_MINUTES = 10
MAX_MINUTES = 25
NIGHT_START = time(1, 0)
NIGHT_END = time(5, 10)
MIDDAY_DEEP = time(12, 30)  # primeira busca a partir desta hora também é profunda


def in_night(t: datetime) -> bool:
    lt = t.astimezone(TZ).time()
    return NIGHT_START <= lt < NIGHT_END


def night_bounds(t: datetime) -> tuple[datetime, datetime]:
    """Início (01:00) e fim (05:10) da madrugada do DIA de `t`, no fuso local."""
    lt = t.astimezone(TZ)
    return lt.replace(hour=1, minute=0, second=0, microsecond=0), lt.replace(hour=NIGHT_END.hour, minute=NIGHT_END.minute, second=0, microsecond=0)


def next_run(
    last_run: datetime | None, now: datetime, rng: random.Random | None = None, interval: tuple[float, float] | None = None
) -> datetime:
    """Quando deve rodar a próxima busca. Datetimes com fuso. `last_run=None`: nunca rodou (roda já).
    `interval` = (mínimo, máximo) em minutos; sem ele, a faixa padrão (10 a 25)."""
    rng = rng or random
    lo, hi = interval or (MIN_MINUTES, MAX_MINUTES)
    now = now.astimezone(TZ)
    if last_run is None:
        candidate = now
    else:
        last_run = last_run.astimezone(TZ)
        candidate = last_run + timedelta(minutes=rng.uniform(lo, hi))
        if candidate < now:  # ficou parado (reinício, falha): não tenta "recuperar" horários perdidos
            candidate = now
    if in_night(candidate):
        start, end = night_bounds(candidate)
        already = last_run is not None and start <= last_run < end
        if already:
            return end
    return candidate


DEEP_FROM = (NIGHT_END, MIDDAY_DEEP)


def is_deep(last_run: datetime | None, when: datetime) -> bool:
    """Profunda = primeira busca a partir de 05:10 (fim da madrugada) ou de 12:30: a anterior foi antes dessa hora
    e esta é nela ou depois."""
    if last_run is None:
        return False
    when = when.astimezone(TZ)
    last = last_run.astimezone(TZ)
    for t in DEEP_FROM:
        boundary = when.replace(hour=t.hour, minute=t.minute, second=0, microsecond=0)
        if last < boundary <= when:
            return True
    return False


def plan(
    last_run: datetime | None, now: datetime, rng: random.Random | None = None, interval: tuple[float, float] | None = None
) -> tuple[datetime, bool]:
    """(quando, profunda?) da próxima busca. O sorteio do intervalo acontece aqui, logo depois da busca anterior."""
    when = next_run(last_run, now, rng, interval)
    return when, is_deep(last_run, when)


def allowed(last_run: datetime | None, when: datetime) -> bool:
    """Um horário vindo de fora (a API antecipou a busca) respeita a parada da madrugada? Não vale cair em 01:00-05:10
    se a busca única da madrugada já aconteceu."""
    if not in_night(when):
        return True
    start, end = night_bounds(when)
    return not (last_run is not None and start <= last_run.astimezone(TZ) < end)


# ---- verificação dos perfis: uma vez por dia, entre 03:00 e 03:30 ----
PROFILES_FROM = time(3, 0)
PROFILES_TO = time(3, 30)


def _window(day) -> tuple[datetime, datetime]:
    return (datetime.combine(day, PROFILES_FROM, TZ), datetime.combine(day, PROFILES_TO, TZ))


def next_profiles(
    last_done: datetime | None, now: datetime, rng: random.Random | None = None, current: datetime | None = None
) -> datetime:
    """Horário da próxima verificação de perfis. Um horário por dia, sorteado uma vez e mantido (`current`).
    Se hoje já foi feita, ou a janela de hoje já passou (robô parado), fica para amanhã: não "recupera" fora de hora."""
    rng = rng or random
    now = now.astimezone(TZ)
    day = now.date()
    start, end = _window(day)
    done_today = last_done is not None and last_done.astimezone(TZ).date() == day
    if done_today or now > end:
        day = day + timedelta(days=1)
        start, end = _window(day)
    if current is not None and current.astimezone(TZ).date() == day and start <= current.astimezone(TZ) <= end:
        return current.astimezone(TZ)
    lo = max(start, now)  # se já estamos dentro da janela de hoje, sorteia só o que ainda vem pela frente
    return lo + timedelta(seconds=rng.uniform(0, max(0.0, (end - lo).total_seconds())))
