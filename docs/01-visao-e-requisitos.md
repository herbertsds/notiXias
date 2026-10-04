# 01 — Visão e requisitos

## Contexto

O dono segue 54 contas no X e usa a plataforma como fonte de notícias. O app oficial:
- reabre sempre no post mais recente, perdendo o ponto de leitura;
- mistura algoritmo, recomendações e respostas à experiência.

O dono quer ler **em ordem cronológica**, **de onde parou**, com a **página real do post** (comentários incluídos), e decidir sozinho quando buscar novidades.

## Objetivos

1. Manter uma **fila persistente** de posts da timeline "Seguindo" (trocável por uma Lista), ordenada por ordem de leitura (do mais antigo ao mais novo).
2. Guardar a **posição de leitura** e restaurá-la em qualquer aparelho.
3. Exibir cada entrada **abrindo a página real do post no X**, rolada ao topo, com uma barra de navegação (anterior / próxima).
4. **Buscar novidades automaticamente** (sem o dono rolar nada) quando a fila acaba ou quando ele pedir.
5. Registrar **o que já foi visto e quando**, e sinalizar quando um post já visto reaparece (por repost).
6. Tratar **threads** e **respostas** do jeito que o dono lê: abrindo o último post da cadeia.
7. Ser **resiliente a mudanças** no HTML do X e **avisar** quando quebrar.

## Não-objetivos

- Ganhar dinheiro, publicar ou redistribuir conteúdo.
- Postar, curtir, seguir ou qualquer ação de escrita no X.
- Usar a API oficial paga do X.
- Guardar texto, imagens ou vídeos de posts.
- Multiusuário. O sistema é de um único usuário, hoje e no futuro.
- Rodar coleta agendada ou em segundo plano sem o dono presente.
- Substituir o X para postar ou interagir (o dono ainda pode abrir o X normalmente).

## Requisitos funcionais

| ID | Requisito |
|---|---|
| RF1 | Capturar, da timeline/lista, os posts novos desde o último guardado, preservando a ordem. |
| RF2 | Para cada post, guardar: ID, link canônico, autor, quem repostou (se houver), tipo, momento da captura. |
| RF3 | Juntar reposts do mesmo post, quando a aparição anterior ainda não foi lida, numa só entrada. |
| RF4 | Criar nova entrada quando um post já lido é repostado de novo. |
| RF5 | Mostrar etiqueta "repostado por @conta" quando aplicável. |
| RF6 | Mostrar etiqueta "já visto em dd/mm/aaaa às hh:mm" (e contagem se mais de uma vez) em qualquer post com visualização anterior. |
| RF7 | Considerar "visto" ao sair do post com "próxima". |
| RF8 | Navegar para a próxima entrada sem recarregar o X (navegação interna); se falhar, abrir a página normalmente. |
| RF9 | Ao abrir uma página de post, rolar ao topo. |
| RF10 | Ao chegar numa thread, saltar para o último post encadeado do mesmo autor visível na página e marcar como cobertos os pedaços realmente presentes na tela. |
| RF11 | Quando a fila acabar, mostrar uma tela própria por cima ("buscando novas…") enquanto o script rola o feed por baixo até reencontrar o ponto guardado. |
| RF12 | Se o ponto guardado não for reencontrado, avisar da possível lacuna e seguir com o que foi capturado. |
| RF13 | O feed (padrão: "Seguindo") deve ser trocável por configuração simples (ex.: URL de uma Lista). |
| RF14 | Detectar quando a captura quebrou (verificador de saúde), parar, avisar e salvar um esqueleto estrutural da página (sem texto) para diagnóstico. |
| RF15 | Permitir reabrir entradas marcadas como cobertas (reversível). |
| RF16 | Sincronizar fila, posição e histórico entre aparelhos via API. |

## Requisitos não funcionais

| ID | Requisito |
|---|---|
| RNF1 | **Discrição:** rolagem em passos moderados com pausas aleatórias; só quando o dono dispara; somente leitura. |
| RNF2 | **Fluidez:** navegação entre posts sem recarregar o código do X sempre que possível. |
| RNF3 | **Segurança:** API só responde com chave válida; HTTPS obrigatório fora do ambiente local. |
| RNF4 | **Durabilidade:** backup diário do Mongo; nenhuma exclusão física pela API. |
| RNF5 | **Portabilidade:** mesma stack local e no servidor (Docker, imagens ARM e x86). |
| RNF6 | **Manutenibilidade:** toda dependência da estrutura do X isolada num módulo pequeno do userscript. |
| RNF7 | **Mínimo de dados:** nenhum conteúdo de post armazenado. |

## Glossário

- **Entrada (entry):** item da fila de leitura; corresponde a um post original, possivelmente com reposters.
- **Aparição (appearance):** uma ocorrência de um post na timeline, identificada por `id|reposter`.
- **Âncora:** aparição(ões) já guardada(s) usada(s) para saber onde parar a rolagem de busca.
- **Cursor / posição:** entrada em que o dono está.
- **Coberta:** entrada que o dono vê como parte de outra (pedaço de thread) e que não entra na leitura separadamente.
- **Fila:** sequência de entradas em ordem de leitura (mais antiga primeiro).
- **Esqueleto:** representação da estrutura (tags, atributos estáveis) de um post, sem nenhum texto.
