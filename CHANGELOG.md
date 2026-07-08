# Changelog

All notable user-facing changes to RagnaRecap. Newest first.

## 2026-07-08

- Visualizador de replay: efeitos visuais de habilidades agora incluem os **efeitos de área no chão** (tipo "cilindro" do cliente) — o pilar vermelho do Magnus Exorcismus, anéis, domos e auras de área de ~150 efeitos, renderizados fielmente como no jogo (porte do renderer de cilindros do roBrowser). Complementa os efeitos de habilidade em `.str` já suportados; habilidades sem efeito conhecido continuam sem efeito (nada de placeholders genéricos).

## 2026-07-07

- Base de itens atualizada com o último patch do cliente: **389 itens novos** (equipamentos Sombrios, conjuntos de Sakray, munições de canhão, entre outros) e diversos nomes corrigidos. Os replays passam a mostrar o nome correto desses itens em vez de exibir só o ID.

## 2026-07-02

- **Visualizador de replay (experimental):** novo botão "Assistir replay" abre uma reprodução 3D da gravação — o mapa, o jogador com equipamento, monstros, NPCs, danos flutuantes, buffs e os companheiros (falcão e worg, inclusive a montaria). É **altamente experimental** e ainda faltam vários recursos; para a melhor experiência, baixe o arquivo `.rrf` e assista dentro do cliente do jogo. A renderização (sprites, mapa, câmera e a animação dos números de dano) é portada e inspirada no [roBrowser](https://github.com/vthibault/roBrowser), um cliente de Ragnarok no navegador.

## 2026-06-26

- Nomes dos monstros corrigidos: agora vêm do projeto irmão [ragassets](https://github.com/adsonpleal/ragassets) (`mobs.json`), que passa a ser a fonte oficial dos nomes em português, junto com HP e nível de cada monstro. Substitui a antiga raspagem do Divine Pride — nenhum dado de monstro é mais buscado em divine-pride.net.

## 2026-06-25

- Leaderboard de MVPs: agora considera **todos** os replays compartilhados, não só os 300 mais recentes. Antes, conforme novos replays eram enviados, recordes antigos saíam silenciosamente da lista; agora o ranking reflete a base inteira.
- Leaderboard de MVPs: nomes das classes 4 corrigidos para os nomes atuais em português, iguais aos do projeto irmão (Visuais Latam): Magus (antes Arquimágico), Executor (antes Assassino), Falcão do Vento (antes Patrulheiro), Mandraque (antes Ladino) e Maestro (antes Poeta). Replays antigos também são normalizados para os novos nomes no filtro.
- Visualizador de personagem: correção do sexo, que voltava a sair sempre masculino. Personagens femininas agora aparecem corretamente. (O sexo é lido do contêiner ReplayData, já que a mesma conta pode ter personagens dos dois sexos e o jogador local nunca aparece em pacotes de spawn.)

## 2026-06-19

- Bônus Aleatórios dos equipamentos agora são importados do replay e exibidos no popover de cada item, com os nomes em português vindos do cliente do jogo (ex.: "ATQM +7", "Conjuração variável -8%", "Precisão +9").
- Visualizador de personagem: o sexo passa a ser detectado corretamente (antes saía sempre masculino), e o sprite usa o penteado, a cor de cabelo e a cor de roupa reais do personagem em vez dos padrões.

## 2026-06-14

- Botões "Baixar PDF" e "Baixar Excel" na barra das abas. O PDF gera um relatório com **todas as abas** (Estatísticas, Por jogador, Por monstro e Análise de DPS) em um único documento — incluindo os gráficos e o sprite do personagem — via a opção "Salvar como PDF" da impressão do navegador. O Excel (.xlsx) exporta os números das tabelas em uma **planilha com várias abas** (Sessão, Resumo, Por jogador, Por monstro, Habilidades, Abates e Itens), com cabeçalhos em negrito, primeira linha fixada, números formatados com separador de milhar e colunas dimensionadas.

## 2026-06-11

- Visualizador de personagem no card de Equipamento: sprite animado do jogador vestindo o conjunto equipado da página atual (chapéus, manto, arma e escudo; itens de fantasia têm precedência sobre os normais). Controles para girar o corpo em 8 direções e a cabeça (só parado/sentado, como no jogo), e seletor de estado (parado, andar, sentar, atacar, conjurando, morto etc.). A animação de ataque é a da arma equipada, o sexo do personagem é detectado automaticamente do replay, e os pés ficam alinhados na mesma linha de chão em todos os estados. Imagens servidas por [ragassets](https://github.com/adsonpleal/ragassets), uma camada de cache sobre o [zrenderer](https://github.com/zhad3/zrenderer).
- A aba "Estatísticas" agora é a primeira e abre por padrão, com o card de Equipamento no topo da aba.

## 2026-06-10

- Card de Equipamento redesenhado no estilo da janela do jogo: cada item vira um card com ícone e nome, dispostos em duas colunas (Equip e Especial) que se reorganizam em telas menores. Slots vazios continuam visíveis, armas de duas mãos ocupam os dois espaços (arma e escudo), e ao passar o mouse ou clicar abre-se um popover com o slot, as cartas e encantamentos, e links para o Divine Pride (do item e de cada carta).
- Ícones de itens extraídos do cliente do jogo passam a ser exibidos no card de Equipamento.
- Ícone da classe exibido ao lado do nome da classe em todas as tabelas (Por jogador, vítimas de monstro, habilidades) e no filtro de classe do Leaderboard.
- Ícone da habilidade exibido ao lado do nome da habilidade nas tabelas de habilidades e no gráfico de "Habilidades mais usadas".
- Correção: equipamentos iniciais e itens de fantasia (que apareciam sem informação ou com ID 0) agora são lidos corretamente em replays de clientes mais novos.
- Nomes de itens, habilidades e classes agora vêm direto do cliente do jogo, em português, no lugar do scraping do Divine Pride. Passa a incluir itens recentes que faltavam (equipamentos novos) e a contagem de brechas no nome (ex.: "Adaga [3]"). Habilidades cobrem também as classes de 4ª geração.
- Nomes de monstros continuam vindo do Divine Pride (não fazem parte dos arquivos do cliente).

## 2026-06-09

- Card de Equipamento (aba "Estatísticas") virou uma linha do tempo: a primeira página mostra o conjunto no início da gravação e cada troca de equipamento cria uma nova página com o conjunto completo, o horário e destaque nos itens alterados. Navegação com contador e setas; trocas quase simultâneas são agrupadas; sem paginação quando o replay não tem trocas.
- Correção na leitura do conjunto equipado em replays de clientes mais novos.

## 2026-05-18

- Filtro por classe no Leaderboard, listando todas as classes de personagem mesmo as sem registros.
- Busca com autocompletar (combobox) para jogador e classe, com navegação por teclado.
- Correção ao abrir um segundo replay pela lista ("Ver replay") e ordenação dos MVPs sem nome real (placeholder) por último.

## 2026-05-17

- Página de Leaderboard de MVPs: top 5 maior dano e top 5 maior DPS por MVP, agregando todos os replays compartilhados. Cada linha tem "Ver replay" para abrir o recording de origem.
- Análise local por padrão: o replay é decodificado no navegador e só vai para a nuvem se o usuário marcar "Enviar este replay para o servidor".
- Filtros de jogador e mapa na lista de replays recentes (busca por qualquer parte do nome, sem diferenciar maiúsculas).
- Página de sugestões e comentários, com votos persistidos no Firestore.
- Rodapé com links para os projetos irmãos (RagCalc, RagMarket).

## 2026-05-03

- Comparação multi-jogador na aba "Por jogador" — janela de combate compartilhada entre os cards.

## 2026-05-02

- Rebrand para RagnaRecap, hospedado em [ragnarecap.web.app](https://ragnarecap.web.app/).
- Encerramento do GitHub Pages, com redirecionamento.

## 2026-04-30

- Decodificação dos pacotes `0x0857` (snapshot inicial de spawn).

## 2026-04-29

- Banco de nomes do Divine Pride embutido como JSON estático.
- Busca sob demanda para IDs ainda não embutidos.

## 2026-04-28

- Nova aba "Análise de DPS" com seleção de janela arrastando o gráfico.
- Mensagens do chat plotadas como barras verticais no gráfico de DPS.
- Reatribuição do dano de habilidades de chão para o conjurador.
- Identificação de alvos sem spawn a partir das mensagens de chat.

## 2026-04-27

- Lista de uploads recentes na tela inicial.
- Botão "Baixar replay" no painel de compartilhamento.
- Card de equipamentos (com cartas e refino) na aba "Estatísticas".
- Links para o Divine Pride por carta e por ID em diversas tabelas.
