# notiXias

Leitor pessoal e sequencial da timeline do X (antigo Twitter), pensado como um portal de notícias e não como uma rede social.

**Uso:** exclusivamente pessoal, com a conta do próprio dono, sem fins lucrativos, sem republicar conteúdo.

## O problema

O app do X perde a posição de leitura: ao fechar e reabrir, mostra o post mais recente. O objetivo é ler os posts de quem sigo **na ordem em que foram publicados, do ponto exato onde parei**, e só buscar novidades quando eu pedir.

## A solução em uma frase

Um **userscript** no navegador (que roda dentro do x.com, na sessão logada do dono) captura os links dos posts e navega de um em um; uma **API própria** (FastAPI + MongoDB, em containers) guarda a fila, a posição e o histórico do que já foi visto.

## Estado do projeto

| Fase | Situação |
|---|---|
| Descoberta e decisões | Concluída (ver `docs/09-decisoes-e-pendencias.md`) |
| Documentação | Esta pasta |
| Implementação (Fases 0–4, local) | **Feita**; ver [docs/STATUS.md](docs/STATUS.md) para o que foi testado e o que falta validar no X |
| Deploy no servidor / iPhone | Não iniciados |

## Documentos

| Arquivo | Conteúdo |
|---|---|
| [docs/01-visao-e-requisitos.md](docs/01-visao-e-requisitos.md) | Objetivos, não-objetivos, requisitos, glossário |
| [docs/02-arquitetura.md](docs/02-arquitetura.md) | Componentes, fluxos, alternativas descartadas |
| [docs/03-userscript.md](docs/03-userscript.md) | Script do navegador: captura, fila, UI, threads, manutenção |
| [docs/04-api.md](docs/04-api.md) | Contrato da API FastAPI |
| [docs/05-modelo-de-dados.md](docs/05-modelo-de-dados.md) | Coleções MongoDB, índices, regras de merge |
| [docs/06-seguranca.md](docs/06-seguranca.md) | Chave de API, HTTPS, backups, riscos com o X |
| [docs/07-ambiente-e-infra.md](docs/07-ambiente-e-infra.md) | Docker local, servidor Oracle, deploy |
| [docs/08-roteiro.md](docs/08-roteiro.md) | Fases de desenvolvimento e critérios de aceite |
| [docs/09-decisoes-e-pendencias.md](docs/09-decisoes-e-pendencias.md) | Registro de decisões, pendências e riscos |
| [docs/10-deploy.md](docs/10-deploy.md) | Deploy no servidor, compose de produção, backup |
| [docs/STATUS.md](docs/STATUS.md) | Situação atual, como rodar, checklist de validação no X |

## Estrutura planejada do repositório

```
notiXias/
├── README.md
├── CLAUDE.md
├── docs/
├── docker-compose.yml          # local (api + mongo)
├── .env.example                # nunca versionar o .env real
├── api/                        # FastAPI
│   ├── Dockerfile
│   ├── pyproject.toml / requirements.txt
│   ├── app/
│   └── tests/
├── userscript/
│   └── notixias.user.js        # sem segredos no arquivo
└── scripts/                    # backup, rotação de chave etc.
```

## Princípios

1. **Nada de API paga do X.** O acesso aos posts é feito pelo próprio navegador do dono.
2. **O dono nunca rola o X manualmente.** O script rola por baixo de uma tela própria.
3. **Só links e metadados mínimos.** Não se guarda o texto dos posts nem mídia.
4. **Posição e histórico são sagrados.** Nada é apagado de verdade; há backup.
5. **Tudo em containers, local primeiro.** O servidor só entra com a aplicação já testada.
6. **O outro projeto no servidor não é tocado.** Mongo separado, rede separada.
