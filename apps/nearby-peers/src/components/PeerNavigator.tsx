/* PeerNavigator — "walk me to this person" HUD for the rescuer.

   Big arrow that points AT the person (compass bearing to them minus the
   phone's own magnetometer heading — Google-Maps-compass-style), distance
   countdown, vibration sonar that buzzes harder as you close in, RSSI
   warm/cold meter for buried phones without a GPS fix, screen wake-lock,
   and OSM/native-maps handoff when exact coordinates exist.

   No map tiles, no routing engine, no new dependencies — it must work with
   the screen half-visible, gloves on, and zero network. */

import { useEffect, useRef, useState } from "react";

import {
  bearingTo, distanceTo, guidanceText, geoIntentUrl, osmPinUrl,
  relativeBearing, rssiWarmth, sonarPulseMs,
} from "../navigation.ts";
import { formatAge, formatDistance } from "../geo.ts";
import { ROLE_BADGE } from "./PeopleNearbyPanel";
import { NearbyTacticalMap } from "./NearbyTacticalMap";
import type { PeerInfo } from "../types.ts";

export interface SelfPos {
  lat: number;
  lon: number;
  accuracyM: number | null;
}

/** iOS 13+ requires the compass permission request inside a user gesture —
      call this from the tap that opens navigation. No-op elsewhere. */
export async function requestCompassPermission(): Promise<boolean> {
  const DOE = (globalThis as any).DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === "function") {
    try {
      return (await DOE.requestPermission()) === "granted";
    } catch {
      return false;
    }
  }
  return true;
}

/** Magnetometer heading (degrees clockwise from North) while active. */
export function useDeviceHeading(active: boolean): { heading: number | null; live: boolean } {
  const [heading, setHeading] = useState<number | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!active) return;
    let got = false;
    const handler = (ev: any) => {
      // iOS: webkitCompassHeading (already clockwise-from-north). Android
      // absolute: alpha is counter-clockwise, so invert. Plain alpha events
      // are relative — still usable, just less trustworthy.
      const h =
        typeof ev.webkitCompassHeading === "number" ? ev.webkitCompassHeading :
        typeof ev.alpha === "number" ? ((360 - ev.alpha) % 360 + 360) % 360 : null;
      if (h != null && !Number.isNaN(h)) {
        got = true;
        setLive(true);
        setHeading(h);
      }
    };
    window.addEventListener("deviceorientationabsolute" as any, handler as any, true);
    window.addEventListener("deviceorientation" as any, handler as any, true);
    const t = setTimeout(() => { if (!got) setLive(false); }, 3_000);
    return () => {
      window.removeEventListener("deviceorientationabsolute" as any, handler as any, true);
      window.removeEventListener("deviceorientation" as any, handler as any, true);
      clearTimeout(t);
    };
  }, [active]);

  return { heading, live };
}

/** Keep the screen awake while navigating. */
function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let lock: any = null;
    const acquire = async () => {
      try { lock = await (navigator as any).wakeLock?.request("screen"); } catch { /* unsupported */ }
    };
    void acquire();
    const onVis = () => { if (document.visibilityState === "visible") void acquire(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      try { lock?.release(); } catch { /* already released */ }
    };
  }, [active]);
}


const SONAR_INTERVAL_MS = 1_200;

export function PeerNavigator({
  peers,
  targetId,
  selfPos,
  onExit,
}: {
  /** Live snapshots from the PeopleNearbyPanel's store subscription. */
  peers: PeerInfo[];
  targetId: string;
  selfPos: SelfPos | null;
  onExit: () => void;
}) {
  const live = peers.find((p) => p.peerId === targetId) ?? null;
  // Hold the last-known sighting when the peer goes silent (TTL swept).
  const lastKnownRef = useRef<PeerInfo | null>(null);
  if (live) lastKnownRef.current = live;
  const target = live ?? lastKnownRef.current;
  const lost = live == null;

  const { heading, live: compassLive } = useDeviceHeading(true);
  useWakeLock(true);

  const [displayMode, setDisplayMode] = useState<"needle" | "map">("needle");
  const [sonarOn, setSonarOn] = useState(true);
  const distRef = useRef<number | null>(null);
  const prevRssiRef = useRef<number | null>(null);

  const targetBearing = target ? bearingTo(selfPos, target) : null;
  const dist = target ? distanceTo(selfPos, target) : null;
  distRef.current = dist;
  const rel = relativeBearing(targetBearing, heading);
  const warmth = rssiWarmth(prevRssiRef.current, target?.rssi ?? null);
  if (target?.rssi != null) prevRssiRef.current = target.rssi;

  /* sonar: 1.2 s cadence, buzz length grows as distance shrinks */
  useEffect(() => {
    const id = setInterval(() => {
      if (!sonarOn) return;
      const d = distRef.current;
      const ms = sonarPulseMs(d);
      if (ms > 0) navigator.vibrate?.(ms);
      if (d != null && d < 25) navigator.vibrate?.([ms, 90, ms]); // double-pulse when close
    }, SONAR_INTERVAL_MS);
    return () => { clearInterval(id); navigator.vibrate?.(0); };
  }, [sonarOn]);

  if (!target) return null;

  const badge = ROLE_BADGE[target.role] ?? ROLE_BADGE.citizen;
  const hasCoords = target.lat != null && target.lon != null;
  const rssiPct = target.rssi == null ? 0 : Math.max(0, Math.min(100, ((target.rssi + 100) / 60) * 100));
  const warmthColor = warmth === "warmer" ? "#34d399" : warmth === "colder" ? "#f87171" : "var(--md-on-surface-variant, #94a3b8)";

  /* radar blip radius: log-scaled so 20 m and 400 m are both visible */
  const R = 86;
  const frac = dist == null ? 1 : Math.min(1, Math.log10(1 + dist) / Math.log10(1 + Math.max(dist * 1.3, 120)));
  const blipR = R * frac;
  const blip = (
    <g style={{ transform: `rotate(${rel.relativeDeg}deg)`, transformOrigin: "87px 87px", transition: "transform .25s linear" }}>
      <circle cx="87" cy={87 - blipR} r="5.5" fill={target.needsHelp ? "#f87171" : "#38bdf8"} />
      {target.needsHelp && <circle cx="87" cy={87 - blipR} r="9.5" fill="none" stroke="#f87171" strokeWidth="1.4" opacity=".7" />}
    </g>
  );

  return (
    <div style={{
      background: "linear-gradient(180deg, rgba(56,189,248,.06), transparent 40%), var(--md-surface, #141a24)",
      border: `1px solid ${lost ? "rgba(250,204,21,.45)" : target.needsHelp ? "rgba(248,113,113,.55)" : "rgba(56,189,248,.4)"}`,
      borderRadius: "var(--md-radius-l, 18px)", padding: "14px 15px", marginBottom: 10,
    }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <b style={{ fontSize: 14 }}>{target.alias}</b>
        <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: ".06em", background: badge.bg, color: badge.fg, borderRadius: 999, padding: "2px 7px" }}>{badge.label}</span>
        {target.needsHelp && <span style={{ fontSize: 9, fontWeight: 800, background: "rgba(248,113,113,.18)", color: "#f87171", borderRadius: 999, padding: "2px 7px" }}>SOS</span>}

        {/* Needle vs Tactical Map toggle */}
        <div style={{ marginLeft: "auto", display: "flex", gap: 2, background: "rgba(255,255,255,.07)", borderRadius: 999, padding: 2 }}>
          <button
            type="button"
            onClick={() => setDisplayMode("needle")}
            className="md-pressable"
            style={{
              border: "none",
              borderRadius: 999,
              padding: "3px 8px",
              fontSize: 10.5,
              fontWeight: 700,
              background: displayMode === "needle" ? "#38bdf8" : "transparent",
              color: displayMode === "needle" ? "#06121f" : "var(--md-on-surface-variant, #94a3b8)",
              cursor: "pointer",
            }}
          >
            🧭 Arrow
          </button>
          <button
            type="button"
            onClick={() => setDisplayMode("map")}
            className="md-pressable"
            style={{
              border: "none",
              borderRadius: 999,
              padding: "3px 8px",
              fontSize: 10.5,
              fontWeight: 700,
              background: displayMode === "map" ? "#38bdf8" : "transparent",
              color: displayMode === "map" ? "#06121f" : "var(--md-on-surface-variant, #94a3b8)",
              cursor: "pointer",
            }}
          >
            🗺️ Radar
          </button>
        </div>

        <button onClick={onExit} className="md-pressable" style={{ border: "none", background: "rgba(248,113,113,.14)", color: "#f87171", borderRadius: 999, padding: "5px 12px", fontSize: 11.5, fontWeight: 800, cursor: "pointer" }}>
          ✕ Stop
        </button>
      </div>

      {lost && (
        <div style={{ fontSize: 11.5, fontWeight: 700, color: "#facc15", background: "rgba(250,204,21,.1)", border: "1px solid rgba(250,204,21,.35)", borderRadius: 10, padding: "7px 10px", marginBottom: 8 }}>
          ⚠ Signal lost — showing last known position. Sweep past the arrow direction first.
        </div>
      )}


      {/* compass + radar or tactical map */}
      {displayMode === "map" ? (
        <NearbyTacticalMap
          peers={peers}
          selfPos={selfPos}
          heading={heading}
          selectedPeerId={target.peerId}
          height={300}
        />
      ) : (
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div style={{
            position: "relative", width: 174, height: 174, flexShrink: 0, borderRadius: "50%",
            background: "radial-gradient(circle, rgba(56,189,248,.08), transparent 70%), var(--md-surface-2, #1c2531)",
            border: "1px solid var(--md-outline, rgba(255,255,255,.1))",
          }}>
            {/* fixed phone-top marker */}
            <div style={{ position: "absolute", top: 5, left: "50%", transform: "translateX(-50%)", fontSize: 9, fontWeight: 800, color: "var(--md-on-surface-variant, #94a3b8)" }}>▲ TOP</div>
            {/* rotating arrow */}
            <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", transform: `rotate(${rel.relativeDeg}deg)`, transition: "transform .25s linear" }}>
              <svg width="120" height="120" viewBox="0 0 24 24" style={{ overflow: "visible" }}>
                <path d="M12 2 L15.4 14 L12 11.6 L8.6 14 Z" fill={target.needsHelp ? "#f87171" : "#38bdf8"} stroke="rgba(0,0,0,.35)" strokeWidth=".3" />
              </svg>
            </div>
            {/* radar blip */}
            <svg width="174" height="174" viewBox="0 0 174 174" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
              <circle cx="87" cy="87" r={R} fill="none" stroke="rgba(148,163,184,.25)" strokeDasharray="3 5" />
              {hasCoords ? blip : (
                dist != null ? <circle cx="87" cy="87" r={blipR} fill="none" stroke={target.needsHelp ? "rgba(248,113,113,.75)" : "rgba(56,189,248,.6)"} strokeWidth="2" strokeDasharray="4 4" /> : null
              )}
              <circle cx="87" cy="87" r="4" fill="#e2e8f0" />
            </svg>
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 900, lineHeight: 1.25, color: target.needsHelp ? "#f87171" : "var(--md-on-surface, #e2e8f0)" }}>
              {guidanceText(rel, dist)}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--md-on-surface-variant, #94a3b8)", marginTop: 5, lineHeight: 1.6 }}>
              {rel.headingKnown
                ? <>🧭 compass live — keep phone flat</>
                : compassLive ? <>🧭 calibrating… move in a slow ∞</>
                : <>🧭 no compass — <b>top of phone = North</b></>}
              <br />
              {target.source === "ble" ? "📶 bluetooth beacon" : "📡 network fix"} · seen {formatAge(Date.now() - target.lastSeen)}
              {target.accuracyM != null && target.accuracyM > 0 && <> · ±{Math.round(target.accuracyM)} m</>}
            </div>
            {target.rssi != null && (
              <div style={{ marginTop: 9 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, fontWeight: 800, letterSpacing: ".06em", color: warmthColor }}>
                  <span>SIGNAL {target.rssi} dBm</span><span>{warmth === "warmer" ? "🔥 WARMER" : warmth === "colder" ? "❄ COLDER" : warmth === "same" ? "• STEADY" : ""}</span>
                </div>
                <div style={{ height: 7, borderRadius: 99, background: "rgba(148,163,184,.18)", marginTop: 4, overflow: "hidden" }}>
                  <div style={{ width: `${rssiPct}%`, height: "100%", borderRadius: 99, background: warmth === "colder" ? "#f87171" : "#34d399", transition: "width .4s" }} />
                </div>
                {dist != null && !hasCoords && <div style={{ fontSize: 10, color: "var(--md-on-surface-variant, #94a3b8)", marginTop: 4 }}>est. range (RSSI) — no GPS fix on their phone</div>}
              </div>
            )}
          </div>
        </div>
      )}


      {/* controls */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
        <button onClick={() => setSonarOn((v) => !v)} className="md-pressable" style={{
          border: "1px solid " + (sonarOn ? "rgba(52,211,153,.5)" : "var(--md-outline, rgba(255,255,255,.1))"),
          background: sonarOn ? "rgba(52,211,153,.12)" : "transparent", color: sonarOn ? "#34d399" : "var(--md-on-surface-variant, #94a3b8)",
          borderRadius: 999, padding: "6px 13px", fontSize: 11.5, fontWeight: 800, cursor: "pointer",
        }}>
          {sonarOn ? "🔔 sonar ON" : "🔕 sonar OFF"}
        </button>
        {hasCoords && (
          <>
            <a href={osmPinUrl(target.lat!, target.lon!)} target="_blank" rel="noreferrer" className="md-pressable" style={{
              textDecoration: "none", border: "1px solid rgba(56,189,248,.4)", borderRadius: 999, padding: "6px 13px", fontSize: 11.5, fontWeight: 800, color: "#38bdf8",
            }}>
              🗺 OSM pin
            </a>
            <a href={geoIntentUrl(target.lat!, target.lon!)} className="md-pressable" style={{
              textDecoration: "none", border: "1px solid rgba(56,189,248,.4)", borderRadius: 999, padding: "6px 13px", fontSize: 11.5, fontWeight: 800, color: "#38bdf8",
            }}>
              📍 Maps app
            </a>
          </>
        )}
      </div>
    </div>
  );
}
