import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useAuth } from "./useAuth";
import { supabaseCitizen } from "../utils/supabaseClient";
import { WatchlistContext } from "./watchlistContextDefinition";

const LOCAL_STORAGE_WATCHLIST_KEY = "fnm_local_watched_factories";
const LOCAL_STORAGE_INDUSTRY_KEY = "fnm_local_watched_industries";

function readLocal<T>(key: string): T[] {
  try {
    const stored = localStorage.getItem(key);
    const parsed = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function writeLocal(key: string, value: unknown[]) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or private-mode failures are not worth breaking the UI over */
  }
}

/**
 * One shared watchlist for the whole app. This has to be a provider rather than
 * a plain hook: FactoryCard renders it once per card (up to 200 in a province),
 * and independent copies meant 200 duplicate fetches on sign-in plus a navbar
 * badge that disagreed with the star the user just clicked.
 */
export const WatchlistProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { user, openAuthModal } = useAuth();
  const [watchedFactories, setWatchedFactories] = useState<string[]>(() =>
    readLocal<string>(LOCAL_STORAGE_WATCHLIST_KEY)
  );
  const [watchedIndustries, setWatchedIndustries] = useState<number[]>(() =>
    readLocal<number>(LOCAL_STORAGE_INDUSTRY_KEY)
  );
  const [isLoading, setIsLoading] = useState(false);

  // Which account the in-memory list belongs to, so we can tell a fresh sign-in
  // from a re-render and a sign-out from the initial anonymous state.
  const syncedUserId = useRef<string | null>(null);

  const setFactories = useCallback((next: string[]) => {
    setWatchedFactories(next);
    writeLocal(LOCAL_STORAGE_WATCHLIST_KEY, next);
  }, []);

  const setIndustries = useCallback((next: number[]) => {
    setWatchedIndustries(next);
    writeLocal(LOCAL_STORAGE_INDUSTRY_KEY, next);
  }, []);

  /**
   * Pull the account's list and fold anything starred while logged out into it.
   * The old code overwrote local state with the remote list, which silently
   * threw away everything the user starred before signing in — the exact list
   * the auth prompt promised to save.
   */
  const syncWithRemote = useCallback(async () => {
    if (!user) return;
    setIsLoading(true);
    try {
      const localFactories = readLocal<string>(LOCAL_STORAGE_WATCHLIST_KEY);
      const localIndustries = readLocal<number>(LOCAL_STORAGE_INDUSTRY_KEY);

      const [factoriesRes, industriesRes] = await Promise.all([
        supabaseCitizen
          .from("user_factory_watchlist")
          .select("factory_id")
          .eq("user_id", user.id),
        supabaseCitizen
          .from("user_industry_watchlist")
          .select("industry_code")
          .eq("user_id", user.id),
      ]);

      if (factoriesRes.error) {
        console.error("Could not load factory watchlist:", factoriesRes.error.message);
      } else {
        const remote = (factoriesRes.data ?? []).map((r) => r.factory_id as string);
        const pending = localFactories.filter((id) => !remote.includes(id));
        let merged = pending;

        if (pending.length > 0) {
          // One batch insert, so a single bad row (an id with no matching
          // factory) fails the lot — fall back to the server's list rather
          // than showing stars that were never saved.
          const { error } = await supabaseCitizen.from("user_factory_watchlist").insert(
            pending.map((factory_id) => ({ user_id: user.id, factory_id }))
          );
          if (error) {
            console.error("Could not merge local factory watchlist:", error.message);
            merged = [];
          }
        }
        setFactories([...remote, ...merged]);
      }

      if (industriesRes.error) {
        console.error("Could not load industry watchlist:", industriesRes.error.message);
      } else {
        const remote = (industriesRes.data ?? []).map(
          (r) => r.industry_code as number
        );
        const pending = localIndustries.filter((code) => !remote.includes(code));
        let merged = pending;

        if (pending.length > 0) {
          const { error } = await supabaseCitizen.from("user_industry_watchlist").insert(
            pending.map((industry_code) => ({ user_id: user.id, industry_code }))
          );
          if (error) {
            console.error("Could not merge local industry watchlist:", error.message);
            merged = [];
          }
        }
        setIndustries([...remote, ...merged]);
      }
    } catch (err) {
      console.error("Error syncing watchlist:", err);
    } finally {
      setIsLoading(false);
    }
  }, [user, setFactories, setIndustries]);

  useEffect(() => {
    if (user) {
      if (syncedUserId.current !== user.id) {
        syncedUserId.current = user.id;
        syncWithRemote();
      }
      return;
    }

    // Signed out: drop the previous account's list from memory *and* from
    // localStorage. Leaving it behind showed the next person on a shared
    // device which factories the previous user was watching.
    if (syncedUserId.current !== null) {
      syncedUserId.current = null;
      setFactories([]);
      setIndustries([]);
    }
  }, [user, syncWithRemote, setFactories, setIndustries]);

  const isFactoryWatched = useCallback(
    (factoryId: string) => watchedFactories.includes(factoryId),
    [watchedFactories]
  );

  const isIndustryWatched = useCallback(
    (industryCode: number) => watchedIndustries.includes(industryCode),
    [watchedIndustries]
  );

  const toggleWatchFactory = useCallback(
    async (factoryId: string, notes?: string) => {
      const wasWatched = watchedFactories.includes(factoryId);
      const previous = watchedFactories;
      const next = wasWatched
        ? watchedFactories.filter((id) => id !== factoryId)
        : [...watchedFactories, factoryId];

      setFactories(next);

      if (!user) {
        // Kept locally so the click is not lost; syncWithRemote folds it into
        // the account on sign-in.
        openAuthModal();
        return;
      }

      // supabase-js resolves with an `error` field rather than throwing, so a
      // try/catch here would never fire — an RLS denial used to leave the star
      // lit with nothing saved.
      const { error } = wasWatched
        ? await supabaseCitizen
            .from("user_factory_watchlist")
            .delete()
            .eq("user_id", user.id)
            .eq("factory_id", factoryId)
        : await supabaseCitizen.from("user_factory_watchlist").insert({
            user_id: user.id,
            factory_id: factoryId,
            notes: notes || null,
          });

      if (error) {
        console.error("Could not update factory watchlist:", error.message);
        setFactories(previous);
      }
    },
    [watchedFactories, user, openAuthModal, setFactories]
  );

  const toggleWatchIndustry = useCallback(
    async (industryCode: number) => {
      const wasWatched = watchedIndustries.includes(industryCode);
      const previous = watchedIndustries;
      const next = wasWatched
        ? watchedIndustries.filter((c) => c !== industryCode)
        : [...watchedIndustries, industryCode];

      setIndustries(next);

      if (!user) {
        openAuthModal();
        return;
      }

      const { error } = wasWatched
        ? await supabaseCitizen
            .from("user_industry_watchlist")
            .delete()
            .eq("user_id", user.id)
            .eq("industry_code", industryCode)
        : await supabaseCitizen.from("user_industry_watchlist").insert({
            user_id: user.id,
            industry_code: industryCode,
          });

      if (error) {
        console.error("Could not update industry watchlist:", error.message);
        setIndustries(previous);
      }
    },
    [watchedIndustries, user, openAuthModal, setIndustries]
  );

  const totalWatchedCount = watchedFactories.length + watchedIndustries.length;

  const value = useMemo(
    () => ({
      watchedFactories,
      watchedIndustries,
      isFactoryWatched,
      isIndustryWatched,
      toggleWatchFactory,
      toggleWatchIndustry,
      totalWatchedCount,
      isLoading,
      refresh: syncWithRemote,
    }),
    [
      watchedFactories,
      watchedIndustries,
      isFactoryWatched,
      isIndustryWatched,
      toggleWatchFactory,
      toggleWatchIndustry,
      totalWatchedCount,
      isLoading,
      syncWithRemote,
    ]
  );

  return (
    <WatchlistContext.Provider value={value}>{children}</WatchlistContext.Provider>
  );
};
