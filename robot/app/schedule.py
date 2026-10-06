"""Política de horários do robô (funções puras, testáveis).

Regras (decididas pelo dono):
- A cada X minutos, com X sorteado entre 10 e 25 a CADA execução, busca novas.
- Madrugada: depois de 01:00 roda UMA única vez e fica parado até 04:45; às 04:45 volta a buscar, e essa primeira
  busca do dia é PROFUNDA (varredura mais longa, para recuperar algo que tenha ficado para trás durante a pausa).

Leitura adotada da segunda regra: a execução "depois de 1h" é a primeira que cairia entre 01:00 e 04:45 pelo
sorteio normal; ela roda no horário sorteado e, a partir daí, o próximo horário é 04:45. Fuso: America/Sao_Paulo.
A execução é profunda quando é a primeira a partir das 04:45 ou a primeira a partir das 12:30 (`is_deep`).
"""
import random
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Sao_Paulo")
MIN_MINUTES = 10
MAX_MINUTES = 25
NIGHT_START = time(1, 0)
NIGHT_END = time(4, 45)
MIDDAY_DEEP = time(12, 30)  # primeira busca a partir desta hora também é profunda


def in_night(t: datetime) -> bool:
    lt = t.astimezone(TZ).time()
    return NIGHT_START <= lt < NIGHT_END


def night_bounds(t: datetime) -> tuple[datetime, datetime]:
    """Início (01:00) e fim (04:45) da madrugada do DIA de `t`, no fuso local."""
    lt = t.astimezone(TZ)
    return lt.replace(hour=1, minute=0, second=0, microsecond=0), lt.replace(hour=NIGHT_END.hour, minute=NIGHT_END.minute, second=0, microsecond=0)


def next_run(last_run: datetime | None, now: datetime, rng: random.Random | None = None) -> datetime:
    """Quando deve rodar a próxima busca. Datetimes com fuso. `last_run=None`: nunca rodou (roda já)."""
    rng = rng or random
    now = now.astimezone(TZ)
    if last_run is None:
        candidate = now
    else:
        last_run = last_run.astimezone(TZ)
        candidate = last_run + timedelta(minutes=rng.uniform(MIN_MINUTES, MAX_MINUTES))
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
    """Profunda = primeira busca a partir de 04:45 (fim da madrugada) ou de 12:30: a anterior foi antes dessa hora
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


def plan(last_run: datetime | None, now: datetime, rng: random.Random | None = None) -> tuple[datetime, bool]:
    """(quando, profunda?) da próxima busca. O sorteio dos 10–25 min acontece aqui, logo depois da busca anterior."""
    when = next_run(last_run, now, rng)
    return when, is_deep(last_run, when)
