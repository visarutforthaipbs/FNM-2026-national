import { useContext } from "react";
import { WatchlistContext } from "../context/watchlistContextDefinition";

export interface WatchedFactoryItem {
  factory_id: string;
  notes?: string;
  created_at: string;
}

/**
 * Reads the single app-wide watchlist. State and syncing live in
 * WatchlistProvider — see the note there on why this cannot be a standalone
 * hook.
 */
export function useWatchlist() {
  const context = useContext(WatchlistContext);
  if (!context) {
    throw new Error("useWatchlist must be used within a WatchlistProvider");
  }
  return context;
}
