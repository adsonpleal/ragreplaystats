export const t = {
  // Header
  appTagline:
    "Solte um replay .rrf do Ragnarok Online abaixo — tudo é processado no seu navegador.",
  dropPrompt: "Solte um arquivo <code>.rrf</code> aqui, ou",
  browse: "escolha um",

  // Status
  parsing: (file: string, kb: string) => `Lendo ${file} (${kb} KB)…`,
  decoded: (handled: number, total: number, ms: string, file: string) =>
    `${handled.toLocaleString("pt-BR")} de ${total.toLocaleString("pt-BR")} pacotes lidos em ${ms} ms — ${file}`,
  parseError: (msg: string) => `Falha ao processar: ${msg}`,

  // Mode toggle
  modeByPlayer: "Por jogador",
  modeByMonster: "Por monstro",

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
};

export const locale = "pt-BR";
