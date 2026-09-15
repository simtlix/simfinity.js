"use client";

import React, { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { getAccessToken, clearTokens, setTokens } from "@/lib/authStorage";
import { type AuthUser } from "@/lib/authApi";

interface AuthContextType {
  user: AuthUser | null;
  login: (accessToken: string, refreshToken: string, user: AuthUser) => void;
  logout: () => void;
  isOwner: boolean;
  isAdmin: boolean;
  isClient: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const base64 = token.split(".")[1];
    if (!base64) return null;
    const json = atob(base64.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Canonical Mongo user id from access token (backend sets `sub` in registerMutations.signTokens). */
function userIdFromPayload(payload: Record<string, unknown>): string {
  const sub = payload.sub;
  const userId = payload.userId;
  if (typeof sub === "string" && sub.length > 0) return sub;
  if (typeof userId === "string" && userId.length > 0) return userId;
  return "";
}

function userFromToken(token: string | null): AuthUser | null {
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const exp = payload.exp as number | undefined;
  if (exp && Date.now() / 1000 > exp) return null;
  const id = userIdFromPayload(payload);
  if (!id) return null;
  return {
    id,
    email: payload.email as string ?? "",
    name: payload.name as string ?? null,
    role: payload.role as string ?? null,
  };
}

function getInitialUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  return userFromToken(getAccessToken());
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(getInitialUser);

  const login = useCallback((accessToken: string, refreshToken: string, authUser: AuthUser) => {
    setTokens(accessToken, refreshToken);
    const fromJwt = userFromToken(accessToken);
    if (fromJwt?.id) {
      setUser({
        ...authUser,
        id: fromJwt.id,
        email: fromJwt.email || authUser.email,
        name: fromJwt.name ?? authUser.name,
        role: fromJwt.role ?? authUser.role,
      });
    } else {
      setUser(authUser);
    }
  }, []);

  const logout = useCallback(() => {
    clearTokens();
    setUser(null);
  }, []);

  const role = user?.role ?? "";
  const isOwner = role === "OWNER";
  const isAdmin = role === "PLATFORM_ADMIN";
  const isClient = role === "CLIENT" || !role;

  return (
    <AuthContext.Provider value={{ user, login, logout, isOwner, isAdmin, isClient }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
