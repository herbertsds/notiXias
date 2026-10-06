"""Política de horários do robô (funções puras, testáveis).

Regras (decididas pelo dono):
- A cada X minutos, com X sorteado entre 30 e 45 a CADA execução, busca novas.
- Madrugada: depois de 01:00 roda UMA única vez e fica parado até 05:20; às 05:20 volta a buscar.

Leitura adotada da segunda regra: a execução "depois de 1h" é a primeira que cairia entre 01:00 e 05:20 pelo
sorteio normal; ela roda no horário sorteado e, a partir daí, o próximo horário é 05:20. Fuso: America/Sao_Paulo.
"""
import random
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Sao_Paulo")
MIN_MINUTES = 30
MAX_MINUTES = 45
NIGHT_START = time(1, 0)
NIGHT_END = time(5, 20)


def in_night(t: datetime) -> bool:
    lt = t.astimezone(TZ).time()
    return NIGHT_START <= lt < NIGHT_END


def night_bounds(t: datetime) -> tuple[datetime, datetime]:
    """Início (01:00) e fim (05:20) da madrugada do DIA de `t`, no fuso local."""
    lt = t.astimezone(TZ)
    return lt.replace(hour=1, minute=0, second=0, microsecond=0), lt.replace(hour=5, minute=20, second=0, microsecond=0)


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
