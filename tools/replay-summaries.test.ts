import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Run the hook's effect with real events, timers, API decoding and shared cache.
// Capture state writes without requiring a DOM renderer in this Node test suite.
const hook = vi.hoisted(() => ({
  states: [] as unknown[],
  cleanups: [] as Array<() => void>,
}));

vi.mock("react", () => ({
  useState(initial: unknown) {
    const index = hook.states.length;
    hook.states.push(typeof initial === "function" ? initial() : initial);
    return [hook.states[index], (value: unknown) => { hook.states[index] = value; }];
  },
  useEffect(effect: () => () => void) {
    hook.cleanups.push(effect());
  },
}));

let cache: typeof import("../src/replay-summaries");
let useReplaySummaries: typeof import("../src/hooks/useReplaySummaries").useReplaySummaries;
let page: EventTarget & { visibilityState: string };
let tab: EventTarget;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function response(id: string) {
  return Response.json({
    items: [{ id, uploadedAt: 1_791_698_393_152, recordedAt: null, mvpRecords: [] }],
  });
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
  hook.states = [];
  hook.cleanups = [];
  page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  tab = Object.assign(new EventTarget(), {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  });
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", tab);
  fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response("august"));
  vi.stubGlobal("fetch", fetchMock);
  cache = await import("../src/replay-summaries");
  ({ useReplaySummaries } = await import("../src/hooks/useReplaySummaries"));
});

afterEach(() => {
  hook.cleanups.forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("replay list freshness", () => {
  it("updates a visible leaderboard after the TTL without remounting", async () => {
    useReplaySummaries();
    await settle();
    expect(hook.states[0]).toMatchObject([{ id: "august" }]);

    fetchMock.mockResolvedValue(response("october"));
    await vi.advanceTimersByTimeAsync(cache.STALE_MS);

    expect(hook.states[0]).toMatchObject([{ id: "october" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/replays", { cache: "no-cache" });
  });

  it("also schedules updates when the initial list was already cached", async () => {
    await cache.ensureLoaded();
    useReplaySummaries();
    await settle();
    expect(hook.states[1]).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue(response("october"));
    await vi.advanceTimersByTimeAsync(cache.STALE_MS);
    expect(hook.states[0]).toMatchObject([{ id: "october" }]);
  });

  it.each(["focus", "pageshow", "visibilitychange"])(
    "refreshes stale data on %s but coalesces concurrent wake events",
    async (event) => {
      useReplaySummaries();
      await settle();
      vi.setSystemTime(Date.now() + cache.STALE_MS);
      fetchMock.mockResolvedValue(response("october"));

      const target = event === "visibilitychange" ? page : tab;
      target.dispatchEvent(new Event(event));
      tab.dispatchEvent(new Event("focus"));
      page.dispatchEvent(new Event("visibilitychange"));
      await settle();

      expect(hook.states[0]).toMatchObject([{ id: "october" }]);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      tab.dispatchEvent(new Event("focus"));
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("pauses network updates while hidden and catches up on return", async () => {
    useReplaySummaries();
    await settle();
    page.visibilityState = "hidden";
    fetchMock.mockResolvedValue(response("october"));
    await vi.advanceTimersByTimeAsync(cache.STALE_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(hook.states[0]).toMatchObject([{ id: "october" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains rows during a background fetch and retries after failure", async () => {
    useReplaySummaries();
    await settle();
    vi.setSystemTime(Date.now() + cache.STALE_MS);
    let rejectFetch!: (reason: Error) => void;
    fetchMock.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectFetch = reject;
    }));
    tab.dispatchEvent(new Event("focus"));
    expect(hook.states[0]).toMatchObject([{ id: "august" }]);
    expect(hook.states[1]).toBe(false);

    rejectFetch(new Error("offline"));
    await settle();
    expect(hook.states[2]).toBe("offline");

    fetchMock.mockResolvedValue(response("october"));
    tab.dispatchEvent(new Event("focus"));
    await settle();
    expect(hook.states[0]).toMatchObject([{ id: "october" }]);
    expect(hook.states[2]).toBeNull();
  });

  it("removes listeners and timers and ignores a pending fetch on unmount", async () => {
    let resolveFetch!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    useReplaySummaries();
    hook.cleanups.forEach((cleanup) => cleanup());
    const previousState = [...hook.states];

    resolveFetch(response("october"));
    await settle();
    tab.dispatchEvent(new Event("focus"));
    tab.dispatchEvent(new Event("pageshow"));
    page.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(cache.STALE_MS * 2);

    expect(hook.states).toEqual(previousState);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
