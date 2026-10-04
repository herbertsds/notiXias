def test_healthz_ok_sem_autenticacao(anon):
    r = anon.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
