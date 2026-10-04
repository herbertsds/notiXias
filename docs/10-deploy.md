# 10 — Deploy no servidor (Oracle)

Procedimento executado em 2026-10-04. Nada do outro projeto do servidor (`contagem_carboidratos_*`, `keycloak*`, `nginx_proxy_manager`, `portainer`) é tocado.

## O que roda

| Item | Valor |
|---|---|
| Pasta | `~/projetos/notixias` (clone de `git@github.com:herbertsds/notiXias.git`) |
| Compose | `docker-compose.prod.yml` (projeto `notixias`) |
| Containers | `notixias-mongo-1` (Mongo 7, autenticado, 1 GB), `notixias-api-1` (FastAPI, 512 MB) |
| Volume | `notixias_notixias_mongo_data` (exclusivo) |
| Redes | `notixias_notixias_net` (interna) e `infra_net` (a do Nginx Proxy Manager; a API entra com o alias `notixias-api`) |
| Portas no host | **nenhuma** publicada |
| Segredos | `.env` do servidor (permissão 600, fora do Git) e `.secrets/api_key.txt` (a chave em claro) |
| Backup | `scripts/backup.sh` + cron diário às 03:30; destino `~/backups/notixias`, retenção 14 |

## Subir / atualizar

```bash
cd ~/projetos/notixias
git pull
docker compose -f docker-compose.prod.yml up -d --build api     # só a API; o Mongo não reinicia
docker compose -f docker-compose.prod.yml ps
```

Verificação por dentro (a API não tem porta no host):

```bash
docker exec notixias-api-1 python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8000/healthz').read())"
```

## Expor na internet (passo manual, no Nginx Proxy Manager)

1. DNS: um subdomínio (A) apontando para o IP do servidor.
2. NPM → *Proxy Hosts* → *Add*: domínio = o subdomínio; *Forward Hostname* = `notixias-api`; porta `8000`; esquema `http`; *Block Common Exploits* ligado; aba SSL: *Request a new certificate*, *Force SSL*.
3. Opcional, no mesmo host: limitar tentativas (aba Advanced) para barrar quem tentar adivinhar a chave.
4. No userscript (menu ⋯ → Configurar API): URL `https://<subdomínio>` e a chave. No cabeçalho do script, `@connect <subdomínio>`.

## Endereço público

`https://notixias.163.176.176.10.nip.io` (nip.io resolve o IP embutido no nome; Nginx Proxy Manager com certificado Let's Encrypt, encaminhando para `notixias-api:8000`). Verificado de fora: sem chave 401, chave errada 401, chave certa 200. **Recomendado:** ligar *Force SSL* no proxy host (hoje `http://` também responde 200; o script usa `https://`).

O cabeçalho do userscript precisa listar o domínio em `@connect` (feito na 0.6.1); sem isso o Tampermonkey bloqueia/pede aprovação e o script mostra "Sem conexão com a API". Depois de atualizar o script, reabra o X.

## Estado inicial (2026-10-04)

Subido a partir do commit do GitHub; banco de produção = cópia do de desenvolvimento no ponto em que parou (32 entradas, 32 visualizações, cursor na entrada 32, último tweet `2106698041478484278`). Backup inicial em `~/backups/notixias/inicial-copia-do-dev.archive.gz`. Restauração do backup testada num banco temporário (contagens iguais).

## Chave da API

Gerada para a produção (diferente da de desenvolvimento). O servidor guarda só o hash em `API_KEY_HASH`. A chave em claro fica em `~/projetos/notixias/.secrets/api_key.txt` (600) e, se você a copiou para o Mac, em `.secrets/prod_api_key.txt` (ignorado pelo Git). Para trocar: `python3 scripts/gen_key.py`, atualize `API_KEY_HASH` no `.env` do servidor e `docker compose -f docker-compose.prod.yml up -d api`.

## Dados

O banco de produção foi inicializado com uma cópia do banco de desenvolvimento no ponto em que parou (`mongodump` → `mongorestore`). Daí em diante o de desenvolvimento e o de produção são independentes.

## Restaurar um backup

```bash
cd ~/projetos/notixias && set -a && . ./.env && set +a
docker compose -f docker-compose.prod.yml exec -T mongo mongorestore --archive --gzip --drop \
  -u "$MONGO_ROOT_USER" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin < ~/backups/notixias/<arquivo>.archive.gz
```

Teste a restauração ao menos uma vez num banco temporário antes de confiar no backup.
