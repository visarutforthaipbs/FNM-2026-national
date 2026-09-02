import React, { useEffect, useState, useCallback } from "react";
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User as FirebaseUser,
} from "firebase/auth";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { auth, googleProvider, db, isFirebaseConfigured } from "../utils/firebaseClient";
import type { AuthUser, UserProfile } from "../types/auth";
import { AuthContext } from "./authContextDefinition";

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);

  const fetchOrCreateProfile = useCallback(
    async (userId: string, authUser: AuthUser) => {
      if (!isFirebaseConfigured) return;
      try {
        const profileRef = doc(db, "user_profiles", userId);
        const profileSnap = await getDoc(profileRef);

        if (profileSnap.exists()) {
          const data = profileSnap.data();
          setProfile({
            id: userId,
            email: data.email ?? authUser.email,
            full_name: data.full_name ?? authUser.displayName,
            avatar_url: data.avatar_url ?? authUser.photoURL,
            phone: data.phone ?? null,
            created_at: data.created_at?.toDate
              ? data.created_at.toDate().toISOString()
              : new Date().toISOString(),
          });
        } else {
          // Initialize user profile in Firestore
          const newProfile: UserProfile = {
            id: userId,
            email: authUser.email,
            full_name: authUser.displayName,
            avatar_url: authUser.photoURL,
            created_at: new Date().toISOString(),
          };
          await setDoc(profileRef, {
            email: authUser.email,
            full_name: authUser.displayName,
            avatar_url: authUser.photoURL,
            created_at: serverTimestamp(),
          });
          setProfile(newProfile);
        }
      } catch (err) {
        console.warn("Profile fetch/sync exception:", err);
      }
    },
    []
  );

  useEffect(() => {
    // Listen to Firebase auth state changes
    const unsubscribe = onAuthStateChanged(
      auth,
      async (firebaseUser: FirebaseUser | null) => {
        if (firebaseUser) {
          const authUser: AuthUser = {
            id: firebaseUser.uid,
            uid: firebaseUser.uid,
            email: firebaseUser.email,
            displayName: firebaseUser.displayName,
            photoURL: firebaseUser.photoURL,
            user_metadata: {
              full_name: firebaseUser.displayName || undefined,
              avatar_url: firebaseUser.photoURL || undefined,
            },
          };
          setUser(authUser);
          await fetchOrCreateProfile(firebaseUser.uid, authUser);
        } else {
          setUser(null);
          setProfile(null);
        }
        setIsLoading(false);
      },
      (error) => {
        console.warn("Firebase Auth error:", error);
        setIsLoading(false);
      }
    );

    return () => unsubscribe();
  }, [fetchOrCreateProfile]);

  const signInWithGoogle = useCallback(async () => {
    try {
      if (!isFirebaseConfigured) {
        alert(
          "⚠️ กรุณาระบุ Firebase Config ใน client/.env.local ก่อนใช้งานระบบล็อกอิน"
        );
        return { error: new Error("Firebase is not configured") };
      }
      await signInWithPopup(auth, googleProvider);
      return { error: null };
    } catch (err) {
      console.error("Firebase Google Sign-In error:", err);
      return { error: err instanceof Error ? err : new Error(String(err)) };
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await firebaseSignOut(auth);
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
