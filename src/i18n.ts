export const t = {
  // Header
  appTagline:
    "Solte um replay .rrf do Ragnarok Online abaixo. A análise roda no seu navegador; o arquivo é guardado em nuvem para você compartilhar o link.",
  discordLink: "Discord",
  discordTitle: "Entre no servidor do Discord",
  dropPrompt: "Solte um arquivo <code>.rrf</code> aqui, ou",
  browse: "escolha um",
  dropShareLabel: "Enviar este replay para o servidor",
  dropShareHint:
    "Por padrão a análise roda apenas no seu navegador. Ao marcar, o arquivo .rrf, seu nick e o mapa são enviados para a nuvem e ficam visíveis publicamente para qualquer pessoa com o link.",

  // Status
  parsing: (file: string, kb: string) => `Lendo ${file} (${kb} KB)…`,
  decoded: (handled: number, total: number, ms: string, file: string) =>
    `${handled.toLocaleString("pt-BR")} de ${total.toLocaleString("pt-BR")} pacotes lidos em ${ms} ms — ${file}`,
  parseError: (msg: string) => `Falha ao processar: ${msg}`,
  uploading: "Enviando para a nuvem…",
  uploadError: (msg: string) => `Falha ao enviar: ${msg}`,
  fetching: (id: string) => `Buscando replay compartilhado ${id}…`,
  fetchError: (msg: string) => `Falha ao carregar replay: ${msg}`,
  notFound: (id: string) => `Replay ${id} não encontrado.`,
  // Recent replays list
  recentReplaysTitle: "Replays recentes",
  recentReplaysHint: "Clique em um replay para abri-lo.",
  recentReplaysEmpty: "Nenhum replay enviado ainda.",
  recentReplaysNoMatch: "Nenhum replay corresponde aos filtros.",
  recentReplaysError: (msg: string) => `Falha ao carregar a lista: ${msg}`,
  recentReplaysLoading: "Carregando replays…",
  recentReplaysFilterPlayer: "Jogador",
  recentReplaysFilterMap: "Mapa",
  recentReplaysFilterClear: "Limpar filtros",
  colUploadedAt: "Enviado em",
  paginationPrev: "Anterior",
  paginationNext: "Próxima",
  paginationPageOf: (n: number) => `Página ${n}`,

  // Leaderboard page
  leaderboardNav: "Leaderboard",
  leaderboardTitle: "Leaderboard de MVPs",
  leaderboardHint:
    "Top 5 desempenhos por MVP, agregados entre todos os replays compartilhados.",
  leaderboardLoading: "Carregando replays…",
  leaderboardError: (msg: string) => `Falha ao carregar leaderboard: ${msg}`,
  leaderboardMvpLabel: "MVP",
  leaderboardClassLabel: "Classe",
  leaderboardClassAll: "Todas as classes",
  leaderboardClassUnknown: "(Sem classe)",
  leaderboardTopDamage: "Top 5 — Maior dano",
  leaderboardTopDps: "Top 5 — Maior DPS",
  leaderboardColHighestHit: "Maior golpe",
  leaderboardEmpty:
    "Nenhum MVP encontrado nos replays compartilhados ainda. Marque \"Enviar para o servidor\" ao subir um replay para aparecer aqui.",
  leaderboardEmptyForMvp: "Nenhum registro para este MVP.",
  leaderboardViewReplay: "Ver replay",
  leaderboardColRank: "#",
  leaderboardColPlayer: "Jogador",
  leaderboardColDps: "DPS",
  leaderboardColDate: "Gravado em",
  leaderboardColAction: "",

  // Suggestions section
  suggestionsNav: "Sugestões",
  suggestionsTitle: "Sugestões e comentários",
  suggestionsHint:
    "Compartilhe ideias, bugs ou pedidos. Vote nas sugestões existentes.",
  suggestionsPlaceholder: "Escreva uma sugestão…",
  suggestionsSubmit: "Enviar",
  suggestionsSending: "Enviando…",
  suggestionsSent: "Obrigado! Sua sugestão foi registrada.",
  suggestionsEmpty: "Nenhuma sugestão ainda. Seja o primeiro a enviar uma!",
  suggestionsLoading: "Carregando sugestões…",
  suggestionsError: (msg: string) => `Falha ao carregar sugestões: ${msg}`,
  suggestionsSubmitError: (msg: string) => `Falha ao enviar: ${msg}`,
  suggestionsVoteError: (msg: string) => `Falha ao votar: ${msg}`,
  suggestionsTooLong: "Sugestão muito longa (máx. 500 caracteres).",
  suggestionsAlreadyVoted: "Você já votou nesta sugestão.",
  suggestionUpvote: "Curtir",
  suggestionDownvote: "Não curtir",
  suggestionPostedAt: (when: string) => `Enviado em ${when}`,

  copyLink: "Copiar link",
  downloadReplay: "Baixar replay",
  linkCopied: "Link copiado!",
  shareReady: (url: string) => `Pronto para compartilhar: ${url}`,

  // Replay map viewer (3D overlay)
  replayMapButton: "Assistir replay (BETA)",
  replayMapLoading: "Carregando mapa…",
  replayMapError: "Falha ao carregar o mapa.",
  replayMapClose: "Fechar",
  replayMapPlay: "Reproduzir",
  replayMapPause: "Pausar",
  replayMapRestart: "Recomeçar",
  replayMapSpeedLabel: "Velocidade",
  replayMapScrub: "Linha do tempo",
  replayMapSettings: "Configurações",
  replayMapAura: "Aura",
  replayMapEffects: "Efeitos",
  replayMapSfx: "Sons",
  replayMapBgm: "Música",
  replayMapCredit: "Renderização inspirada no roBrowser",
  replayMapIntroTitle: "Recurso experimental",
  replayMapIntroBody:
    "Este visualizador de replay é altamente experimental e ainda faltam muitos recursos — várias habilidades, efeitos e detalhes não são reproduzidos. Para a melhor experiência, baixe o arquivo de replay (.rrf) e assista dentro do cliente do jogo.",
  replayMapIntroDismiss: "Entendi",

  // Export (PDF / Excel)
  exportPdf: "Baixar PDF",
  exportXlsx: "Baixar Excel",
  exportGenerating: "Gerando…",
  exportReportTitle: "Relatório RagnaRecap",
  exportReportGeneratedAt: (when: string) => `Gerado em ${when}`,
  exportXlsxFieldCol: "Campo",
  exportXlsxValueCol: "Valor",
  exportXlsxItemCol: "Item",
  exportXlsxQuantityCol: "Quantidade",
  exportXlsxUsesCol: "Usos",
  // Worksheet tab names (Excel caps these at 31 chars, so keep them short).
  exportSheetSession: "Sessão",
  exportSheetSummary: "Resumo",
  exportSheetByPlayer: "Por jogador",
  exportSheetByMonster: "Por monstro",
  exportSheetSkills: "Habilidades",
  exportSheetKills: "Abates",
  exportSheetConsumed: "Itens consumidos",
  exportSheetLoot: "Itens recebidos",

  // Mode toggle
  modeByPlayer: "Por jogador",
  modeByMonster: "Por monstro",
  modeStats: "Estatísticas",
  modeDpsAnalysis: "Análise de DPS",

  // Breadcrumb
  crumbPlayer: "Jogador",
  crumbMonster: "Monstro",
  clear: "Limpar",

  // Summary card
  sessionTitle: "Sessão",
  player: "Jogador",
  map: "Mapa",
  recordedAt: "Gravado em",
  duration: "Duração",
  totalDamage: "Dano total",
  avgDps: "DPS médio",
  damageEvents: "Eventos de dano",
  kills: "Abates",
  entitiesSeen: "Entidades vistas",
  packetsParsed: "Pacotes lidos",

  // By-player section
  playersHeading: "Jogadores",
  playersHint: "Clique em um jogador para ver os monstros que ele danificou.",
  monstersDamagedBy: (name: string) => `Monstros atacados por ${name}`,
  monstersDamagedByHint:
    "Clique em um monstro para ver o gráfico de dano deste confronto.",
  matchupTitle: (player: string, monster: string) => `${player} vs ${monster}`,
  skillsInMatchup: "Habilidades usadas neste confronto",
  matchupTimelineCardTitle: (player: string) => `Linha do tempo de dano — ${player}`,
  matchupSkillsCardTitle: (player: string) => `Habilidades — ${player}`,

  // By-monster section
  monstersHeading: "Monstros",
  monstersHint:
    "Clique em um monstro para ver quem o atacou e o gráfico de dano.",
  playersWhoDamaged: (monster: string) => `Jogadores que atacaram ${monster}`,
  damageOverTimeMultiTitle: "Dano ao longo do tempo — uma linha por jogador",
  damageByPlayerTitle: "Dano total por jogador",
  damageByPlayerHint: (mob: string) =>
    `Cada barra é um jogador, ordenado pelo dano total contra ${mob}.`,
  skillUsesAllTitle: "Habilidades mais usadas",
  skillUsesAllHint: "Uma barra por jogador e habilidade, ordenado pelo número de usos. Mostrando as 30 maiores.",
  skillUsesPlayerTitle: (player: string) => `Habilidades usadas por ${player}`,
  skillUsesMonsterTitle: (mob: string) => `Habilidades usadas contra ${mob}`,
  skillUsesPlayerVsMonsterTitle: (player: string, mob: string) =>
    `Habilidades de ${player} contra ${mob}`,
  skillUsesEmpty: "Nenhuma habilidade registrada.",

  // By-monster — selected mob detail
  mobOverviewTitle: "Visão geral do monstro",
  hpCurveTitle: "HP do monstro ao longo do tempo",
  hpSeriesLabel: "HP",
  hpMaxSeriesLabel: "HP máx.",
  mobVictimsTitle: (mob: string) => `Jogadores atacados por ${mob}`,
  mobVictimsBarTitle: (mob: string) => `Dano causado por ${mob}`,
  mobSkillsTitle: (mob: string) => `Habilidades de ${mob}`,
  mobSkillsHint: "Inclui habilidades que causaram dano e habilidades de suporte/debuff.",
  mobSkillsFilterLabel: "Filtrar por jogador:",
  mobSkillsFilterAll: "Todos os alvos",
  mobSkillsNoneForTarget: "Este monstro não usou habilidades contra este jogador no recorte gravado.",
  colNoDamageUses: "Usos sem dano",
  colDistinctTargets: "Alvos",
  colTopTarget: "Alvo principal",
  cellSpecies: "Espécie",
  cellMobMaxHp: "HP máx.",
  cellBoss: "Chefe",
  cellTimeAlive: "Tempo vivo",
  cellMobTtk: "Tempo até abate",
  cellKilledBy: "Abatido por",
  cellMobDamageReceived: "Dano recebido",
  cellMobDamageDealt: "Dano causado",
  cellMobVictims: "Alvos",
  cellMobTopVictim: "Maior alvo",
  cellMobAttackers: "Atacantes",
  mobNeverAttackedHint: "Este monstro não causou dano a jogadores no recorte gravado.",
  mobNoSkillsHint: "Este monstro não usou habilidades no recorte gravado.",
  mobNoHpDataHint: "Sem amostras de HP do servidor para este monstro.",

  killsAllTitle: "Abates por jogador e tipo de monstro",
  killsAllHint: "Uma barra por jogador e tipo de monstro. Mostrando os 30 maiores.",
  killsByPlayerTitle: (player: string) => `Monstros abatidos por ${player}`,
  killsByMonsterTitle: (mob: string) => `Quem abateu ${mob}`,
  killsPlayerVsMonsterTitle: (player: string, mob: string) =>
    `Abates de ${mob} por ${player}`,
  skillsAgainstMonster: "Habilidades usadas contra este monstro",

  // Table column labels
  colPlayer: "Jogador",
  colClass: "Classe",
  colLevel: "Nível",
  colMonster: "Monstro",
  colMobId: "ID do mob",
  colDamageDealt: "Dano causado",
  colDamageTaken: "Dano recebido",
  colDamage: "Dano",
  colHits: "Acertos",
  colCrits: "Críticos",
  colMisses: "Erros",
  colMonstersHit: "Monstros",
  colKills: "Abates",
  colKillingBlow: "Golpe fatal",
  colAttackers: "Atacantes",
  colMaxHp: "HP máx.",
  colTtk: "Tempo até abate",
  colSkill: "Habilidade",
  colId: "ID",
  colTotalDamage: "Dano total",
  colAvgDamage: "Dano médio",
  colMultiHit: "Hits médios",
  colAvgCast: "Cast médio",

  // Misc
  emptyTable: "Nenhuma linha corresponde ao filtro atual.",
  emptyChart: "Sem eventos de dano para exibir.",
  none: "—",
  autoAttack: "Ataque básico",
  bossMark: "★",

  // Chart
  chartXAxis: "Tempo (s)",
  chartDamageLabel: "Dano",

  // Fallbacks for unresolved IDs
  skillFallback: (id: number) => `skill#${id}`,
  mobFallback: (id: number) => `mob#${id}`,
  itemFallback: (id: number) => `item#${id}`,
  /** Used for damage targets without a spawn packet (training dummies on
   *  practice maps, server-pushed entities the recording missed, etc.). */
  unknownTargetName: "Alvo desconhecido",

  // Stats tab
  statsResumoTitle: "Resumo",
  statsBrushHint:
    "Arraste no gráfico para filtrar todas as estatísticas a uma janela específica. Pontos coloridos = abates.",
  statsBrushClear: "Limpar seleção",
  statsRangeLabel: (start: string, end: string) =>
    `Janela: ${start} – ${end}`,
  // DPS Analysis tab
  dpsAnalysisHelpTitle: "Como usar",
  dpsAnalysisHelpHowToUse: "Como usar.",
  dpsAnalysisHelpHowToUseBody:
    "Arraste sobre o gráfico para selecionar uma janela. As estatísticas abaixo recalculam para os eventos dentro dessa janela. Círculos = golpes do seu jogador; barras verticais = mensagens que você digitou no chat — passe o mouse para ver o dano (com a habilidade) ou o texto. Clique em \"Limpar seleção\" para voltar à sessão completa.",
  dpsAnalysisHelpDpsCalc: "Como o DPS é calculado.",
  dpsAnalysisHelpDpsCalcBody:
    "O DPS médio usa o primeiro e o último golpe dentro da janela selecionada como base de tempo, não as bordas da seleção. Em fórmula: DPS = dano total na janela ÷ (tempo do último golpe − tempo do primeiro golpe). Isso evita que tempo morto antes do primeiro hit ou depois do último diluam o DPS.",
  dpsAnalysisHelpTimeMetrics: "Diferença entre as métricas de tempo.",
  dpsAnalysisHelpTimeMetricsBody:
    "\"Janela selecionada\" mostra o tamanho do retângulo que você arrastou. \"Janela de combate\" mostra último golpe − primeiro golpe — sempre menor ou igual à janela selecionada. \"Maior intervalo\" é o maior salto entre dois golpes consecutivos dentro da janela (útil para identificar pausas).",
  dpsAnalysisChartTitle: "Linha do tempo de dano e mensagens",
  dpsAnalysisDamageSeries: "Dano",
  dpsAnalysisChatSeries: "Mensagens",
  dpsAnalysisClearSelection: "Limpar seleção",
  dpsAnalysisRangeLabel: (s: string, e: string) => `Janela: ${s} – ${e}`,
  dpsAnalysisStatsTitle: "Estatísticas da janela",
  dpsAnalysisEmpty: "Nenhum evento de dano do jogador neste recorte.",
  cellSelectionDuration: "Janela selecionada",
  cellEventsInWindow: "Eventos de dano",
  cellCombatSpan: "Janela de combate",
  cellCombatSpanHint: "Do 1º ao último golpe",
  cellWindowDps: "DPS médio",
  cellMeanInterval: "Tempo médio entre golpes",
  cellHighestSingleHit: "Maior golpe",
  cellAverageHit: "Dano médio por golpe",
  cellLongestGap: "Maior intervalo",
  cellDistinctSkills: "Habilidades distintas",
  cellTopSkillWindow: "Habilidade mais usada",

  // Equipment card (Estatísticas tab)
  equipmentTitle: "Equipamento",
  equipmentNone: "Sem equipamentos no momento da gravação.",
  equipmentPageStart: "Início da gravação",
  equipmentPageOf: (i: number, n: number) => `${i}/${n}`,
  equipmentChangedAt: (at: string) => `Troca em ${at}`,
  equipGroupEquip: "Equipamento",
  equipGroupEspecial: "Especial",
  equipCardsTitle: "Cartas e Encantamentos",
  equipOptionsTitle: "Bônus Aleatórios",
  slotHeadTop: "Topo",
  slotHeadMid: "Meio",
  slotHeadLow: "Baixo",
  slotArmor: "Armadura",
  slotWeapon: "Arma",
  slotShield: "Escudo",
  slotGarment: "Manto",
  slotShoes: "Calçado",
  slotAccLeft: "Acessório esq.",
  slotAccRight: "Acessório dir.",
  slotAmmo: "Munição",
  slotCostumeHeadTop: "Fantasia (topo)",
  slotCostumeHeadMid: "Fantasia (meio)",
  slotCostumeHeadLow: "Fantasia (baixo)",
  slotCostumeGarment: "Fantasia (manto)",
  slotShadowArmor: "Sombrio (armadura)",
  slotShadowWeapon: "Sombrio (arma)",
  slotShadowShield: "Sombrio (escudo)",
  slotShadowShoes: "Sombrio (calçado)",
  slotShadowAccLeft: "Sombrio (acess. esq.)",
  slotShadowAccRight: "Sombrio (acess. dir.)",
  slotOther: "Outro",

  // Character viewer (Equipamento) — sprite served by ragassets/zrenderer
  characterViewerError: "Não foi possível carregar o sprite.",
  characterBodyLabel: "Corpo",
  characterHeadLabel: "Cabeça",
  characterStateLabel: "Estado",
  characterRotatePrev: "Girar para a esquerda",
  characterRotateNext: "Girar para a direita",
  // Animation states for the viewer dropdown, wired to zrenderer animation types
  // by STATE_LIST in ui/character-viewer.ts (new keys need an entry there too).
  // "Atacar" is a single entry — the actual attack animation is chosen from the
  // equipped weapon (weapon-action.ts).
  characterStates: {
    idle: "Parado",
    walk: "Andar",
    sit: "Sentar",
    pickup: "Pegar item",
    standby: "Em guarda",
    attack: "Atacar",
    casting: "Conjurando",
    hurt: "Ferido",
    frozen: "Atordoado",
    dead: "Morto",
    frozen2: "Congelado",
  },

  statsConsumablesTitle: "Itens consumidos",
  statsConsumablesEmpty: "Nenhum item consumido nesta janela.",
  statsLootTitle: "Itens recebidos",
  statsLootEmpty: "Nenhum item recebido nesta janela.",
  statsHpSpChartTitle: "HP / SP ao longo do tempo",
  statsKillsChartTitle: "Abates por tipo de monstro",
  statsDeleteReason: (reason: number) => {
    switch (reason) {
      case 0: return "Uso normal";
      case 1: return "Por habilidade";
      case 2: return "Refino falhou";
      case 3: return "Material consumido";
      case 4: return "Ação especial";
      case 5: return "Vendido";
      case 6: return "Movido p/ depósito";
      case 7: return "Movido p/ carrinho";
      default: return `Razão ${reason}`;
    }
  },

  // Resumo cells
  cellTotalDealt: "Dano causado",
  cellTotalTaken: "Dano recebido",
  cellEffectiveDps: "DPS em combate",
  cellHits: "Acertos",
  cellMisses: "Erros",
  cellCrits: "Críticos",
  cellHighestHit: "Maior dano",
  cellMostUsedSkill: "Hab. mais usada",
  cellKills: "Abates",
  cellBossKills: "Chefes abatidos",
  cellTtfk: "Tempo até 1º abate",
  cellAvgKillInterval: "Tempo entre abates",
  cellTopSpecies: "Mais abatido",
  cellLevelsGained: "Níveis ganhos",
  cellJobLevelsGained: "Níveis de classe",
  cellZenyDelta: "Zeny ganho",
  cellMapsVisited: "Mapas visitados",
  cellDeaths: "Mortes",
  cellSessionDuration: "Duração",
};

export const locale = "pt-BR";
