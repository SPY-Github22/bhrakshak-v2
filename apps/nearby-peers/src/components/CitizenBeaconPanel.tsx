/* Citizen-side UI: consent + "help rescuers find me" beacon.
   Drop into any React app: <CitizenBeaconPanel apiUrl="https://api…" token={jwt} />
   Consent OFF → the device is fully invisible (no announce, no advertise, and
   a DELETE is sent to purge any stored sighting). */

import { useEffect, useRef, useState } from "react";

import { getConsent, getNeedsHelp, setConsent, setNeedsHelp } from "../consent.ts";
import { getAlias, getOrCreatePeerId, setAlias } from "../identity.ts";
import { NearbyService } from "../nearbyService.ts";

export function CitizenBeaconPanel({
  apiUrl,
  token,
  demoLogin,
  className,
}: {
  apiUrl?: string;
  token?: string | null;
  /** Optional fallback login used when no token is supplied (demo setups,
      mirroring the codebase's BleCrowdPanel/MeshRelayPanel pattern). */
  demoLogin?: { email: string; password: string };
  className?: string;
}) {
  const [consent, setConsentState] = useState(() => getConsent());
  const [sos, setSosState] = useState(() => getNeedsHelp());
  const [alias, setAliasState] = useState(() => getAlias());
  const [peerId] = useState(() => getOrCreatePeerId());
  const [msg, setMsg] = useState<string | null>(null);
  const svcRef = useRef<NearbyService | null>(null);
  const tokenRef = useRef<string | null>(token ?? null);

  useEffect(() => () => svcRef.current?.stop(), []);

  /** Token acquisition: caller-supplied token wins; otherwise optionally
      demo-login (mirrors the MeshRelayPanel/BleCrowdPanel demo pattern). */
  async function ensureToken(): Promise<string | null> {
    if (tokenRef.current) return tokenRef.current;
    if (!demoLogin || !apiUrl) return null;
    try {
      const r = await fetch(`${apiUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: demoLogin.email, password: demoLogin.password }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      if (data?.access_token) {
        tokenRef.current = data.access_token as string;
        return tokenRef.current;
      }
    } catch { /* offline / server down — beacon will retry next toggle */ }
    return null;
  }

  function svc(): NearbyService {
    if (!svcRef.current) {
      svcRef.current = new NearbyService({
        role: "citizen",
        apiUrl: apiUrl ?? null,
        getToken: () => tokenRef.current,
        scan: false, // citizens announce; they do not scan for others
        log: setMsg,
      });
    }
    return svcRef.current;
  }

  async function toggleConsent() {
    const next = !consent;
    setConsentState(next);
    setConsent(next);
    if (next) {
      const tok = await ensureToken();
      if (!tok) {
        setMsg("Could not reach the rescue server — try again when you have signal.");
        setConsentState(false);
        setConsent(false);
        return;
      }
      await svc().start();
      await svc().announceNow();
      setMsg("Beacon on — rescuers nearby can see you. Keep the app open.");
    } else {
      await svc().revokeConsent();
      svc().stop();
      setMsg("Beacon off — you are invisible. Your last sighting was purged.");
    }
  }

  async function toggleSos() {
    const next = !sos;
    setSosState(next);
    setNeedsHelp(next);
    if (consent) {
      await svc().announceNow();
      setMsg(next ? "SOS flag raised — you'll be marked for priority rescue" : "SOS flag cleared");
    } else {
      setMsg(next ? "Turn the beacon on so rescuers can see your SOS" : null);
    }
  }

  function rename(v: string) {
    setAliasState(setAlias(v));
  }

  return (
    <section className={className} style={{
      background: "var(--md-surface, #141a24)", border: `1px solid ${consent ? "rgba(52,211,153,.4)" : "var(--md-outline, rgba(255,255,255,.08))"}`,
      borderRadius: "var(--md-radius-l, 18px)", padding: "15px 16px",
    }}>
      <h3 style={{ display: "flex", alignItems: "center", gap: 9, margin: "0 0 4px", fontSize: 15, fontWeight: 800 }}>
        <span style={{ display: "grid", placeItems: "center", width: 32, height: 32, borderRadius: 10, background: consent ? "rgba(52,211,153,.14)" : "var(--md-surface-2, #1c2531)", color: consent ? "#34d399" : "var(--md-on-surface-variant, #94a3b8)" }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /><circle cx="12" cy="12" r="3.2" />
          </svg>
        </span>
        Help rescuers find me
        {consent && <span className="md-pulse" style={{ marginLeft: "auto", fontSize: 10, fontWeight: 800, letterSpacing: ".07em", background: "rgba(52,211,153,.14)", color: "#34d399", borderRadius: 999, padding: "3px 9px" }}>BEACON ON</span>}
      </h3>
      <p style={{ fontSize: 12, color: "var(--md-on-surface-variant, #94a3b8)", margin: "0 0 10px" }}>
        Shares only your rough location with rescue teams near you, every 20 seconds, while this app is open.
        No name, no phone number — an anonymous ID that rotates daily. Turn it off anytime to vanish.
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={() => void toggleConsent()} className="md-pressable" style={{
          border: "none", borderRadius: 999, padding: "8px 16px", fontSize: 12.5, fontWeight: 800, cursor: "pointer",
          background: consent ? "rgba(248,113,113,.14)" : "#34d399", color: consent ? "#f87171" : "#06170f",
        }}>
          {consent ? "■ Turn off" : "▲ Be visible to rescuers"}
        </button>
        <button onClick={() => void toggleSos()} className="md-pressable" style={{
          border: "1px solid " + (sos ? "rgba(248,113,113,.6)" : "var(--md-outline, rgba(255,255,255,.1))"),
          borderRadius: 999, padding: "8px 16px", fontSize: 12.5, fontWeight: 800, cursor: "pointer",
          background: sos ? "rgba(248,113,113,.16)" : "transparent", color: sos ? "#f87171" : "var(--md-on-surface, #e2e8f0)",
        }}>
          {sos ? "🆘 SOS raised" : "I need help"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
        <label style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "var(--md-on-surface-variant, #94a3b8)", whiteSpace: "nowrap" }}>
          Display name
        </label>
        <input value={alias} maxLength={24} onChange={(e) => rename(e.target.value)} className="md-pressable"
          style={{ flex: 1, minWidth: 0, background: "var(--md-surface-2, #1c2531)", color: "var(--md-on-surface, #e2e8f0)", border: "1px solid var(--md-outline, rgba(255,255,255,.1))", borderRadius: 10, padding: "7px 11px", fontSize: 12.5, outline: "none" }} />
      </div>

      <div style={{ marginTop: 9, fontSize: 10.5, color: "var(--md-on-surface-variant, #94a3b8)", fontFamily: "monospace" }}>
        your anonymous id: {peerId}
      </div>
      {msg && <div style={{ marginTop: 7, fontSize: 11.5, color: consent ? "#34d399" : "#38bdf8" }}>{msg}</div>}
    </section>
  );
}
