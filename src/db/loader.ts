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

// Job names stay local: Divine Pride doesn't expose a server-localized job
// endpoint, and the GRF's `pcjobnamegender.lub` is the only source of strings
// like "Sentinela Trans" for the Latam server.
export async function loadReferenceDb(base = "./db"): Promise<ReferenceDb> {
  const job = await fetchJson<Record<string, JobInfo>>(`${base}/job.json`, {});

  return {
    job,
    resolveMob: (id: number) => getMonsterName(id) ?? `mob#${id}`,
    resolveMobHp: (id: number) => getMonsterHp(id),
    resolveSkill: (id: number) => getSkillName(id) ?? `skill#${id}`,
    resolveJob: (id: number) => job[String(id)] ?? `job#${id}`,
    resolveItem: (id: number) => getItemName(id) ?? `item#${id}`,
  };
}
