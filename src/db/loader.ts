import {
  getItemName,
  getMonsterHp,
  getMonsterName,
  getSkillName,
} from "../divine-pride.js";

export type JobInfo = string;

export type ReferenceDb = {
  job: Record<string, JobInfo>;
  resolveMob(id: number): string;
  resolveMobHp(id: number): number;
  resolveSkill(id: number): string;
  resolveJob(id: number): string;
  resolveItem(id: number): string;
  /**
   * Distinct pt-BR PC class names, sorted alphabetically. Derived from
   * `PC_JOB_IDS` (a curated whitelist of player-character job ids) mapped
   * through `job` and de-duplicated. Used by UI filters that need to list
   * every class, not just the ones present in the current data set.
   */
  pcClassNames(): string[];
  /**
   * Job/view id whose sprite represents a given pc class name, for showing a
   * class icon next to the name. Returns the first `PC_JOB_IDS` entry that
   * resolves to `name`, or `undefined` when the name isn't a known pc class.
   */
  pcClassIconId(name: string): number | undefined;
};

/**
 * Whitelist of player-character job ids — the same list `tools/build-db.mjs`
 * uses when extracting names from the GRF. Includes alt-sprite ids
 * (mounted Knight, Crusader on peco, mounted Royal Guard, etc.); those
 * either share a name with their base class (and get deduped) or fall
 * through to `job#<id>` and get filtered out at the call site.
 */
export const PC_JOB_IDS: readonly number[] = [
  // 1st gen + extra
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
  20, 21, 22, 23, 24, 25,
  // Taekwon family
  4046, 4047, 4048, 4049,
  // Trans 1st/2nd
  4001, 4002, 4003, 4004, 4005, 4006, 4007, 4008, 4009, 4010, 4011, 4012,
  4013, 4014, 4015, 4016, 4017, 4018, 4019, 4020, 4021, 4022,
  // 3rd jobs + their trans + mounted forms
  4054, 4055, 4056, 4057, 4058, 4059, 4060, 4061, 4062, 4063, 4064, 4065,
  4066, 4067, 4068, 4069, 4070, 4071, 4072, 4073, 4074, 4075, 4076, 4077,
  4078, 4079, 4080, 4081, 4082, 4083, 4084, 4085, 4086, 4087,
  // 4th jobs + mounted forms
  4252, 4253, 4254, 4255, 4256, 4257, 4258, 4259, 4260, 4261, 4262, 4263,
  4264, 4302, 4303, 4307, 4308,
  // Summoner / Doram + odd misc
  4218, 4045,
];

async function fetchJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(path);
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

// Job names stay local: Divine Pride doesn't expose a server-localized job
// endpoint, and the GRF's `pcjobnamegender.lub` is the only source of strings
// like "Sentinela Trans" for the Latam server.
export async function loadReferenceDb(base = "./db"): Promise<ReferenceDb> {
  const job = await fetchJson<Record<string, JobInfo>>(`${base}/job.json`, {});

  // Compute once at load time — the underlying `job` map is immutable for
  // the session, so the result is too.
  const cachedClassIcons = computePcClassIcons(job);
  const cachedPcClassNames = [...cachedClassIcons.keys()].sort((a, b) =>
    a.localeCompare(b, "pt-BR"),
  );

  return {
    job,
    resolveMob: (id: number) => getMonsterName(id) ?? `mob#${id}`,
    resolveMobHp: (id: number) => getMonsterHp(id),
    resolveSkill: (id: number) => getSkillName(id) ?? `skill#${id}`,
    resolveJob: (id: number) => job[String(id)] ?? `job#${id}`,
    resolveItem: (id: number) => getItemName(id) ?? `item#${id}`,
    pcClassNames: () => cachedPcClassNames,
    pcClassIconId: (name: string) => cachedClassIcons.get(name),
  };
}

/**
 * Map each distinct pc class name to a representative view id (the first
 * `PC_JOB_IDS` entry resolving to it), used both for the dropdown list and
 * for picking which job sprite to show beside the name.
 */
function computePcClassIcons(job: Record<string, JobInfo>): Map<string, number> {
  const byName = new Map<string, number>();
  for (const id of PC_JOB_IDS) {
    const name = job[String(id)];
    // Drop the `job#<id>` fallback so alt-sprites missing from the GRF
    // don't clutter the list — base-class names cover them either way.
    if (name && !/^job#\d+$/.test(name) && !byName.has(name)) {
      byName.set(name, id);
    }
  }
  return byName;
}
