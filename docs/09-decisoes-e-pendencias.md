# 09 — Decisões, pendências e riscos

## Registro de decisões

| # | Decisão | Motivo |
|---|---|---|
| D1 | Sem API oficial do X (paga). | O dono não pode custear. |
| D2 | Coleta pelo navegador do dono, com ele presente; sem coleta agendada. | Menor risco com o X; sem credenciais no servidor. |
| D3 | Feed padrão: **"Seguindo"** em `/home`; trocável por Lista via configuração. | Pedido do dono. |
| D4 | O dono nunca rola o X; uma **tela própria** cobre o feed enquanto o script rola por baixo. | Requisito central. |
| D5 | Exibição = **página real do post** no X, com comentários, rolada ao topo. | Pedido do dono. |
| D6 | Ordem = sequência de captura (`seq`), não ID do post. | Reposts têm ID original antigo. |
| D7 | A fila só cresce ao acabar ou quando o dono pedir. | Evita ficar "puxando" o feed a cada passo. |
| D8 | Etiqueta "repostado por @conta", lida pelo href do perfil. | Independe de idioma. |
| D9 | Posts já vistos recebem etiqueta "Visto em" com data/hora. Repost de post visto há **mais de 2 h** volta como nova entrada; se visto há menos, não volta e o repost fica registrado na entrada já vista. | Pedido do dono. |
| D10 | Reposts do mesmo post antes da leitura viram uma entrada só. | Evita ler repetido. |
| D11 | Threads: abrir o **último** post da cadeia; verificação na hora da leitura, por DOM e URL. | Preferência do dono; evita JSON interno do X. |
| D12 | Nunca agrupar por vizinhança na lista; só o que aparece encadeado na página; só cobrir o que está no DOM. | Evitar pular posts independentes seguidos. |
| D13 | Respostas entre contas diferentes: absorção **desligada** por padrão. | Menos evidente que thread do mesmo autor. |
| D14 | Âncoras do X: padrão de URL `/usuario/status/ID`, nunca classes CSS. | Estabilidade. |
| D15 | Verificador de saúde + esqueleto sem texto, em vez de tweet de referência. | O dono não quer tweet de referência. |
| D16 | Não ler o JSON interno do X (por ora). | Frágil; pode voltar como complemento. |
| D17 | Fluidez: **apenas** navegação interna do X (sem recarregar); se falhar, abre a página normal. | Simplificação pedida pelo dono. |
| D18 | Userscript: Tampermonkey no Chrome do Mac; app Userscripts no Safari do iPhone. | Chrome do iOS não aceita extensões. |
| D19 | `GM_xmlhttpRequest` + `GM_setValue`. | Contorna a CSP do x.com; mantém a chave fora do alcance do X. |
| D20 | Backend FastAPI + MongoDB, **tudo em Docker**; Mongo **separado** do outro projeto. | Pedido do dono. |
| D21 | Desenvolvimento e testes **locais primeiro**; servidor só depois. | Pedido do dono. |
| D22 | Autenticação por **chave de API única**, hash no servidor, chave no armazenamento do gerenciador de scripts. | Sistema de um único usuário. |
| D23 | Sem Keycloak. | Pesado; usar o do outro projeto seria alterá-lo. |
| D24 | Sem exclusão física; backup diário do Mongo. | Proteger o histórico. |
| D25 | Guardar apenas IDs, links, autor, reposters e horários; sem texto nem mídia. | Mínimo de dados. |
| D26 | Barra inferior própria 40/20/40, que substitui a do X (escondida) e reserva espaço na página. | Pedido do dono (uso principal no celular). |
| D27 | Centro da barra: posição + avisos; toque alterna leitura/navegação; pressão longa abre o menu. | Pedido do dono. |
| D28 | Modo uma mão (esquerda/direita, ~65%) e escolha de botões (ambos/só avançar/só voltar), salvos nas configurações. | Pedido do dono. |
| D29 | Etiquetas dentro do post da fila (primeiro filho) + aviso de repost no primeiro post da tela quando o repostado vem depois. | Pedido do dono. |
| D31 | Thread/cobertura só consideram a conversa: posts antes do primeiro título de seção ("Descubra mais") dentro de `primaryColumn`. | Bug 0.2.2: recomendação do mesmo autor era tratada como thread (saltava de post e cobria entradas de outra conversa). |
| D30 | "Sempre abrir a versão mobile" **não é viável** por userscript (layout depende da largura da janela). | Limitação do X/navegador. |

## Pendências (resolver na prática, durante o desenvolvimento)

| # | Pendência | Como decidir |
|---|---|---|
| P1 | Salto de thread: mostrar o post 1 por um instante ou tela de "carregando". | Testar com threads reais. |
| P2 | Navegação interna do X funciona de forma confiável? | Prototipar `go(url)`; senão, manter fallback. |
| P3 | Absorver respostas entre contas diferentes? | Testar depois de threads funcionarem. |
| P4 | Atalhos de teclado e gesto de deslizar. | Avaliar no uso; deslizar conflita com a rolagem. |
| P5 | Domínio/subdomínio para a API em produção. | Na fase de deploy. |
| P6 | Nome da rede Docker do Nginx Proxy Manager e forma de conectar. | Leitura no servidor, na fase de deploy. |
| P7 | Destino da cópia externa dos backups. | Na fase de deploy. |
| P8 | Compatibilidade exata do app Userscripts (GM_*) no iPhone. | Fase 7. |
| P9 | Idioma/estrutura das abas de `/home` para selecionar "Seguindo" por posição. | Fase 3. |
| P10 | Refinar `kind` (`reply`, `quote`) e etiquetas correspondentes. | Se fizer falta. |
| P11 | Esconder a barra do X por heurística (nav fixo embaixo) funciona no mobile real? | Testar em janela estreita e no iPhone. |
| P12 | Etiquetas injetadas sobrevivem aos redesenhos do X? | Observar no uso; ajustar `labels.js`. |
| P13 | Botão 🏠 reabre a leitura (retomada automática): é o desejado? | Decidir no uso. |

## Adiado (fora do escopo inicial)

- **Cartão próprio instantâneo** (dados mínimos renderizados por nós) enquanto a página real carrega.
- **Pré-carga das imagens** dos próximos ~5 posts.
- Leitura passiva do JSON interno do X para threads/conversas.
- Login com usuário/senha e tokens.
- Interface web de leitura própria (fora do X).

## Riscos

| Risco | Prob. | Impacto | Resposta |
|---|---|---|---|
| X limita/suspende a conta por automação de rolagem. | Média-baixa | Alto | Ritmo humano, só com o dono presente, somente leitura, parar diante de qualquer aviso. Decisão consciente do dono. |
| X muda o HTML e a captura quebra. | Alta (com o tempo) | Médio | Âncoras por URL, módulo isolado, verificador de saúde, esqueleto. |
| Navegação interna não funciona. | Média | Baixo | Fallback para abrir a página. |
| Lacunas por ausência longa. | Média | Médio | Detecção e aviso; seguir do mais antigo capturado. |
| Cobertura de thread pula post. | Baixa | Médio | Regras D12; reversível. |
| Aba pausada no iPhone interrompe a busca. | Média | Baixo | Tela própria em primeiro plano; retomar. |
| Vazamento da chave. | Baixa | Alto | Rotação simples; chave fora do código/Git; HTTPS. |
| Perda de dados. | Baixa | Alto | Backup diário + restauração testada. |
| Interferência no outro projeto do servidor. | Baixa | Alto | Recursos totalmente separados; nada do outro projeto é alterado. |

## Perguntas do dono já respondidas (para referência)

- *Dá para fazer sem pagar API?* Sim, pelo navegador do dono (D1, D2).
- *Preciso rolar o X?* Não; o script rola por baixo da tela própria (D4).
- *Funciona no iPhone com Chrome?* Não; Safari com app Userscripts (D18).
- *Como evitar que outras pessoas acessem a API?* Chave única + HTTPS (D22).
- *Posso colocar a chave no script?* No armazenamento do gerenciador de scripts, nunca no arquivo (D19, D22).
