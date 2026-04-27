export const t = {
  // Header
  appTagline:
    "Solte um replay .rrf do Ragnarok Online abaixo. A análise roda no seu navegador; o arquivo é guardado em nuvem para você compartilhar o link.",
  dropPrompt: "Solte um arquivo <code>.rrf</code> aqui, ou",
  browse: "escolha um",

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
  copyLink: "Copiar link",
  linkCopied: "Link copiado!",
  shareReady: (url: string) => `Pronto para compartilhar: ${url}`,

  // Mode toggle
  modeByPlayer: "Por jogador",
  modeByMonster: "Por monstro",
  modeStats: "Estatísticas",

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
  statusFallback: (id: number) => `efst#${id}`,

  // Stats tab
  statsResumoTitle: "Resumo",
  statsBrushHint:
    "Arraste no gráfico para filtrar todas as estatísticas a uma janela específica. Pontos coloridos = abates.",
  statsBrushClear: "Limpar seleção",
  statsRangeLabel: (start: string, end: string) =>
    `Janela: ${start} – ${end}`,
  statsConsumablesTitle: "Itens consumidos",
  statsConsumablesEmpty: "Nenhum item consumido nesta janela.",
  statsLootTitle: "Itens recebidos",
  statsLootEmpty: "Nenhum item recebido nesta janela.",
  statsHpSpChartTitle: "HP / SP ao longo do tempo",
  statsKillsChartTitle: "Abates por tipo de monstro",
  statsBuffsTitle: "Tempo com buffs / debuffs",
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
