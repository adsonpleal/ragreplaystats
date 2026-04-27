export type MobInfo = { name: string; isBoss: boolean; lvl: number; hp?: number };
export type SkillInfo = { name: string };
export type JobInfo = string;
export type ItemInfo = string;
export type EfstInfo = { name: string };

export type ReferenceDb = {
  mob: Record<string, MobInfo>;
  skill: Record<string, SkillInfo>;
  job: Record<string, JobInfo>;
  item: Record<string, ItemInfo>;
  efst: Record<string, EfstInfo>;
  resolveMob(id: number): string;
  resolveMobHp(id: number): number;
  resolveSkill(id: number): string;
  resolveJob(id: number): string;
  resolveItem(id: number): string;
  resolveStatus(id: number): string;
};

async function fetchJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(path);
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

export async function loadReferenceDb(base = "./db"): Promise<ReferenceDb> {
  const [mob, skill, job, item, efst] = await Promise.all([
    fetchJson<Record<string, MobInfo>>(`${base}/mob.json`, {}),
    fetchJson<Record<string, SkillInfo>>(`${base}/skill.json`, {}),
    fetchJson<Record<string, JobInfo>>(`${base}/job.json`, {}),
    fetchJson<Record<string, ItemInfo>>(`${base}/item.json`, {}),
    fetchJson<Record<string, EfstInfo>>(`${base}/efst.json`, {}),
  ]);

  return {
    mob,
    skill,
    job,
    item,
    efst,
    resolveMob: (id: number) => mob[String(id)]?.name ?? `mob#${id}`,
    resolveMobHp: (id: number) => mob[String(id)]?.hp ?? 0,
    resolveSkill: (id: number) => skill[String(id)]?.name ?? `skill#${id}`,
    resolveJob: (id: number) => job[String(id)] ?? `job#${id}`,
    resolveItem: (id: number) => {
      const raw = item[String(id)];
      // GRF item names use underscores in place of spaces.
      return raw ? raw.replace(/_/g, " ") : `item#${id}`;
    },
    resolveStatus: (id: number) => efst[String(id)]?.name ?? `efst#${id}`,
  };
}
