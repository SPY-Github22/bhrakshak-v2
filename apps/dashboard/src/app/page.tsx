"use client";

import dynamic from "next/dynamic";
import { useState } from "react";

import { endpoints } from "@/lib/api";
import { useAppStore } from "@/store/useAppStore";

import { DossierDrawer } from "@/components/dossier/DossierDrawer";
import { LayerRail } from "@/components/map/LayerRail";
import { Legend } from "@/components/map/Legend";
import { RadarSlider } from "@/components/map/RadarSlider";
import { Button } from "@/components/ui/button";

const MapView = dynamic(() => import("@/components/map/MapView"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 grid place-items-center">
      <div className="flex flex-col items-center gap-3 text-muted">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-orange-500 border-t-transparent" />
        <span className="text-sm">loading terrain…</span>
      </div>
    </div>
  ),
});

export default function CommandCenter() {
  const setDemoMode = useAppStore((s) => s.setDemoMode);
  const demoMode = useAppStore((s) => s.demoMode);
  const [selectedLocation, setSelectedLocation] = useState<string>("Cherrapunji cut-slope area");
  const [injecting, setInjecting] = useState(false);

  const LOCATIONS = [
    { id: "Cherrapunji cut-slope area", label: "Cherrapunji Cut-Slope Area", district: "East Khasi Hills" },
    { id: "Gangtok highway sector", label: "Gangtok Highway Sector", district: "Gangtok" },
    { id: "Aizawl north slope", label: "Aizawl North Slope", district: "Aizawl" },
  ];

  async function injectStorm(locId?: string) {
    const locKey = locId || selectedLocation;
    const locConfig = LOCATIONS.find((l) => l.id === locKey) || LOCATIONS[0];
    setInjecting(true);
    try {
      const login = await fetch(`${endpoints.API}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@bhrakshak.in", password: "Admin@123" }),
      }).then((r) => r.json());
      await fetch(`${endpoints.API}/api/v1/demo/inject-rainfall-storm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.access_token}` },
        body: JSON.stringify({
          district: locConfig.district,
          location_name: locConfig.id,
          peak_mm_h: 55,
          hours: 3,
        }),
      });
      setDemoMode(true);
      setTimeout(() => window.location.reload(), 2200);
    } catch {
      alert("Storm injection failed — is the API up at :8000?");
    } finally {
      setInjecting(false);
    }
  }

  return (
    <>
      <MapView />
      <LayerRail />
      <Legend />

      {/* Demo control — target location injection selector */}
      <div className="anim anim-fade absolute bottom-4 left-3 z-10 flex flex-col gap-2 rounded-xl border border-orange-800 bg-panel/90 p-3 shadow-2xl shadow-black/50 backdrop-blur-md" style={{ animationDelay: "0.9s" }}>
        <div className="flex items-center gap-2">
          <select
            value={selectedLocation}
            onChange={(e) => setSelectedLocation(e.target.value)}
            disabled={injecting}
            className="rounded-lg border border-orange-700 bg-black/60 px-2 py-1.5 text-xs text-orange-200 focus:outline-none focus:ring-1 focus:ring-orange-500"
          >
            {LOCATIONS.map((loc) => (
              <option key={loc.id} value={loc.id}>
                📍 {loc.label}
              </option>
            ))}
          </select>

          <Button variant="primary" size="lg" onClick={() => injectStorm()} disabled={injecting}>
            {injecting ? (
              <span className="flex items-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                Injecting…
              </span>
            ) : (
              "⛈ Inject Rain"
            )}
          </Button>
        </div>

        <div className="flex items-center justify-between text-[11px] text-muted">
          <span>synthetic storm → live risk pipeline</span>
          {demoMode && (
            <span className="animate-pulse rounded bg-orange-900 px-1.5 py-0.5 font-bold text-orange-300">
              DEMO MODE
            </span>
          )}
        </div>
      </div>

      <RadarSlider />
      <DossierDrawer />
    </>
  );
}
