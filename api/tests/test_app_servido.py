import json


def _publica(tmp_path, monkeypatch, code=7):
    (tmp_path / "notixias.apk").write_bytes(b"APK-DE-TESTE")
    (tmp_path / "notixias.json").write_text(json.dumps({"versionCode": code, "versionName": "1.2.3"}))
    monkeypatch.setenv("APP_DIST_PATH", str(tmp_path))


def test_versao_e_apk_servidos(client, tmp_path, monkeypatch):
    _publica(tmp_path, monkeypatch)
    v = client.get("/api/v1/app/version")
    assert v.status_code == 200
    j = v.json()
    assert j["versionCode"] == 7 and j["versionName"] == "1.2.3" and j["size"] == len(b"APK-DE-TESTE")
    assert len(j["sha256"]) == 64
    a = client.get("/api/v1/app/apk")
    assert a.status_code == 200 and a.content == b"APK-DE-TESTE"
    assert a.headers["content-type"].startswith("application/vnd.android.package-archive")


def test_sem_app_publicado_da_404(client, tmp_path, monkeypatch):
    monkeypatch.setenv("APP_DIST_PATH", str(tmp_path / "vazio"))
    assert client.get("/api/v1/app/version").status_code == 404
    assert client.get("/api/v1/app/apk").status_code == 404


def test_app_exige_chave(anon, tmp_path, monkeypatch):
    _publica(tmp_path, monkeypatch)
    assert anon.get("/api/v1/app/version").status_code == 401
    assert anon.get("/api/v1/app/apk").status_code == 401
