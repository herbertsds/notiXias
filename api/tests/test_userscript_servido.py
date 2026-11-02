def test_script_servido_com_etag_e_304(client, anon, tmp_path, monkeypatch):
    f = tmp_path / "notixias.user.js"
    f.write_text("// ==UserScript==\n// @version      9.9.9\n// ==/UserScript==\nconsole.log(1);", encoding="utf-8")
    monkeypatch.setenv("USERSCRIPT_PATH", str(f))
    r = client.get("/api/v1/userscript")
    assert r.status_code == 200 and "console.log(1)" in r.text
    assert r.headers["x-nx-version"] == "9.9.9" and r.headers["content-type"].startswith("application/javascript")
    etag = r.headers["etag"]
    again = client.get("/api/v1/userscript", headers={"If-None-Match": etag})
    assert again.status_code == 304 and again.content == b""
    f.write_text(f.read_text() + "//novo", encoding="utf-8")
    novo = client.get("/api/v1/userscript", headers={"If-None-Match": etag})
    assert novo.status_code == 200 and novo.headers["etag"] != etag


def test_script_exige_a_chave_e_da_404_sem_arquivo(client, anon, tmp_path, monkeypatch):
    monkeypatch.setenv("USERSCRIPT_PATH", str(tmp_path / "nao-existe.js"))
    assert client.get("/api/v1/userscript").status_code == 404
    assert anon.get("/api/v1/userscript").status_code == 401
