import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useAuth } from "./useAuth";
import {
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  writeBatch,
  serverTimestamp,
} from "firebase/firestore";
import { db, isFirebaseConfigured } from "../utils/firebaseClient";
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
 * One shared watchlist for the whole app backed by Cloud Firestore.
 * Local localStorage stars merge seamlessly into the account on sign-in.
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
   * Pull the account's list from Firestore and fold anything starred while
   * logged out into it.
   */
  const syncWithRemote = useCallback(async () => {
    if (!user || !isFirebaseConfigured) return;
    setIsLoading(true);
    try {
      const localFactories = readLocal<string>(LOCAL_STORAGE_WATCHLIST_KEY);
      const localIndustries = readLocal<number>(LOCAL_STORAGE_INDUSTRY_KEY);

      const [factoriesSnap, industriesSnap] = await Promise.all([
        getDocs(collection(db, "users", user.id, "factory_watchlist")),
        getDocs(collection(db, "users", user.id, "industry_watchlist")),
      ]);

      const remoteFactories = factoriesSnap.docs.map((d) => d.id);
      const pendingFactories = localFactories.filter((id) => !remoteFactories.includes(id));
      let mergedFactories = pendingFactories;

      if (pendingFactories.length > 0) {
        const batch = writeBatch(db);
        for (const factoryId of pendingFactories) {
          batch.set(doc(db, "users", user.id, "factory_watchlist", factoryId), {
            factoryId,
            createdAt: serverTimestamp(),
          });
        }
        try {
          await batch.commit();
        } catch (err) {
          console.error("Could not merge local factory watchlist:", err);
          mergedFactories = [];
        }
      }
      setFactories([...remoteFactories, ...mergedFactories]);

      const remoteIndustries = industriesSnap.docs.map((d) => Number(d.id)).filter((n) => !isNaN(n));
      const pendingIndustries = localIndustries.filter((code) => !remoteIndustries.includes(code));
      let mergedIndustries = pendingIndustries;

      if (pendingIndustries.length > 0) {
        const batch = writeBatch(db);
        for (const code of pendingIndustries) {
          batch.set(doc(db, "users", user.id, "industry_watchlist", String(code)), {
            industryCode: code,
            createdAt: serverTimestamp(),
          });
        }
        try {
          await batch.commit();
        } catch (err) {
          console.error("Could not merge local industry watchlist:", err);
          mergedIndustries = [];
        }
      }
      setIndustries([...remoteIndustries, ...mergedIndustries]);
    } catch (err) {
      console.error("Error syncing watchlist with Firestore:", err);
    } finally {
      setIsLoading(false);
    }
  }, [user, setFactories, setIndustries]);

  useEffect(() => {
    if (!user) {
      if (syncedUserId.current !== null) {
        // Sign-out: reset memory to what was on this device originally
        syncedUserId.current = null;
        setWatchedFactories(readLocal<string>(LOCAL_STORAGE_WATCHLIST_KEY));
        setWatchedIndustries(readLocal<number>(LOCAL_STORAGE_INDUSTRY_KEY));
      }
      return;
    }

    if (syncedUserId.current === user.id) return;
    syncedUserId.current = user.id;
    syncWithRemote();
  }, [user, syncWithRemote]);

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
        openAuthModal();
        return;
      }

      if (!isFirebaseConfigured) return;

      try {
        const factoryDocRef = doc(db, "users", user.id, "factory_watchlist", factoryId);
        if (wasWatched) {
          await deleteDoc(factoryDocRef);
        } else {
          await setDoc(factoryDocRef, {
            factoryId,
            notes: notes || null,
            createdAt: serverTimestamp(),
          });
        }
      } catch (err) {
        console.error("Could not update factory watchlist in Firestore:", err);
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

      if (!isFirebaseConfigured) return;

      try {
        const industryDocRef = doc(
          db,
          "users",
          user.id,
          "industry_watchlist",
          String(industryCode)
        );
        if (wasWatched) {
          await deleteDoc(industryDocRef);
        } else {
          await setDoc(industryDocRef, {
            industryCode,
            createdAt: serverTimestamp(),
          });
        }
      } catch (err) {
        console.error("Could not update industry watchlist in Firestore:", err);
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
      totalWatchedCount,
      isLoading,
      isFactoryWatched,
      isIndustryWatched,
      toggleWatchFactory,
      toggleWatchIndustry,
      refresh: syncWithRemote,
      refreshWatchlist: syncWithRemote,
    }),
    [
      watchedFactories,
      watchedIndustries,
      totalWatchedCount,
      isLoading,
      isFactoryWatched,
      isIndustryWatched,
      toggleWatchFactory,
      toggleWatchIndustry,
      syncWithRemote,
    ]
  );

  return (
    <WatchlistContext.Provider value={value}>
      {children}
    </WatchlistContext.Provider>
  );
};
