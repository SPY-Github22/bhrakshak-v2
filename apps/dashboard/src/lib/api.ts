function getApiUrl(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  if (typeof window !== "undefined" && window.location.protocol === "https:") {
    return "https://bhrakshak-api-demo.loca.lt";
  }
  return "http://localhost:8000";
}

export const endpoints = {
  get API() {
    return getApiUrl();
  },
  MARTIN: process.env.NEXT_PUBLIC_MARTIN_URL ?? "http://localhost:3001",
};

// ---- dashboard session (real JWT instead of hardcoded credentials) ----
const TOKEN_KEY = "bhrakshak_dash_token";
const EMAIL_KEY = "bhrakshak_dash_email";

export interface DashSession {
  token: string;
  email: string;
}

export function getSession(): DashSession | null {
  if (typeof window === "undefined") return null;
  const token = localStorage.getItem(TOKEN_KEY);
  const email = localStorage.getItem(EMAIL_KEY);
  return token && email ? { token, email } : null;
}

export async function login(email: string, password: string): Promise<DashSession> {
  const res = await fetch(`${getApiUrl()}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Bypass-Tunnel-Remainder": "true" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Login failed (${res.status})`);
  const data = await res.json();
  const session: DashSession = { token: data.access_token, email };
  localStorage.setItem(TOKEN_KEY, session.token);
  localStorage.setItem(EMAIL_KEY, email);
  return session;
}

export function logout(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EMAIL_KEY);
}

/** Returns a valid token, logging in with the seeded demo admin when no
 *  session exists. Demo-mode convenience: the API itself enforces RBAC, and
 *  the credentials are the publicly documented demo logins, not a secret. */
export async function ensureToken(): Promise<string> {
  const existing = getSession();
  if (existing) return existing.token;
  const s = await login("admin@bhrakshak.in", "Admin@123");
  return s.token;
}

export async function apiGet<T>(path: string, token?: string): Promise<T> {
  const baseUrl = getApiUrl();
  const headers: Record<string, string> = {
    "Bypass-Tunnel-Remainder": "true",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${baseUrl}${path}`, {
    headers,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`API ${res.status} on ${path}`);
  return res.json() as Promise<T>;
}

// ---- offline-safe fixture fallbacks (venue WiFi proof) ----
export const FIXTURE_KPIS = {
  zones_l3_l4: 3,
  alerts_today: 5,
  pending_reports: 12,
  sensors_online: 4,
  total_zones: 45,
};

import type { Driver } from "./types";

export const FIXTURE_DRIVERS: Driver[] = [
  { feature: "72h Antecedent Rain", name: "72h Antecedent Saturation", value: "312.4 mm", val_num: 312.4, contribution: 0.38, description: "Deep subsurface pore-pressure accumulation" },
  { feature: "1h Flash Intensity", name: "1h Peak Downpour", value: "28.5 mm/h", val_num: 28.5, contribution: 0.26, description: "Rapid surface runoff triggering shear failure" },
  { feature: "Slope & Susceptibility", name: "Terrain Susceptibility Index", value: "78.4 / 100", val_num: 78.4, contribution: 0.22, description: "Steep cut-slope morphology and weak lithology" },
  { feature: "Soil Saturation", name: "Soil Moisture Level", value: "86.2%", val_num: 86.2, contribution: 0.14, description: "Topsoil saturation approaching liquid limit" },
];

export const FIXTURE_RAINFALL = Array.from({ length: 48 }, (_, i) => ({
  ts: new Date(Date.now() - (47 - i) * 3600_000).toISOString(),
  rain_1h: Math.max(0, Math.sin(i / 6) * 8 + i * 0.35),
  rain_24h: 40 + i * 2.2,
}));
