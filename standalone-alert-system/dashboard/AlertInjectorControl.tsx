"use client";

import React, { useState } from "react";
import { injectStorm, resetStorm } from "./api_client";

export function AlertInjectorControl() {
  const [injecting, setInjecting] = useState(false);
  const [location, setLocation] = useState("Cherrapunji cut-slope area");
  const [district, setDistrict] = useState("East Khasi Hills");

  const LOCATIONS = [
    { label: "📍 Cherrapunji Cut-Slope Area", id: "Cherrapunji cut-slope area", district: "East Khasi Hills" },
    { label: "📍 Gangtok Highway Sector", id: "Gangtok highway sector", district: "Gangtok" },
    { label: "📍 Aizawl North Slope", id: "Aizawl north slope", district: "Aizawl" },
  ];

  async function handleInject() {
    setInjecting(true);
    try {
      await injectStorm({
        district,
        location_name: location,
        peak_mm_h: 55,
        hours: 3,
      });
      alert(`⚡ Rain Injected successfully for ${location}! Check mobile phone.`);
    } catch (err: any) {
      alert(`Failed to inject rain: ${err.message}`);
    } finally {
      setInjecting(false);
    }
  }

  async function handleReset() {
    setInjecting(true);
    try {
      await resetStorm();
      alert("🧹 Storm Reset sent! All districts cleared.");
    } catch (err: any) {
      alert(`Failed to reset storm: ${err.message}`);
    } finally {
      setInjecting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-red-800 bg-black/90 p-4 shadow-xl text-white max-w-md">
      <h3 className="font-bold text-sm text-red-400">⛈ Emergency Alert Injection Control</h3>
      
      <select
        value={location}
        onChange={(e) => {
          const selected = LOCATIONS.find((l) => l.id === e.target.value);
          if (selected) {
            setLocation(selected.id);
            setDistrict(selected.district);
          }
        }}
        disabled={injecting}
        className="rounded border border-red-700 bg-neutral-900 px-3 py-1.5 text-xs text-red-200 outline-none"
      >
        {LOCATIONS.map((loc) => (
          <option key={loc.id} value={loc.id}>
            {loc.label}
          </option>
        ))}
      </select>

      <div className="flex gap-2">
        <button
          onClick={handleInject}
          disabled={injecting}
          className="flex-1 rounded bg-red-600 px-3 py-2 text-xs font-bold hover:bg-red-500 disabled:opacity-50"
        >
          {injecting ? "Injecting..." : "⛈ Inject Rain"}
        </button>

        <button
          onClick={handleReset}
          disabled={injecting}
          className="rounded border border-emerald-600 bg-emerald-950 px-3 py-2 text-xs text-emerald-300 hover:bg-emerald-900 disabled:opacity-50"
        >
          🧹 Reset All
        </button>
      </div>
    </div>
  );
}
