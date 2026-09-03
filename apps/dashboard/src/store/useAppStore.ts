"use client";
// Global client state (zustand) — auth, view routing, map layer/filter state.
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type View = "command" | "operations" | "analytics" | "pwa";

export interface Layers {
  susceptibility: boolean;
  hazard: boolean;
  radar: boolean;
  creep: boolean;
  population: boolean;
  [key: string]: boolean;
}

export interface FlyTarget {
  center: [number, number];
  zoom: number;
  label?: string;
}

interface AppState {
  token: string | null;
  role: string | null;
  email: string | null;
  fullName: string | null;
  district: string | null; // district_admin scope
  view: View;
  theme: "dark" | "light";
  selectedZoneId: string | null;
  districtFilter: string | null; // map filter
  horizon: 0 | 24 | 48 | 72 | string;
  radarStep: number;
  radarPlaying: boolean;
  demoMode: boolean;
  flyTarget: FlyTarget | null;
  layers: Layers;
  setAuth: (a: Partial<Pick<AppState, "token" | "role" | "email" | "fullName" | "district">>) => void;
  logout: () => void;
  setView: (v: View) => void;
  setTheme: (t: "dark" | "light") => void;
  selectZone: (id: string | null) => void;
  setDistrictFilter: (d: string | null) => void;
  setHorizon: (h: 0 | 24 | 48 | 72 | string) => void;
  setRadarStep: (s: number) => void;
  toggleRadarPlaying: () => void;
  setDemoMode: (v: boolean) => void;
  setFlyTarget: (target: FlyTarget | null) => void;
  toggleLayer: (k: string) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      token: null,
      role: null,
      email: null,
      fullName: null,
      district: null,
      view: "command",
      theme: "dark",
      selectedZoneId: null,
      districtFilter: null,
      horizon: 0,
      radarStep: 6,
      radarPlaying: false,
      demoMode: false,
      flyTarget: null,
      layers: {
        susceptibility: false,
        hazard: true,
        radar: true,
        creep: true,
        population: false,
      },
      setAuth: (a) => set(a),
      logout: () => set({ token: null, role: null, email: null, fullName: null, district: null, view: "command", selectedZoneId: null }),
      setView: (v) => set({ view: v, selectedZoneId: null }),
      setTheme: (t) => set({ theme: t }),
      selectZone: (id) => set({ selectedZoneId: id }),
      setDistrictFilter: (d) => set({ districtFilter: d }),
      setHorizon: (h) => set({ horizon: h }),
      setRadarStep: (s) => set({ radarStep: s }),
      toggleRadarPlaying: () => set((st) => ({ radarPlaying: !st.radarPlaying })),
      setDemoMode: (v) => set({ demoMode: v }),
      setFlyTarget: (flyTarget) => set({ flyTarget }),
      toggleLayer: (k) => set((st) => ({ layers: { ...st.layers, [k]: !st.layers[k] } })),
    }),
    {
      name: "bhu-store-v2",
      partialize: (s) => ({
        token: s.token, role: s.role, email: s.email,
        fullName: s.fullName, district: s.district, view: s.view,
      }),
    },
  ),
);

export const LEVEL_COLORS = ["#0E9F6E", "#22C55E", "#EAB308", "#F97316", "#EF4444"];
export const LEVEL_LABELS = ["L0 Normal", "L1 Watch", "L2 Alert", "L3 Warning", "L4 Emergency"];

/** ECharts axis/tooltip palette aligned with the active M3 color scheme. */
export function chartPalette(theme: "dark" | "light") {
  return theme === "dark"
    ? { text: "#C1C9BE", dim: "#8B938A", line: "#414941", tipBg: "#252B27", tipText: "#DEE3DB" }
    : { text: "#414941", dim: "#71796F", line: "#C1C9BE", tipBg: "#E5E8DE", tipText: "#191C19" };
}
