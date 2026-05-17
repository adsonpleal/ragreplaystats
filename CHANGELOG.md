# Changelog

All notable user-facing changes to RagnaRecap. Newest first.

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
