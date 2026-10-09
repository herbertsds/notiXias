"""Política do robô que depende de quantas mensagens ainda não foram lidas (funções puras)."""

# Intervalo entre buscas normais (minutos), conforme o total de não lidas:
#   100 ou mais -> 45 a 60 | de 50 a 99 -> 30 a 45 | menos de 50 -> 10 a 25
# (os valores exatos 100 e 50 caem na faixa de cima: o pedido dizia "mais de"/"menos de" sem tratar a igualdade.)
TIERS = (
    (100, "high", 45, 60),
    (50, "mid", 30, 45),
    (0, "low", 10, 25),
)

# Ao ler uma mensagem e a contagem passar de N para N-1 nestes limiares, pede-se uma busca nova ao robô agora.
THRESHOLDS = (30, 15, 6)


def tier_for(unread: int) -> dict:
    for floor, name, lo, hi in TIERS:
        if unread >= floor:
            return {"tier": name, "min_minutes": lo, "max_minutes": hi}
    return {"tier": "low", "min_minutes": 10, "max_minutes": 25}


def crossed_thresholds(old: int, new: int) -> list[int]:
    """Limiares atravessados para BAIXO: havia N ou mais e agora há menos de N."""
    return [t for t in THRESHOLDS if old >= t and new < t]
