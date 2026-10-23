import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import "./_localstorage-stub.ts";
import { findEpisodeInSeasons } from "../src/lib/tracker-resolve/match.ts";
import { resolveEpisode } from "../src/lib/tracker-resolve/resolve.ts";
import { clearResolved } from "../src/lib/tracker-resolve/cache.ts";

function load(path: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: any = {};
  new Function("require", "exports", ...Object.keys(globals), code)(
    (id: string) => {
      assert.ok(id in mocks, `Unexpected import: ${id}`);
      return mocks[id];
    },
    exports,
    ...Object.values(globals),
  );
  return exports;
}

function commits() {
  let profile = "a",
    session: any = { username: "a" };
  const calls: string[] = [];
  let stop: any = async () => "failed",
    mark: any = async () => true;
  let resolve: any = async () => ({ ok: false, reason: "not-found" });
  const api = load("src/lib/trakt/resolve.ts", {
    "@/lib/active-profile-id": { activeProfileId: () => profile },
    "./session": { getSession: () => session },
    "@/lib/cinemeta": {},
    "./ids": {},
    "@/lib/tracker-resolve/special": { resolveSpecialMovie: async () => null },
    "@/lib/tracker-resolve": {
      resolveForMeta: (...args: any[]) => {
        calls.push("resolve");
        return resolve(...args);
      },
      resolvedToTraktTarget: (e: any) => ({
        kind: "episode",
        show: { ids: e.showIds },
        season: e.season,
        number: e.number,
      }),
    },
    "./history": {
      pushWatched: (...args: any[]) => {
        calls.push("history");
        return mark(...args);
      },
    },
    "./scrobble": {
      scrobbleStop: (...args: any[]) => {
        calls.push("stop");
        return stop(...args);
      },
    },
  });
  return {
    api,
    calls,
    setStop: (f: any) => (stop = f),
    setMark: (f: any) => (mark = f),
    setResolve: (f: any) => (resolve = f),
    switch: () => {
      profile = "b";
      session = { username: "b" };
    },
  };
}
const movie = { kind: "movie", ids: { imdb: "tt123" } };
const episode = { kind: "episode", show: { ids: { imdb: "tt123" } }, season: 1, number: 2 };

test("movie completion still reaches Trakt and falls back to history", async () => {
  const h = commits();
  assert.equal(await h.api.commitWatchedEpisode(movie, "tt123", 100), "recorded");
  assert.deepEqual(h.calls, ["stop", "history"]);
});
test("an interrupted movie never becomes a completed history entry", async () => {
  const h = commits();
  assert.equal(await h.api.commitWatchedEpisode(movie, "tt123", 20), "failed");
  assert.deepEqual(h.calls, ["stop"]);
});
test("an unconfirmed catalog miss remains retryable", async () => {
  const h = commits();
  h.setMark(async () => false);
  assert.equal(await h.api.commitWatchedEpisode(episode, "tt123", 100), "failed");
});
test("profile switch during a stop cannot start fallback writes on the next account", async () => {
  const h = commits();
  h.setStop(async () => {
    h.switch();
    return "failed";
  });
  assert.equal(await h.api.commitWatchedEpisode(episode, "tt123", 100), "failed");
  assert.deepEqual(h.calls, ["stop"]);
});
test("profile switch during catalog resolution cannot send a resolved watch", async () => {
  const h = commits();
  h.setMark(async () => false);
  h.setResolve(async () => {
    h.switch();
    return { ok: true, episode: { showIds: { imdb: "tt456" }, season: 3, number: 2 } };
  });
  assert.equal(await h.api.commitWatchedEpisode(episode, "tt123", 100), "failed");
  assert.deepEqual(h.calls, ["stop", "history", "resolve"]);
});
test("a renumbered episode retries the verified target", async () => {
  const h = commits();
  const targets: any[] = [];
  h.setStop(async (t: any) => {
    targets.push(t);
    return t.season === 3 ? "recorded" : "failed";
  });
  h.setMark(async () => false);
  h.setResolve(async () => ({
    ok: true,
    episode: { showIds: { imdb: "tt456" }, season: 3, number: 2 },
  }));
  assert.equal(await h.api.commitWatchedEpisode(episode, "tt123", 100), "recorded");
  assert.equal(targets[1].show.ids.imdb, "tt456");
  assert.equal(targets[1].season, 3);
});
test("same-day episode batches are not guessed; an exact title disambiguates them", () => {
  const seasons = [
    {
      number: 1,
      episodes: [
        { number: 1, title: "First arrival", airDate: "2026-01-01" },
        { number: 2, title: "Final farewell", airDate: "2026-01-01" },
      ],
    },
  ];
  const identity = { showTitle: "Test", season: 8, number: 2, airDate: "2026-01-01" };
  assert.equal(findEpisodeInSeasons(identity, seasons), null);
  assert.deepEqual(findEpisodeInSeasons({ ...identity, name: "Final farewell" }, seasons), {
    season: 1,
    number: 2,
  });
});
test("exact episode ids can match a season beyond the nearby-season window", () => {
  assert.deepEqual(
    findEpisodeInSeasons({ showTitle: "Test", season: 1, number: 1, episodeTvdbId: 50 }, [
      { number: 15, episodes: [{ number: 7, tvdbId: 50 }] },
    ]),
    { season: 15, number: 7 },
  );
});
test("a similarly named show cannot win through its release date alone", async () => {
  clearResolved();
  const out = await resolveEpisode(
    { showTitle: "Twin Peaks", showYear: 2017, season: 1, number: 1, airDate: "2017-05-21" },
    {
      searchShows: async () => [
        { showIds: { imdb: "tt999" }, title: "Twin Peaks Aftershow", year: 2017 },
      ],
      fetchShowSeasons: async () => [
        { number: 1, episodes: [{ number: 1, airDate: "2017-05-21" }] },
      ],
    },
  );
  assert.equal(out.ok, false);
});
test("new episode identity does not reuse an old same-title cache entry", async () => {
  clearResolved();
  const identity = { showTitle: "Test", showYear: 2026, season: 1, number: 1 };
  const deps = {
    searchShows: async () => [{ showIds: { imdb: "tt100" }, title: "Test", year: 2026 }],
    fetchShowSeasons: async () => [
      {
        number: 1,
        episodes: [
          { number: 1, tvdbId: 1 },
          { number: 2, tvdbId: 2 },
        ],
      },
    ],
  };
  const one = await resolveEpisode({ ...identity, episodeTvdbId: 1 }, deps);
  const two = await resolveEpisode({ ...identity, episodeTvdbId: 2 }, deps);
  assert.equal(one.ok && one.episode.number, 1);
  assert.equal(two.ok && two.episode.number, 2);
});
test("history success requires an acknowledged write, not HTTP success alone", async () => {
  let response: any = { not_found: { episodes: [{}] } };
  const api = load("src/lib/trakt/history.ts", {
    "./client": { traktRequest: async () => response },
    "./session": {},
    "./watched-keys": {},
    "@/lib/active-profile-id": {},
  });
  assert.equal(await api.pushWatched(episode), false);
  response = { added: { episodes: 1 } };
  assert.equal(await api.pushWatched(episode), true);
});

test("Simkl must acknowledge the requested episodes, not merely find their show", async () => {
  let response: any = { added: { shows: 1, episodes: 0 }, not_found: { episodes: [{}] } };
  const session = { username: "a" };
  const api = load("src/lib/simkl/history.ts", {
    "@/lib/active-profile-id": { activeProfileId: () => "a" },
    "./session": { getSession: () => session },
    "@/lib/tracker-resolve": {},
    "./activities/gate": {},
    "./ids": { simklTargetIds: (t: any) => t.ids },
    "./client": { simklRequest: async () => response },
  });
  assert.equal(await api.markEpisodesWatched({ imdb: "tt100" }, 1, [1]), false);
  response = { added: { episodes: 1 } };
  assert.equal(await api.markEpisodesWatched({ imdb: "tt100" }, 1, [1]), true);
  assert.equal(await api.markEpisodesWatched({ imdb: "tt100" }, 1, [1, 2]), false);

  // When /scrobble/stop already marked a movie or episode watched moments earlier,
  // Simkl's /sync/history returns added: 0 with empty not_found and resolved statuses.
  response = {
    added: {
      movies: 0,
      shows: 0,
      episodes: 0,
      statuses: [{ response: { status: "completed", simkl_type: "movie" } }],
    },
    not_found: { movies: [], shows: [], episodes: [] },
  };
  assert.equal(await api.addToHistory({ kind: "movie", ids: { imdb: "tt37281055" } }), true);
  assert.equal(await api.markEpisodesWatched({ imdb: "tt100" }, 1, [1]), true);

  response = {
    added: { movies: 0, shows: 0, episodes: 0, statuses: [] },
    not_found: { movies: [{ ids: { imdb: "tt9999999" } }], shows: [], episodes: [] },
  };
  assert.equal(await api.addToHistory({ kind: "movie", ids: { imdb: "tt9999999" } }), false);
});

test("Simkl stop scrobble treats 409 Conflict as already recorded", async () => {
  class SimklApiError extends Error {
    status: number;
    constructor(status: number) {
      super(`HTTP ${status}`);
      this.status = status;
    }
  }
  const session = { username: "a" };
  let status = 409;
  const api = load("src/lib/simkl/scrobble.ts", {
    "@/lib/active-profile-id": { activeProfileId: () => "a" },
    "./session": { getSession: () => session },
    "@/lib/tracker-resolve": { resolveForMeta: async () => ({ ok: false }) },
    "./scrobble-body": {
      buildBody: () => ({ progress: 100, movie: { ids: { imdb: "tt37281055" } } }),
      buildEpisodeBody: () => ({}),
    },
    "./client": {
      SimklApiError,
      simklRequest: async () => {
        throw new SimklApiError(status);
      },
    },
  });
  assert.equal(await api.simklScrobble("stop", "tt37281055", undefined, 100), true);
  assert.equal(await api.simklScrobble("pause", "tt37281055", undefined, 50), false);
  status = 500;
  assert.equal(await api.simklScrobble("stop", "tt37281055", undefined, 100), false);
});
test("Trakt's cached history accepts empty success and stays with its account", () => {
  const data = new Map();
  let session: any = { username: "alice" };
  const api = load(
    "src/lib/trakt/watched-keys.ts",
    {
      "./session": { getSession: () => session },
      "@/lib/active-profile-id": { activeProfileId: () => "a" },
    },
    {
      localStorage: {
        getItem: (k: string) => data.get(k),
        setItem: (k: string, v: string) => data.set(k, v),
      },
    },
  );
  api.rememberTraktWatched(new Set(["imdb:tt100:1:1"]));
  assert.equal(api.peekTraktWatched().size, 1);
  session = { username: "bob" };
  assert.equal(api.peekTraktWatched().size, 0);
  session = { username: "alice" };
  api.rememberTraktWatched(new Set());
  assert.equal(api.peekTraktWatched().size, 0);
});
test("Simkl preserves cached history on failure, clears it on empty success and isolates delayed replies", async () => {
  const data = new Map();
  let reset: () => void;
  let marker = "one";
  let response: any = {
    shows: [
      {
        status: "watching",
        show: { ids: { imdb: "tt100" } },
        seasons: [{ number: 1, episodes: [{ number: 1, watched_at: "2026-01-01" }] }],
      },
    ],
  };
  let session: any = { username: "alice" };
  const api = load(
    "src/lib/simkl/list-status.ts",
    {
      "./session": { getSession: () => session, subscribeSession: (f: any) => (reset = f) },
      "@/lib/active-profile-id": { activeProfileId: () => "a" },
      "./activities/gate": { currentActivitiesAll: async () => marker },
      "./ids": {},
      "./client": {
        simklRequest: async () => {
          if (response instanceof Error) throw response;
          return response;
        },
      },
    },
    {
      localStorage: {
        getItem: (k: string) => data.get(k),
        setItem: (k: string, v: string) => data.set(k, v),
      },
    },
  );
  await api.loadSimklWatchedMap();
  assert.equal(api.peekSimklWatchedMap().size, 1);
  marker = "two";
  response = new Error("offline");
  await assert.rejects(api.loadSimklWatchedMap(), /offline/);
  assert.equal(api.peekSimklWatchedMap().size, 1);
  response = null;
  await api.loadSimklWatchedMap();
  assert.equal(api.peekSimklWatchedMap().size, 0);
  marker = "three";
  let release: any;
  response = new Promise((resolve) => (release = resolve));
  const old = api.loadSimklWatchedMap();
  await Promise.resolve();
  await Promise.resolve();
  session = { username: "bob" };
  reset!();
  release({ shows: [] });
  await assert.rejects(old, /session changed/);
  assert.equal(api.peekSimklWatchedMap().size, 0);
});

test("Simkl fallback returns actual outcomes and stops after its account changes", async () => {
  let session: any = { username: "a" },
    known = true,
    confirmed = false,
    switchDuring = false;
  let resolutions = 0;
  const api = load("src/lib/simkl/record-watched.ts", {
    "@/lib/active-profile-id": { activeProfileId: () => "a" },
    "./session": { getSession: () => session },
    "./ids": {
      stremioIdToSimklTarget: () => (known ? { ok: true, target: episode } : { ok: false }),
      resolveSimklEpisodeTarget: async () => null,
    },
    "./history": {
      markEpisodesWatched: async () => {
        if (switchDuring) session = { username: "b" };
        return confirmed;
      },
      addToHistory: async () => confirmed,
    },
    "@/lib/tracker-resolve": {
      resolveForMeta: async () => {
        resolutions++;
        return { ok: false, reason: "not-found" };
      },
    },
  });
  known = false;
  assert.equal(await api.recordWatchedFallback("tt123"), false);
  known = true;
  confirmed = true;
  assert.equal(await api.recordWatchedFallback("tt123"), true);
  confirmed = false;
  assert.equal(await api.recordWatchedFallback("tt123"), false);
  assert.equal(resolutions, 1);
  switchDuring = true;
  assert.equal(await api.recordWatchedFallback("tt123"), false);
  assert.equal(resolutions, 1);
});

test("Simkl fallback retries with cour-scoped anime target when IMDb show season is split on Simkl", async () => {
  const session = { username: "a" };
  const calls: Array<{ ids: any; season: number; eps: number[] }> = [];
  const api = load("src/lib/simkl/record-watched.ts", {
    "@/lib/active-profile-id": { activeProfileId: () => "a" },
    "./session": { getSession: () => session },
    "./ids": {
      stremioIdToSimklTarget: (id: string, ep: any) =>
        id.startsWith("tt") && ep
          ? {
              ok: true,
              target: {
                kind: "episode",
                show: { ids: { imdb: id } },
                season: ep.season,
                number: ep.episode,
              },
            }
          : { ok: false, reason: "anime" },
      resolveSimklEpisodeTarget: async (id: string, ep: any, fallbackImdb?: string) => {
        if (fallbackImdb) {
          return {
            kind: "episode",
            show: { ids: { imdb: fallbackImdb } },
            season: ep.imdbSeason ?? ep.season,
            number: ep.imdbEpisode ?? ep.episode,
          };
        }
        return {
          kind: "anime-episode",
          anime: { ids: { kitsu: Number(id.split(":")[1]) } },
          season: ep.season || 1,
          number: ep.episode,
        };
      },
    },
    "./history": {
      markEpisodesWatched: async (ids: any, season: number, eps: number[]) => {
        calls.push({ ids, season, eps });
        return Boolean(ids.kitsu);
      },
      addToHistory: async () => false,
    },
    "@/lib/tracker-resolve": {
      resolveForMeta: async () => ({ ok: false, reason: "not-found" }),
    },
  });
  const ok = await api.recordWatchedFallback(
    "kitsu:47640",
    { season: 1, episode: 3, imdbSeason: 5, imdbEpisode: 3 },
    { imdb: "tt0388629" },
  );
  assert.equal(ok, true);
  assert.deepEqual(calls, [
    { ids: { imdb: "tt0388629" }, season: 5, eps: [3] },
    { ids: { kitsu: 47640 }, season: 1, eps: [3] },
  ]);

  calls.length = 0;
  const parentCourOk = await api.recordWatchedFallback(
    "kitsu:45398",
    { season: 1, episode: 3, sourceMetaId: "kitsu:45619", imdbSeason: 5, imdbEpisode: 3 },
    { imdb: "tt0388629" },
  );
  assert.equal(parentCourOk, true);
  assert.deepEqual(calls, [
    { ids: { imdb: "tt0388629" }, season: 5, eps: [3] },
    { ids: { kitsu: 45619 }, season: 1, eps: [3] },
  ]);

  calls.length = 0;
  const streamCourOk = await api.recordWatchedFallback("tt0388629", {
    season: 5,
    episode: 3,
    kitsuStreamId: "kitsu:47640:3",
  });
  assert.equal(streamCourOk, true);
  assert.deepEqual(calls, [
    { ids: { imdb: "tt0388629" }, season: 5, eps: [3] },
    { ids: { kitsu: 47640 }, season: 1, eps: [3] },
  ]);

  calls.length = 0;
  const longRunningStreamOk = await api.recordWatchedFallback("tt0388629", {
    season: 21,
    episode: 45,
    kitsuStreamId: "kitsu:12:1089",
  });
  assert.equal(longRunningStreamOk, true);
  assert.deepEqual(calls, [
    { ids: { imdb: "tt0388629" }, season: 21, eps: [45] },
    { ids: { kitsu: 12 }, season: 1, eps: [1089] },
  ]);
});


for (const service of ["anilist", "mal"]) {
  test(`${service}: legacy sent cache expires, unconfirmed writes retry, confirmed ticks deduplicate`, async () => {
    const data = new Map();
    const base = `harbor.${service}.synced.v1.a`,
      key = `${service}:1|1|2`;
    data.set(base, JSON.stringify({ [key]: 2 }));
    let writes = 0,
      confirmed = false,
      profile = "a";
    let session: any = { userName: "a" };
    let switchDuring = false;
    const request = async (_query: any, options: any) => {
      const write =
        service === "anilist"
          ? typeof _query === "string" && _query.startsWith("mutation")
          : options?.method === "PATCH";
      if (write) {
        writes++;
        return service === "anilist"
          ? { SaveMediaListEntry: confirmed ? { progress: 2 } : null }
          : confirmed
            ? { num_episodes_watched: 2 }
            : null;
      }
      if (switchDuring) {
        profile = "b";
        session = { userName: "b" };
      }
      return service === "anilist"
        ? { Media: { id: 1, episodes: 12, mediaListEntry: { progress: 0, status: "CURRENT" } } }
        : { num_episodes: 12, my_list_status: { num_episodes_watched: 0, status: "watching" } };
    };
    const api = load(
      `src/lib/${service}/sync.ts`,
      {
        "@/lib/active-profile-id": { activeProfileId: () => profile },
        "@/lib/providers/anime-mapping": {},
        "./mutations": { resolveMalMediaId: async () => 1 },
        "./session": { isAuthenticated: () => true, getSession: () => session },
        "./client":
          service === "anilist"
            ? { anilistRequest: request, AnilistApiError: class extends Error {} }
            : { malRequest: request, MalApiError: class extends Error {} },
      },
      {
        localStorage: {
          getItem: (k: string) => data.get(k),
          setItem: (k: string, v: string) => data.set(k, v),
        },
      },
    );
    const sync = service === "anilist" ? api.syncAnimeProgress : api.syncMalProgress;
    await sync(`${service}:1`, 2, "Fixture", 1);
    assert.equal(writes, 1);
    confirmed = true;
    await sync(`${service}:1`, 2, "Fixture", 1);
    assert.equal(writes, 2);
    await sync(`${service}:1`, 2, "Fixture", 1);
    assert.equal(writes, 2);
    data.set(base, JSON.stringify({ [key]: { p: 2, t: Date.now() - 61000 } }));
    await sync(`${service}:1`, 2, "Fixture", 1);
    assert.equal(writes, 3);
    data.delete(base);
    switchDuring = true;
    await sync(`${service}:1`, 2, "Fixture", 1);
    assert.equal(writes, 3);
    assert.equal(data.has(`harbor.${service}.synced.v1.b`), false);
  });
}
