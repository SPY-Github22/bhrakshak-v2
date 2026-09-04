/* Rescuer-side UI: "People Nearby".
   Drop into any React app: <PeopleNearbyPanel apiUrl="https://api…" token={jwt} />
   Self-contained — inline styles with theme-variable fallbacks, no CSS import,
   no external deps beyond React. Owns its NearbyService lifecycle. */

import { useEffect, useRef, useState } from "react";

import { formatAge, formatDistance, compassArrow } from "../geo.ts";
import { DEFAULT_RADIUS_M, MAX_RADIUS_M } from "../config.ts";
import { NearbyService } from "../nearbyService.ts";
import { bleScanSupported } from "../transports/bleTransport.ts";
import { PeerNavigator, requestCompassPermission } from "./PeerNavigator";
import type { PeerInfo } from "../types.ts";
import type { SelfPos } from "./PeerNavigator";

const RADII = [250, 500, 1000, 3000];

export const ROLE_BADGE: Record<string, { bg: string; fg: string; label: string }> = {
  citizen: { bg: "rgba(250,204,21,.14)", fg: "#facc15", label: "CITIZEN" },
  field: { bg: "rgba(56,189,248,.14)", fg: "#38bdf8", label: "FIELD" },
  relay: { bg: "rgba(167,139,250,.16)", fg: "#a78bfa", label: "RELAY" },
};

export function PeopleNearbyPanel({
  apiUrl,
  token,
  radiusM = DEFAULT_RADIUS_M,
  className,
}: {
  apiUrl?: string;
  token?: string | null;
  radiusM?: number;
  className?: string;
}) {
  const [running, setRunning] = useState(false);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [radius, setRadius] = useState(Math.min(radiusM, MAX_RADIUS_M));
  const [targetId, setTargetId] = useState<string | null>(null);
  const [selfPos, setSelfPos] = useState<SelfPos | null>(null);
  const svcRef = useRef<NearbyService | null>(null);
  const radiusRef = useRef(radius);
  radiusRef.current = radius;

  useEffect(() => () => svcRef.current?.stop(), []);

  /* keep self position fresh while navigating so the arrow tracks movement */
  useEffect(() => {
    if (!targetId) return;
    const id = setInterval(() => {
      const p = svcRef.current?.status().position ?? null;
      setSelfPos(p);
    }, 1_000);
    return () => clearInterval(id);
  }, [targetId]);

  async function toggle() {
    if (svcRef.current?.status().running) {
      svcRef.current.stop();
      setRunning(false);
      setMsg("Scan stopped");
      return;
    }
    if (!svcRef.current) {
      const svc = new NearbyService({
        role: "field",
        apiUrl: apiUrl ?? null,
        getToken: () => token ?? null,
        scan: true,
        radiusM: radiusRef.current,
        log: setMsg,
      });
      svc.store.subscribe(setPeers);
      svcRef.current = svc;
    }
    await svcRef.current.start();
    setRunning(true);
    setMsg("Searching for nearby citizens…");
  }

  async function changeRadius(r: number) {
    setRadius(r);
    if (svcRef.current?.status().running) setMsg(`Radius → ${r} m (applies next query tick)`);
  }

  async function navigate(id: string) {
    // iOS needs the compass permission inside this user gesture
    await requestCompassPermission();
    const p = svcRef.current?.status().position ?? null;
    setSelfPos(p);
    setTargetId(id);
  }

  const navigating = targetId != null;

  const needHelp = peers.filter((p) => p.needsHelp);
  const ble = bleScanSupported();


  return (
    <section className={className} style={{
      background: "var(--md-surface, #141a24)", border: "1px solid var(--md-outline, rgba(255,255,255,.08))",
      borderRadius: "var(--md-radius-l, 18px)", padding: "15px 16px",
    }}>
      <h3 style={{ display: "flex", alignItems: "center", gap: 9, margin: "0 0 4px", fontSize: 15, fontWeight: 800 }}>
        <span style={{ display: "grid", placeItems: "center", width: 32, height: 32, borderRadius: 10, background: "rgba(56,189,248,.13)", color: "#38bdf8" }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="10" r="2.6" /><path d="M12 21c4-4.5 6.5-7.6 6.5-11a6.5 6.5 0 1 0-13 0C5.5 13.4 8 16.5 12 21Z" />
          </svg>
        </span>
        People Nearby
        {running && <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 800, letterSpacing: ".07em", background: "rgba(52,211,153,.14)", color: "#34d399", borderRadius: 999, padding: "3px 9px" }}>LIVE</span>}
      </h3>
      <p style={{ fontSize: 12, color: "var(--md-on-surface-variant, #94a3b8)", margin: "0 0 10px" }}>
        Citizens running this app who switched on <i>“Help rescuers find me”</i> — over Wi-Fi/data plus BLE beacons when you get close.
        Ephemeral IDs only, never phone numbers.
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <button onClick={() => void toggle()} className="md-pressable" style={{
          border: "none", borderRadius: 999, padding: "8px 16px", fontSize: 12.5, fontWeight: 800, cursor: "pointer",
          background: running ? "rgba(248,113,113,.14)" : "#38bdf8", color: running ? "#f87171" : "#06121f",
        }}>
          {running ? "■ Stop scan" : "Find nearby people"}
        </button>
        <select value={radius} onChange={(e) => void changeRadius(Number(e.target.value))} className="md-pressable"
          style={{ background: "var(--md-surface-2, #1c2531)", color: "var(--md-on-surface, #e2e8f0)", border: "1px solid var(--md-outline, rgba(255,255,255,.1))", borderRadius: 999, padding: "7px 10px", fontSize: 12, outline: "none" }}>
          {RADII.map((r) => <option key={r} value={r}>within {r} m</option>)}
        </select>
        <span style={{ fontSize: 10.5, color: "var(--md-on-surface-variant, #94a3b8)" }}>
          {["wifi", ble ? "ble" : null].filter(Boolean).join(" + ")}
        </span>
      </div>

      {(peers.length > 0 || running) && (
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          {[
            { label: "Nearby", v: peers.length, c: "#38bdf8" },
            { label: "Need help", v: needHelp.length, c: "#f87171" },
            { label: "Via BLE", v: peers.filter((p) => p.source === "ble").length, c: "#a3e635" },
          ].map((k) => (
            <div key={k.label} style={{ flex: 1, background: "var(--md-surface-2, #1c2531)", borderRadius: 12, padding: "8px 11px" }}>
              <div style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".07em", color: "var(--md-on-surface-variant, #94a3b8)", fontWeight: 700 }}>{k.label}</div>
              <div style={{ fontSize: 19, fontWeight: 800, color: k.c }}>{k.v}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {navigating && targetId && (
          <PeerNavigator peers={peers} targetId={targetId} selfPos={selfPos} onExit={() => setTargetId(null)} />
        )}
        {peers.map((p) => {
          const badge = ROLE_BADGE[p.role] ?? ROLE_BADGE.citizen;
          return (
            <div key={p.peerId} role="button" tabIndex={0} onClick={() => void navigate(p.peerId)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") void navigate(p.peerId); }}
              className="md-pressable" style={{
                display: "flex", alignItems: "center", gap: 11, background: "var(--md-surface-2, #1c2531)",
                border: p.needsHelp ? "1px solid rgba(248,113,113,.5)" : "1px solid transparent",
                borderRadius: 12, padding: "9px 12px", cursor: "pointer",
              }}>
              <span style={{ fontSize: 17, width: 20, textAlign: "center", color: p.needsHelp ? "#f87171" : "var(--md-on-surface, #e2e8f0)" }}>
                {compassArrow(p.bearingDeg)}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <b style={{ fontSize: 13 }}>{p.alias}</b>
                  <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: ".06em", background: badge.bg, color: badge.fg, borderRadius: 999, padding: "2px 7px" }}>{badge.label}</span>
                  {p.needsHelp && <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: ".06em", background: "rgba(248,113,113,.18)", color: "#f87171", borderRadius: 999, padding: "2px 7px" }}>SOS</span>}
                  <span style={{ fontSize: 9, fontWeight: 700, color: "var(--md-on-surface-variant, #94a3b8)" }}>{p.source === "ble" ? "BLE" : "WIFI"}</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--md-on-surface-variant, #94a3b8)", marginTop: 2 }}>
                  seen {formatAge(Date.now() - p.lastSeen)}
                  {p.batteryPct != null && <> · battery {p.batteryPct}%</>}
                  {p.accuracyM != null && p.accuracyM > 0 && <> · ±{p.accuracyM} m</>}
                </div>
              </div>
              <b style={{ fontSize: 13.5, color: p.needsHelp ? "#f87171" : "#38bdf8", whiteSpace: "nowrap" }}>{formatDistance(p.distanceM)}</b>
              <span style={{ fontSize: 12, color: "var(--md-on-surface-variant, #94a3b8)" }}>›</span>
            </div>
          );
        })}
        {running && peers.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--md-on-surface-variant, #94a3b8)", padding: "8px 4px" }}>
            No consenting app users in range yet… keep moving toward the crowd.
          </div>
        )}
        {navigating && !targetId && (
          <div style={{ fontSize: 11.5, color: "var(--md-on-surface-variant, #94a3b8)", padding: "6px 4px" }}>
            Tap a person above to navigate to them.
          </div>
        )}
      </div>

      {msg && <div style={{ marginTop: 9, fontSize: 11.5, color: "#38bdf8" }}>{msg}</div>}
    </section>
  );
}
