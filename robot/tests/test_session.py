import pytest

from app.session import session_state


def test_estado_de_sessao_com_os_dois_cookies():
    st = session_state("a" * 40, " " + "b" * 40 + " ")
    c = {x["name"]: x for x in st["cookies"]}
    assert c["auth_token"]["httpOnly"] is True and c["auth_token"]["sameSite"] == "None"
    assert c["ct0"]["httpOnly"] is False and c["ct0"]["value"] == "b" * 40            # espaços das pontas saem
    assert all(x["domain"] == ".x.com" and x["secure"] for x in st["cookies"]) and st["origins"] == []


@pytest.mark.parametrize("auth,ct0", [("curto", "b" * 40), ("a" * 40, ""), ("a" * 20 + " " + "a" * 20, "b" * 40)])
def test_cookies_incompletos_sao_recusados(auth, ct0):
    with pytest.raises(ValueError):
        session_state(auth, ct0)
