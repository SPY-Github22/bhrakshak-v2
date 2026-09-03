"use client";

import { useAppStore, type Horizon } from "@/store/useAppStore";

import { DISTRICT_VIEWS } from "./MapView";

const LAYERS: { key: string; label: string; hint?: string }[] = [
  { key: "risk", label: "Hazard now (Model B)" },
  { key: "rainfall", label: "Precipitation Radar (IMD/ERA5)" },
  { key: "terrain", label: "Terrain relief (3D hillshade)" },
  { key: "susceptibility", label: "Susceptibility (Model A)" },
  { key: "roads", label: "Road status (NH-29 / NH-102)" },
  { key: "detours", label: "Emergency Detours & Blockages" },
  { key: "shelters", label: "Relief Camps & Hospitals" },
  { key: "reports", label: "Citizen reports" },
  { key: "deformation", label: "Deformation (InSAR)", hint: "LiCSAR AOIs — ML phase" },
];

const HORIZONS: { key: Horizon; label: string }[] = [
  { key: "now", label: "NOW" },
  { key: "f24", label: "+24h" },
  { key: "f48", label: "+48h" },
  { key: "f72", label: "+72h" },
];

export function LayerRail() {
  const layers = useAppStore((s) => s.layers);
  const toggleLayer = useAppStore((s) => s.toggleLayer);
  const horizon = useAppStore((s) => s.horizon);
  const setHorizon = useAppStore((s) => s.setHorizon);

  const flyTo = (center: number[], zoom: number) => {
    (window as unknown as { __flyTo?: (c: number[], z: number) => void }).__flyTo?.(center, zoom);
  };

  return (
    <div className="anim anim-fade absolute left-3 top-16 z-10 w-64 space-y-3 rounded-xl border border-white/5 bg-panel/80 p-3 shadow-2xl shadow-black/40 backdrop-blur-md" style={{ animationDelay: "0.7s" }}>
      <div>
        <div className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-muted">
          Forecast scrubber
        </div>
        <div className="flex gap-1 rounded-lg bg-bg p-1">
          {HORIZONS.map((h) => (
            <button
              key={h.key}
              onClick={() => setHorizon(h.key)}
              className={`flex-1 rounded-md px-1 py-1.5 text-[11px] font-semibold transition-all ${
                horizon === h.key
                  ? "bg-orange-600 text-white shadow"
                  : "text-muted hover:bg-edge hover:text-ink"
              }`}
            >
              {h.label}
            </button>
          ))}
        </div>
        {horizon !== "now" && horizon !== 0 && (
          <p className="mt-1.5 text-[10px] leading-tight text-yellow-600">
            {String(horizon).toUpperCase()} surface — Model B forecast fusion lands in ML phase
          </p>
        )}
      </div>

      <div>
        <div className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-muted">
          Layers
        </div>
        <div className="space-y-0.5">
          {LAYERS.map((l) => {
            const disabled = Boolean(l.hint);
            const on = layers[l.key] ?? false;
            return (
              <button
                key={l.key}
                disabled={disabled}
                onClick={() => !disabled && toggleLayer(l.key)}
                title={l.hint}
                className={`flex w-full items-center justify-between rounded-lg px-2 py-2 text-[13px] transition-colors ${
                  disabled ? "cursor-not-allowed opacity-40" : "hover:bg-edge"
                }`}
              >
                <span>{l.label}</span>
                <span
                  className={`relative h-4 w-7 rounded-full transition-colors ${
                    on ? "bg-orange-500" : "bg-edge"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
                      on ? "left-3.5" : "left-0.5"
                    }`}
                  />
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-muted">
          Pilot districts
        </div>
        <div className="grid grid-cols-2 gap-1">
          {DISTRICT_VIEWS.map((d) => (
            <button
              key={d.name}
              onClick={() => flyTo(d.center, d.zoom)}
              className="rounded-lg border border-edge bg-bg px-2 py-1.5 text-[11px] font-medium text-slate-300 transition-colors hover:border-orange-700 hover:text-white"
            >
              {d.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
