# 06 — Segurança e riscos

Modelo de ameaça: sistema de **um único usuário**, API potencialmente pública na internet (necessário para o iPhone). O objetivo é impedir que terceiros leiam ou alterem o histórico, e reduzir os riscos de usar a conta no X.

## Autenticação: chave de API única

### Decisão

Uma chave longa e aleatória, enviada em `Authorization: Bearer <chave>`. Sem usuário/senha, sem Keycloak. A decisão pode evoluir para login com tokens se o sistema deixar de ser de uso exclusivo do dono (hoje: **não**).

### Geração e guarda

- Gerada por programa (≥ 32 bytes aleatórios, codificados em base64url/hex). Nunca escolhida à mão.
- No servidor: apenas o **hash** (ex.: SHA-256) em `API_KEY_HASH`, em variável de ambiente. O valor em claro não é guardado no servidor.
- No cliente: no **armazenamento do gerenciador de scripts** (`GM_setValue`), pedido uma vez na primeira execução. **Nunca** no arquivo do userscript nem no `localStorage` do x.com.
- Nunca no Git. `.env` no `.gitignore`; `.env.example` sem valores reais.

### Verificação

- Comparação em tempo constante (`hmac.compare_digest`).
- Resposta idêntica (`401`) para qualquer falha, sem revelar o que existe.
- Registrar tentativas inválidas (IP, horário) sem registrar o valor recebido.

### Rotação

Trocar a chave deve ser trivial e **sem mexer em código**:
1. Gerar nova chave e calcular o hash.
2. Atualizar `API_KEY_HASH` e reiniciar a API.
3. Atualizar a chave nos aparelhos (menu "Configurar API").

Rotacionar imediatamente se um aparelho for perdido/invadido ou a chave aparecer em algum lugar indevido.

## Transporte

- **Local:** HTTP em `localhost`, publicado apenas em `127.0.0.1`.
- **Produção:** HTTPS obrigatório (o Safari do iPhone bloqueia conteúdo misto, e a chave não pode trafegar em claro). O proxy do servidor (Nginx Proxy Manager) emite o certificado.
- A API em produção não aceita requisições HTTP diretas.

## Exposição

- Mongo **nunca** com porta publicada; só a rede interna do compose.
- API: no servidor, sem porta publicada no host; somente o proxy a alcança pela rede Docker.
- `/docs` e `/openapi.json` desligados em produção.
- Limite de tentativas no proxy (e/ou na API) para barrar adivinhação da chave.

## Integridade dos dados

- Validação estrita (Pydantic): IDs numéricos, handles no formato do X, tamanhos máximos, lote ≤ 1000.
- Consultas ao Mongo sempre parametrizadas por modelos; nunca montar filtros a partir de texto cru.
- **Sem exclusão física** pela API. Remoção lógica.
- Operações de lote são idempotentes (`batch_id`).
- Concorrência otimista no `state`, para dois aparelhos não se sobrescreverem.

## Backup e recuperação

- Dump diário do banco (`mongodump`) para fora do container, com retenção (ex.: 14 diários, 8 semanais).
- Cópia fora do servidor (o disco do servidor não é backup de si mesmo).
- **Testar a restauração** ao menos uma vez antes de confiar.
- Endpoint `/export` para um backup manual em JSON.

## Privacidade

- Guardados: IDs, links, handles de contas já públicas, horários de captura e de visualização.
- **Não** guardados: texto, imagens, vídeos, métricas, listas de seguidos.
- O histórico de leitura é dado pessoal sensível por natureza (revela interesses): proteger a API e os backups.

## Riscos com o X

Este é o risco principal do projeto e deve ser aceito conscientemente pelo dono.

| Risco | Mitigação |
|---|---|
| O uso automatizado de rolagem contraria os termos do X; a conta pode ser limitada, verificada ou suspensa. | Somente leitura; sempre com o dono presente; navegador, IP e sessão do próprio dono; rolagem em ritmo humano; sem coleta agendada. |
| O X muda a estrutura da página e o script quebra. | Âncoras por URL, módulo `x-dom` isolado, verificador de saúde, esqueleto sem texto para conserto rápido. |
| Verificação/captcha/aviso do X durante a busca. | Parar imediatamente e avisar. Nunca contornar. |
| Credenciais. | O script não lida com senha. O dono faz login manualmente no X. |
| Lacunas por ausência longa. | Detecção e aviso (`gap_before`). |

O projeto não usa a API oficial, não publica nada e não redistribui conteúdo.

## Checklist antes de subir ao servidor

- [ ] Chave gerada e hash configurado; chave fora do Git.
- [ ] HTTPS ativo no domínio escolhido.
- [ ] Portas do Mongo e da API não publicadas no host.
- [ ] `/docs` desligado.
- [ ] Limite de tentativas no proxy.
- [ ] Backup diário rodando e restauração testada.
- [ ] Nenhum container do outro projeto alterado.
