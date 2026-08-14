import { createContext } from "react";

export interface WatchlistContextType {
  watchedFactories: string[];
  watchedIndustries: number[];
  isFactoryWatched: (factoryId: string) => boolean;
  isIndustryWatched: (industryCode: number) => boolean;
  toggleWatchFactory: (factoryId: string, notes?: string) => Promise<void>;
  toggleWatchIndustry: (industryCode: number) => Promise<void>;
  totalWatchedCount: number;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

export const WatchlistContext = createContext<WatchlistContextType | undefined>(
  undefined
);
