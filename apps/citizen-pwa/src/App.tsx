import { useEffect, useRef, useState } from "react";

import { Icon, LEVEL_COLORS, LEVEL_NAMES } from "./icons";
import { CitizenBeaconPanel } from "../../nearby-peers/src/components/CitizenBeaconPanel";
import { LANGS, makeT, type LangCode } from "./i18n";
import "./theme.css";

const API = (import.meta as any).env?.VITE_API_URL ?? "http://localhost:8000";
const DC_PHONE = "+385123456789"; // district control room placeholder — env-overridable

const CACHE = {
  alerts: "cz_alerts",
  zone: "cz_zone",
  shelters: "cz_shelters",
  risk: "cz_risk",
};

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const R = 6371, p = Math.PI / 180;
  const dLat = (b.lat - a.lat) * p, dLon = (b.lon - a.lon) * p;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

interface LiveAlert {
  id: string;
  level: number;
  message: string;
  messages?: Record<string, string>;
  fired_at: string;
  zone_code?: string;
}

interface Shelter {
  id: string; name: string; district: string | null; capacity: number;
  occupancy: number; free_beds: number; shelter_type: string;
  has_medical: boolean; water_liters: number; ration_packets: number;
  lat: number; lon: number;
}

export default function CitizenApp() {
  const [lang, setLang] = useState<LangCode>(() => (localStorage.getItem("cz_lang") as LangCode) || "en");
  const langRef = useRef<LangCode>(lang);
  useEffect(() => { langRef.current = lang; }, [lang]);

  const t = makeT(lang);
  const [online, setOnline] = useState(navigator.onLine);
  const [alerts, setAlerts] = useState<LiveAlert[]>(() => {
    try { return JSON.parse(localStorage.getItem(CACHE.alerts) ?? "[]"); } catch { return []; }
  });
  const [wsOk, setWsOk] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(() => {
    const c = localStorage.getItem("cz_coords");
    return c ? JSON.parse(c) : null;
  });
  const [zone, setZone] = useState<{ name: string; hazard_level: number } | null>(() => {
    try { return JSON.parse(localStorage.getItem(CACHE.zone) ?? "null"); } catch { return null; }
  });
  const [shelters, setShelters] = useState<Shelter[]>(() => {
    try { return JSON.parse(localStorage.getItem(CACHE.shelters) ?? "[]"); } catch { return []; }
  });
  const [checkin, setCheckin] = useState(() => localStorage.getItem("cz_checkin") === "1");
  const [snack, setSnack] = useState<string | null>(null);
  const [installEvt, setInstallEvt] = useState<any>(null);
  const wsRef = useRef<WebSocket | null>(null);

  function toast(m: string) {
    setSnack(m);
    window.setTimeout(() => setSnack((cur) => (cur === m ? null : cur)), 3400);
  }

  /* Sync language preference to local storage and backend server */
  useEffect(() => {
    localStorage.setItem("cz_lang", lang);
    let deviceId = localStorage.getItem("cz_device");
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      localStorage.setItem("cz_device", deviceId);
    }
    // Sync anonymous device preference
    fetch(`${API}/api/v1/public/preferences`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: deviceId,
        lang,
        preferred_lang: lang,
        lat: coords?.lat ?? null,
        lon: coords?.lon ?? null,
      }),
    }).catch(() => {});

    // If authenticated user token exists, sync user profile
    const token = localStorage.getItem("cz_token");
    if (token) {
      fetch(`${API}/api/v1/auth/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ preferred_lang: lang }),
      }).catch(() => {});
    }

    // Refresh active alerts in the selected language
    fetch(`${API}/api/v1/alerts/active?lang=${lang}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((activeList) => {
        if (Array.isArray(activeList) && activeList.length) {
          setAlerts((prev) => {
            const map = new Map<string, LiveAlert>();
            for (const item of activeList) {
              map.set(item.id, {
                id: item.id,
                level: item.level,
                message: item.messages?.[lang] || item.message,
                messages: item.messages,
                fired_at: item.fired_at || new Date().toISOString(),
                zone_code: item.zone_code,
              });
            }
            for (const existing of prev) {
              if (!map.has(existing.id)) map.set(existing.id, existing);
            }
            const merged = Array.from(map.values()).slice(0, 25);
            localStorage.setItem(CACHE.alerts, JSON.stringify(merged));
            return merged;
          });
        }
      })
      .catch(() => {});
  }, [lang, coords]);

  /* online/offline + geolocation resolve */
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);

    navigator.geolocation?.getCurrentPosition(
      ({ coords }) => {
        const c = { lat: coords.latitude, lon: coords.longitude };
        setCoords(c);
        localStorage.setItem("cz_coords", JSON.stringify(c));
        fetch(`${API}/api/v1/zones?bbox=${c.lon - 0.35},${c.lat - 0.35},${c.lon + 0.35},${c.lat + 0.35}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((zones) => {
            if (!zones?.length) return;
            const worst = [...zones].sort((a: any, b: any) => b.hazard_level - a.hazard_level)[0];
            const z = { name: worst.name ?? worst.zone_code, hazard_level: worst.hazard_level };
            setZone(z);
            localStorage.setItem(CACHE.zone, JSON.stringify(z));
          })
          .catch(() => {});
      },
      () => {},
      { timeout: 7000 }
    );
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  /* live warning feed — the core of the receive-side app */
  useEffect(() => {
    let retry: number | undefined;
    const connect = () => {
      try {
        const ws = new WebSocket(`${API.replace(/^http/, "ws")}/ws/live`);
        wsRef.current = ws;
        ws.onopen = () => setWsOk(true);
        ws.onclose = () => { setWsOk(false); retry = window.setTimeout(connect, 5000); };
        ws.onerror = () => ws.close();
        ws.onmessage = (ev) => {
          try {
            const d = JSON.parse(ev.data);
            if (d.type === "alert" || d.type === "citizen_checkin") {
              if (d.type !== "alert") return;
              const currentLang = langRef.current;
              const alertMsg = (d.messages && d.messages[currentLang]) || d.message || "";
              const a: LiveAlert = {
                id: `live-${Date.now()}`,
                level: d.level ?? 0,
                message: alertMsg,
                messages: d.messages,
                zone_code: d.zone_code,
                fired_at: new Date().toISOString(),
              };
              setAlerts((l) => {
                const next = [a, ...l].slice(0, 25);
                localStorage.setItem(CACHE.alerts, JSON.stringify(next));
                return next;
              });
              toast(alertMsg.slice(0, 120));
              if (a.level >= 3) {
                navigator.vibrate?.([120, 60, 120, 60, 240]);
                if (typeof Notification !== "undefined" && Notification.permission === "granted") {
                  try { new Notification(`L${a.level} — ${LEVEL_NAMES[Math.min(a.level, 4)]}`, { body: alertMsg, tag: a.id }); } catch { /* noop */ }
                }
              }
            }
          } catch { /* heartbeat */ }
        };
      } catch { setWsOk(false); }
    };
    connect();
    return () => { wsRef.current?.close(); if (retry) clearTimeout(retry); };
  }, []);

  /* shelters fetch (cache for offline) + offline check-in flush */
  useEffect(() => {
    if (!online) return;
    fetch(`${API}/api/v1/evacuation/shelters`)
      .then((r) => (r.ok ? r.json() : null))
      .then((rows) => {
        if (rows?.length) {
          setShelters(rows);
          localStorage.setItem(CACHE.shelters, JSON.stringify(rows));
        }
      })
      .catch(() => {});
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
    window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); setInstallEvt(e); });
    // flush check-ins queued while offline
    const q = JSON.parse(localStorage.getItem("cz_checkin_queue") ?? "[]");
    if (q.length) {
      Promise.all(q.map((p: any) =>
        fetch(`${API}/api/v1/public/checkin`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) })
      )).then(() => {
        localStorage.setItem("cz_checkin_queue", "[]");
        localStorage.setItem("cz_checkin", "1");
        setCheckin(true);
      }).catch(() => {});
    }
  }, [online]);

  async function doCheckin() {
    const deviceId = (() => {
      let id = localStorage.getItem("cz_device");
      if (!id) { id = crypto.randomUUID(); localStorage.setItem("cz_device", id); }
      return id;
    })();
    const payload = { lat: coords?.lat ?? null, lon: coords?.lon ?? null, device_id: deviceId, lang: lang };
    try {
      if (online) {
        const r = await fetch(`${API}/api/v1/public/checkin`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!r.ok) throw new Error(String(r.status));
      } else {
        const q = JSON.parse(localStorage.getItem("cz_checkin_queue") ?? "[]");
        q.push(payload);
        localStorage.setItem("cz_checkin_queue", JSON.stringify(q.slice(-10)));
      }
      localStorage.setItem("cz_checkin", "1");
      setCheckin(true);
      navigator.vibrate?.([80, 40, 80]);
      toast("✓ " + t("checkin_done"));
    } catch {
      toast("✗ check-in failed — will retry");
    }
  }

  async function safeRoute(s: Shelter) {
    if (!coords) { toast("Enable GPS once to plan a safe route"); return; }
    try {
      const r = await fetch(`${API}/api/v1/evacuation/safe-route?lat=${coords.lat}&lon=${coords.lon}`);
      const plan = await r.json();
      toast(plan?.route?.summary ?? plan?.summary ?? `Safest: ${s.name}`);
      if (s.lat && s.lon) {
        window.open(`https://www.openstreetmap.org/directions?from=${coords.lat},${coords.lon}&to=${s.lat},${s.lon}`, "_blank");
      }
    } catch {
      if (s.lat && s.lon) {
        window.open(`https://www.openstreetmap.org/directions?from=${coords.lat},${coords.lon}&to=${s.lat},${s.lon}`, "_blank");
      }
    }
  }

  const topAlert = alerts[0];
  const alertLevel = zone?.hazard_level ?? topAlert?.level ?? 0;
  const color = LEVEL_COLORS[Math.min(alertLevel, 4)];
  const sortedShelters = coords
    ? [...shelters].sort((a, b) => haversineKm(coords, a) - haversineKm(coords, b))
    : shelters;

  return (
    <div style={{ maxWidth: 520, margin: "0 auto", padding: "0 14px calc(90px + env(safe-area-inset-bottom))" }}>
      {/* app bar */}
      <header className="md-appbar" style={{ margin: "0 -14px", padding: "10px 14px" }}>
        <div style={{ flex: 1 }}>
          <div className="md-appbar-title">
            Bhu<span style={{ color: "var(--md-primary)" }}>Rakshak</span>
            <span style={{ fontWeight: 400, color: "var(--md-on-surface-variant)", fontSize: 15 }}> Alerts</span>
          </div>
          <div className="md-appbar-sub">{t("tagline")}</div>
        </div>
        <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10.5, fontWeight: 800, color: wsOk ? "#34d399" : "var(--md-on-surface-variant)" }}>
          <span className={wsOk ? "md-pulse" : undefined}>●</span> {wsOk ? t("live") : t("cached")}
        </span>
        <select
          value={lang} onChange={(e) => setLang(e.target.value as LangCode)}
          aria-label={t("lang_label")} className="md-pressable"
          style={{ background: "var(--md-surface-2)", color: "var(--md-on-surface)", border: "1px solid var(--md-outline)", borderRadius: 999, padding: "6px 10px", fontSize: 12.5, outline: "none" }}
        >
          {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>
      </header>

      {!online && (
        <div className="md-rise" style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 12, background: "rgba(250,204,21,.1)", border: "1px solid rgba(250,204,21,.35)", color: "#fde68a", borderRadius: "var(--md-radius-m)", padding: "9px 13px", fontSize: 12.5 }}>
          <Icon name="wifi_off" size={16} /> {t("offline_banner")}
        </div>
      )}

      {installEvt && (
        <button className="md-btn md-btn-outline md-btn-block md-pressable" style={{ marginTop: 12 }} onClick={async () => { installEvt.prompt(); setInstallEvt(null); }}>
          <Icon name="download" size={16} /> {t("install")}
        </button>
      )}

      {/* risk hero */}
      <section className="md-card md-card-elevated md-rise" style={{
        marginTop: 14, display: "flex", gap: 16, alignItems: "center",
        background: `linear-gradient(135deg, ${color}18, var(--md-surface-1) 55%)`,
        borderColor: `${color}55`,
      }}>
        <div style={{ width: 70, height: 70, borderRadius: 22, display: "grid", placeItems: "center", background: `${color}1f`, color, fontSize: 28, fontWeight: 900, border: `2px solid ${color}66` }}>
          {alertLevel}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: ".08em", fontWeight: 800, color: "var(--md-on-surface-variant)" }}>{t("risk_now")}</div>
          <div style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1.25 }}>{LEVEL_NAMES[Math.min(alertLevel, 4)]}</div>
          <div style={{ fontSize: 11.5, color: "var(--md-on-surface-variant)" }}>{zone?.name ?? t("your_zone")}</div>
        </div>
      </section>

      {/* latest official warning — huge, this is a receive-side app */}
      {topAlert && topAlert.level >= 2 && (
        <section className="md-rise" style={{
          marginTop: 14, borderRadius: "var(--md-radius-l)", padding: 15,
          border: `1px solid ${LEVEL_COLORS[Math.min(topAlert.level, 4)]}66`,
          background: `linear-gradient(135deg, ${LEVEL_COLORS[Math.min(topAlert.level, 4)]}14, var(--md-surface-1) 70%)`,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="md-pulse" style={{ width: 9, height: 9, borderRadius: 999, background: LEVEL_COLORS[Math.min(topAlert.level, 4)], display: "inline-block" }} />
            <span style={{ fontSize: 10.5, fontWeight: 900, letterSpacing: ".1em", color: LEVEL_COLORS[Math.min(topAlert.level, 4)] }}>
              L{topAlert.level} · {LEVEL_NAMES[Math.min(topAlert.level, 4)]}
            </span>
            {topAlert.zone_code && <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--md-on-surface-variant)" }}>{topAlert.zone_code}</span>}
          </div>
          <p style={{ margin: "9px 0 0", fontSize: 14.5, fontWeight: 700, lineHeight: 1.5 }}>
            {topAlert.messages?.[lang] || topAlert.message}
          </p>
          <button
            onClick={() => {
              if (!window.speechSynthesis) return;
              window.speechSynthesis.cancel();
              const textToSpeak = topAlert.messages?.[lang] || topAlert.message;
              const u = new SpeechSynthesisUtterance(textToSpeak);
              u.lang = lang === "hi" ? "hi-IN" : (lang === "bn" ? "bn-IN" : "en-IN");
              u.rate = 0.95;
              window.speechSynthesis.speak(u);
            }}
            className="md-btn md-btn-tonal md-pressable" style={{ marginTop: 10, padding: "7px 14px", fontSize: 12 }}
          >
            <Icon name="volume" size={14} /> Read aloud
          </button>
        </section>
      )}

      {/* warning feed */}
      <section className="md-card md-rise" style={{ animationDelay: ".1s" }}>
        <h3 className="md-card-title"><span className="md-ico" style={{ color: "#f87171" }}><Icon name="alert" /></span>{t("alerts_title")}</h3>
        {alerts.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--md-on-surface-variant)", margin: 0 }}>{t("no_alerts")}</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 9, maxHeight: 260, overflowY: "auto" }}>
            {alerts.slice(0, 8).map((a) => (
              <div key={a.id} style={{ display: "flex", gap: 11, background: "var(--md-surface-2)", borderRadius: "var(--md-radius-m)", padding: "10px 12px", borderLeft: `4px solid ${LEVEL_COLORS[Math.min(a.level, 4)]}` }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: LEVEL_COLORS[Math.min(a.level, 4)], minWidth: 24 }}>L{a.level}</div>
                <div style={{ flex: 1, fontSize: 12.5, lineHeight: 1.45 }}>{a.messages?.[lang] || a.message}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* safe check-in */}
      <section className="md-card md-rise" style={{ animationDelay: ".18s", textAlign: "center" }}>
        <button
          onClick={doCheckin}
          disabled={checkin}
          className="md-btn md-btn-lg md-btn-block md-pressable"
          style={{
            background: checkin ? "rgba(52,211,153,.16)" : "var(--md-tertiary)",
            color: checkin ? "#34d399" : "#052e22",
            border: checkin ? "1px solid rgba(52,211,153,.5)" : "none",
          }}
        >
          <Icon name="check" size={19} /> {checkin ? "✓ " + t("safe_checkin") : t("safe_checkin")}
        </button>
        <p style={{ margin: "9px 0 0", fontSize: 11.5, color: "var(--md-on-surface-variant)" }}>{t("checkin_note")}</p>
        <a href={`tel:${DC_PHONE}`} className="md-pressable" style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 10, fontSize: 12.5, fontWeight: 700, color: "#38bdf8", textDecoration: "none" }}>
          <Icon name="call" size={14} /> {t("call_dc")}
        </a>
      </section>

      {/* nearby-peer beacon — consent-gated "help rescuers find me" */}
      <CitizenBeaconPanel apiUrl={API} demoLogin={{ email: "citizen@bhrakshak.in", password: "Citizen@123" }} />

      {/* shelters */}
      <section className="md-card md-rise" id="cz-shelters-anchor" style={{ animationDelay: ".26s" }}>
        <h3 className="md-card-title"><span className="md-ico" style={{ color: "#34d399" }}><Icon name="shelter" /></span>{t("shelters")}</h3>
        {sortedShelters.length === 0 && <p style={{ fontSize: 13, color: "var(--md-on-surface-variant)", margin: 0 }}>{t("no_shelters")}</p>}
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {sortedShelters.slice(0, 5).map((s) => {
            const dist = coords ? haversineKm(coords, s) : null;
            const free = s.free_beds ?? Math.max(0, s.capacity - s.occupancy);
            return (
              <div key={s.id} style={{ background: "var(--md-surface-2)", borderRadius: "var(--md-radius-m)", padding: "11px 13px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <b style={{ fontSize: 13.5 }}>{s.name}</b>
                  {dist != null && <span style={{ fontSize: 11, color: "#38bdf8", whiteSpace: "nowrap" }}>{dist.toFixed(1)} km {t("distance")}</span>}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 7, fontSize: 10.5 }}>
                  <span className="md-badge" style={{ background: "rgba(52,211,153,.13)", color: "#34d399" }}>{free} {t("shelter_free")}</span>
                  {s.has_medical && <span className="md-badge" style={{ background: "rgba(56,189,248,.12)", color: "#38bdf8" }}>✚ {t("medical")}</span>}
                  {s.water_liters > 0 && <span className="md-badge" style={{ background: "rgba(226,232,240,.1)", color: "#e2e8f0" }}>💧 {s.water_liters}L</span>}
                  {s.ration_packets > 0 && <span className="md-badge" style={{ background: "rgba(250,204,21,.12)", color: "#facc15" }}>🍱 {s.ration_packets}</span>}
                </div>
                <button className="md-btn md-btn-outline md-pressable" style={{ marginTop: 9, padding: "6px 13px", fontSize: 12 }} onClick={() => safeRoute(s)}>
                  <Icon name="route" size={14} /> {t("route_here")}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {snack && <div className="md-snackbar">{snack}</div>}

      {/* bottom nav (home + call) — deliberately minimal */}
      <nav className="md-bottomnav">
        <button className="md-navitem md-navitem-active md-pressable" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
          <Icon name="alert" size={22} /> <span>{t("alerts_title").split(" ")[0]}</span>
        </button>
        <button className="md-navitem md-pressable" onClick={() => document.getElementById("cz-shelters-anchor")?.scrollIntoView({ behavior: "smooth" })}>
          <Icon name="shelter" size={22} /> <span>{t("shelters")}</span>
        </button>
        <button className="md-navitem md-pressable" onClick={doCheckin} disabled={checkin}>
          <Icon name="check" size={22} /> <span>{t("safe_checkin")}</span>
        </button>
      </nav>
    </div>
  );
}
