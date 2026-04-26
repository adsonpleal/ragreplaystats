export type MobInfo = { name: string; isBoss: boolean; lvl: number; hp?: number };
export type SkillInfo = { name: string };
export type JobInfo = string;

export type ReferenceDb = {
  mob: Record<string, MobInfo>;
  skill: Record<string, SkillInfo>;
  job: Record<string, JobInfo>;
  resolveMob(id: number): string;
  resolveMobHp(id: number): number;
  resolveSkill(id: number): string;
  resolveJob(id: number): string;
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
  const [mob, skill, job] = await Promise.all([
    fetchJson<Record<string, MobInfo>>(`${base}/mob.json`, {}),
    fetchJson<Record<string, SkillInfo>>(`${base}/skill.json`, {}),
    fetchJson<Record<string, JobInfo>>(`${base}/job.json`, {}),
  ]);

  return {
    mob,
    skill,
    job,
    resolveMob: (id: number) => mob[String(id)]?.name ?? `mob#${id}`,
    resolveMobHp: (id: number) => mob[String(id)]?.hp ?? 0,
    resolveSkill: (id: number) => skill[String(id)]?.name ?? `skill#${id}`,
    resolveJob: (id: number) => job[String(id)] ?? `job#${id}`,
  };
}
