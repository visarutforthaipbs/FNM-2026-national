import React, { useEffect, useState, useCallback } from "react";
import type { User } from "@supabase/supabase-js";
import { supabaseCitizen } from "../utils/supabaseClient";
import type { UserProfile } from "../types/auth";
import { AuthContext } from "./authContextDefinition";

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);

  const fetchProfile = useCallback(async (userId: string) => {
    try {
      const { data, error } = await supabaseCitizen
        .from("user_profiles")
        .select("*")
        .eq("id", userId)
        .maybeSingle();

      if (error) {
        console.warn("Could not fetch user profile:", error.message);
        return;
      }

      if (data) {
        setProfile(data as UserProfile);
      }
    } catch (err) {
      console.warn("Profile fetch exception:", err);
    }
  }, []);

  useEffect(() => {
    // Check initial session
    supabaseCitizen.auth.getSession().then(({ data: { session } }) => {
      const currentUser = session?.user ?? null;
      setUser(currentUser);
      if (currentUser) {
        fetchProfile(currentUser.id);
      }
      setIsLoading(false);
    });

    // Subscribe to auth state changes
    const {
      data: { subscription },
    } = supabaseCitizen.auth.onAuthStateChange(async (_event, session) => {
      const currentUser = session?.user ?? null;
      setUser(currentUser);
      if (currentUser) {
        fetchProfile(currentUser.id);
      } else {
        setProfile(null);
      }
      setIsLoading(false);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [fetchProfile]);

  const signInWithGoogle = useCallback(async () => {
    try {
      const { error } = await supabaseCitizen.auth.signInWithOAuth({
        provider: "google",
        options: {
          // Full href, not origin + pathname: ?province=/?factory=/?type= are
          // the app's sharing mechanism, and dropping them landed anyone who
          // signed in from a shared factory link back on a blank map.
          redirectTo: window.location.href,
          queryParams: {
            access_type: "offline",
            prompt: "consent",
          },
        },
      });
      return { error };
    } catch (err) {
      return { error: err instanceof Error ? err : new Error(String(err)) };
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await supabaseCitizen.auth.signOut();
      setUser(null);
      setProfile(null);
    } catch (err) {
      console.error("Sign out error:", err);
    }
  }, []);

  const openAuthModal = useCallback(() => setIsAuthModalOpen(true), []);
  const closeAuthModal = useCallback(() => setIsAuthModalOpen(false), []);

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        isLoading,
        signInWithGoogle,
        signOut,
        isAuthModalOpen,
        openAuthModal,
        closeAuthModal,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
