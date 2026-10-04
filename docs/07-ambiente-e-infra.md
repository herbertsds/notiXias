# 07 — Ambiente e infraestrutura

## Princípios

- Tudo em **containers** (Docker + Compose), local primeiro.
- Backend **Python + FastAPI**; banco **MongoDB**, em container **próprio** e isolado.
- O mesmo `docker-compose` sobe no Mac e no servidor, com pequenas diferenças via variáveis e um arquivo de override.
- Imagens **multi-arquitetura** (o servidor é ARM/aarch64; o Mac provavelmente também).

## Ambiente local (Mac)

### Serviços do `docker-compose.yml`

| Serviço | Imagem/base | Função |
|---|---|---|
| `api` | `python:3.12-slim` (build local) | FastAPI via Uvicorn |
| `mongo` | `mongo:7` | Banco do notiXias |

### Diretrizes

- **Portas locais publicadas somente em `127.0.0.1`** (ex.: `127.0.0.1:8000:8000`); Mongo não publicado (acesso por `docker compose exec` quando necessário).
- Volume nomeado para os dados do Mongo (`notixias_mongo_data`).
- Limite de cache do Mongo para conter memória (ex.: `--wiredTigerCacheSizeGB 0.25`).
- `healthcheck` no Mongo e na API; `api` depende de `mongo` saudável.
- Variáveis em `.env` (não versionado): `MONGO_URL` interno, `MONGO_DB`, `API_KEY_HASH`, `ENV=dev|prod`.
- Hot reload da API só no ambiente de desenvolvimento (volume do código + `--reload`).
- Docs da API (`/docs`) ligados em `dev`, desligados em `prod`.
- Usuário não-root dentro do container da API.
- Rede própria do compose (`notixias_net`).

### Variáveis de ambiente (planejadas)

| Variável | Exemplo | Observação |
|---|---|---|
| `ENV` | `dev` | `prod` desliga `/docs` |
| `MONGO_URL` | `mongodb://mongo:27017` | Autenticação do Mongo em produção (ver abaixo) |
| `MONGO_DB` | `notixias` | |
| `API_KEY_HASH` | `sha256:...` | Hash da chave; nunca a chave em claro |
| `LOG_LEVEL` | `info` | |

### Testes

- `pytest` rodando dentro do container (ou serviço `api-test` no compose).
- Mongo de teste efêmero (banco/volume separado ou container descartável); testes nunca tocam o banco de uso.

## Servidor (Oracle Cloud) — perfil observado

Levantado por leitura via SSH (nada alterado):

| Item | Valor |
|---|---|
| Sistema | Ubuntu 24.04 LTS |
| Arquitetura | aarch64 (ARM), 2 vCPUs |
| Memória | ~11 GB (≈ 9,7 GB disponíveis), sem swap |
| Disco | 45 GB (≈ 33 GB livres) |
| Docker | 29.x, Compose v5.x |
| Python do host | 3.12.3 (não será usado; tudo em container) |
| Firewall do host | portas 22, 80, 443 abertas; 81, 8000, 9443 restritas a um IP |
| Acesso | SSH com chave já existente na máquina do dono (alias `OracleCloud` no `~/.ssh/config`) |

### Já em execução (NÃO TOCAR)

`nginx_proxy_manager` (80/443/81), `portainer`, `keycloak` + `keycloak_db` (Postgres), `contagem_carboidratos_*` (backend Python, dev Node, **Mongo 7 próprio**).

O notiXias usa **Mongo, volumes, redes e arquivos separados** dos acima.

### Plano de deploy (somente depois de testado localmente)

Decisões deliberadamente adiadas até lá:

1. Subdomínio (ex.: algo como `noticias.<domínio>`) apontando para o IP do servidor.
2. Cadastro de um *proxy host* no Nginx Proxy Manager para a API, com certificado.
3. Conexão do container da API à rede do NPM (descobrir o nome por leitura quando chegar a hora), **sem publicar portas no host**.
4. Mongo apenas na rede interna do notiXias, com autenticação habilitada.
5. Diretório do projeto em `~/projetos/notixias` no servidor, com `.env` real (permissão 600).
6. Backup diário agendado e cópia externa.
7. Limite de tentativas no proxy.

Procedimento geral de atualização: `git pull` (ou cópia dos arquivos) → `docker compose build api` → `docker compose up -d api`. Sem derrubar o Mongo.

### Arquitetura de imagens

- `python:3.12-slim` e `mongo:7` têm variantes ARM64 e x86-64.
- Build da API sem dependências com compilação nativa pesada, preferindo wheels disponíveis para ARM.
- Se construir no Mac ARM e rodar no servidor ARM, as imagens coincidem; se um dia mudar para x86, usar `docker buildx` multi-plataforma.

## Backup do Mongo

- Script em `scripts/backup.sh`: `mongodump` do banco `notixias` com compressão (`--archive --gzip`) para um diretório de backups com data.
- Retenção: 14 diários e 8 semanais.
- Agendamento por cron do host no servidor (ou container de backup).
- Cópia fora do servidor (destino a definir pelo dono).
- Restauração documentada e **testada** antes de confiar: `mongorestore --archive --gzip --drop` num banco temporário.

## Observabilidade mínima

- Logs da API em stdout (estruturados, sem chave nem conteúdo sensível), lidos com `docker compose logs`.
- `/healthz` para o healthcheck.
- Sem stack de monitoramento no início.
