import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useMemo, useState } from "react";

import { AlertsPanel, type LiveAlert } from "./components/AlertsPanel";
import { BleCrowdPanel } from "./components/BleCrowdPanel";
import { MeshRelayPanel } from "./components/MeshRelayPanel";
import { PeerNavigator, requestCompassPermission } from "../../nearby-peers/src/components/PeerNavigator";
import { PeopleNearbyPanel } from "../../nearby-peers/src/components/PeopleNearbyPanel";
import { EdgeVisionInspector, type FissureAnalysisResult } from "./components/EdgeVisionInspector";
import { RainGaugePanel } from "./components/RainGaugePanel";
import { VoiceRecorder } from "./components/VoiceRecorder";
import { Icon, LEVEL_COLORS, LEVEL_NAMES } from "./components/ui";
import { db, getStoredToken, loginAndStore, queueReport, syncQueue } from "./db";
import { LANGS, makeT, type LangCode } from "./i18n";
import "./theme.css";

const API = (import.meta as any).env?.VITE_API_URL ?? "http://localhost:8000";
const CATEGORIES = ["crack", "slope_movement", "blocked_road", "past_slide", "water_seepage"] as const;
const CATEGORY_ICONS: Record<string, string> = {
  crack: "⚠", slope_movement: "⛰", blocked_road: "🚧", past_slide: "🪨", water_seepage: "💧",
};

type Tab = "home" | "report" | "mesh";

export default function App() {
  const [lang, setLang] = useState<LangCode>(
    () => (localStorage.getItem("bh_lang") as LangCode) || "en"
  );
  const t = makeT(lang);
  const [online, setOnline] = useState(navigator.onLine);
  const [tab, setTab] = useState<Tab>("home");
  const [snack, setSnack] = useState<string | null>(null);
  const [zone, setZone] = useState<{ id: string; name: string; hazard_level: number } | null>(() => {
    const id = localStorage.getItem("bh_zone_id");
    const name = localStorage.getItem("bh_zone_name");
    const lvl = Number(localStorage.getItem("bh_zone_level") ?? "-1");
    return id ? { id, name: name ?? "your zone", hazard_level: Number.isFinite(lvl) ? lvl : 0 } : null;
  });
  const pending = useLiveQuery(() => db.reports.where("status").equals("pending").count(), [], 0);

  function toast(m: string) {
    setSnack(m);
    window.setTimeout(() => setSnack((cur) => (cur === m ? null : cur)), 3200);
  }

  useEffect(() => localStorage.setItem("bh_lang", lang), [lang]);
  useEffect(() => {
    const on = () => { setOnline(true); syncQueue(API).then((r) => r.sent && toast(`${r.sent} report${r.sent > 1 ? "s" : ""} synced ✓`)); };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    if (navigator.onLine) syncQueue(API).then((r) => r.sent && toast(`${r.sent} report${r.sent > 1 ? "s" : ""} synced ✓`));
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  function handleLiveAlert(a: LiveAlert) {
    toast(a.message.slice(0, 110));
    if (a.level >= 3) navigator.vibrate?.([120, 60, 120, 60, 200]);
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification(`L${a.level} · ${LEVEL_NAMES[Math.min(a.level, 4)]}`, { body: a.message, tag: a.id });
      } catch { /* noop */ }
    }
  }

  return (
    <div style={{ maxWidth: 520, margin: "0 auto", padding: "0 14px calc(84px + env(safe-area-inset-bottom))" }}>
      {/* ---------- top app bar ---------- */}
      <header className="md-appbar" style={{ margin: "0 -14px", padding: "10px 14px" }}>
        <div style={{ flex: 1 }}>
          <div className="md-appbar-title">
            Bhu<span style={{ color: "var(--md-primary)" }}>Rakshak</span>
            <span style={{ fontWeight: 400, color: "var(--md-on-surface-variant)", fontSize: 15 }}> · Field</span>
          </div>
          <div className="md-appbar-sub">
            {zone ? `${zone.name} · ${LANGS.find((l) => l.code === lang)?.label}` : "resolve your zone…"}
          </div>
        </div>
        <select
          value={lang} onChange={(e) => setLang(e.target.value as LangCode)}
          aria-label="language"
          className="md-pressable"
          style={{ background: "var(--md-surface-2)", color: "var(--md-on-surface)", border: "1px solid var(--md-outline)", borderRadius: 999, padding: "6px 10px", fontSize: 12.5, outline: "none" }}
        >
          {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>
        <span
          title={online ? "online" : "offline — reports queue locally"}
          style={{ display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: 999,
            background: online ? "rgba(52,211,153,.14)" : "rgba(248,113,113,.13)",
            color: online ? "#34d399" : "#f87171" }}
        >
          <Icon name={online ? "wifi" : "wifi_off"} size={17} />
        </span>
      </header>

      {/* ---------- offline banner ---------- */}
      {!online && (
        <div className="md-rise" style={{
          display: "flex", alignItems: "center", gap: 9, marginTop: 12,
          background: "rgba(250,204,21,.1)", border: "1px solid rgba(250,204,21,.35)",
          color: "#fde68a", borderRadius: "var(--md-radius-m)", padding: "9px 13px", fontSize: 12.5,
        }}>
          <Icon name="wifi_off" size={16} />
          {t("offline_banner")}
        </div>
      )}

      {/* ---------- HOME ---------- */}
      {tab === "home" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 14 }}>
          <RiskHero t={t} online={online} zone={zone} />
          <EmergencyBroadcastBanner t={t} lang={lang} />
          <RainGaugePanel token={getStoredToken()} onZoneResolved={(z) => {
            if (!z) return;
            setZone(z);
            localStorage.setItem("bh_zone_id", z.id);
            localStorage.setItem("bh_zone_name", z.name ?? "");
            localStorage.setItem("bh_zone_level", String(z.hazard_level));
          }} />
          <AlertsPanel online={online} onLiveAlert={handleLiveAlert} />
          <PeopleNearbyPanel apiUrl={API} token={getStoredToken()} />
        </div>
      )}

      {/* ---------- REPORT ---------- */}
      {tab === "report" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 14 }}>
          <LoginBar apiUrl={API} onMsg={toast} t={t} />
          <ReportSection t={t} onSaved={() => { toast("Saved to offline queue ✓"); navigator.vibrate?.(120); }} />
          <QueueSection pending={pending ?? 0} t={t} online={online} onSync={async () => {
            const r = await syncQueue(API);
            toast(r.sent ? `${r.sent} synced ✓` : "Nothing synced — still offline?");
          }} />
        </div>
      )}

      {/* ---------- MESH ---------- */}
      {tab === "mesh" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 14 }}>
          <MeshRelayPanel onReceived={() => toast("Received a report from a peer ✓")} />
          <BleCrowdPanel token={getStoredToken()} zoneId={zone?.id ?? null} />
        </div>
      )}

      {/* ---------- emergency FAB ---------- */}
      <button
        className="md-fab md-pressable"
        aria-label="safe check-in"
        onClick={() => {
          db.checkins.add({ ts: new Date().toISOString(), synced: 0 });
          navigator.vibrate?.([80, 40, 80]);
          toast("✓ " + t("safe_checkin"));
        }}
      >
        <Icon name="check" size={26} />
      </button>

      {/* ---------- snackbar ---------- */}
      {snack && <div className="md-snackbar">{snack}</div>}

      {/* ---------- bottom navigation ---------- */}
      <nav className="md-bottomnav">
        {([
          { id: "home", icon: "home", label: t("risk_now").split(" ")[0] },
          { id: "report", icon: "upload", label: t("report") },
          { id: "mesh", icon: "share", label: "Mesh" },
        ] as { id: Tab; icon: string; label: string }[]).map((item) => (
          <button
            key={item.id}
            className={`md-navitem md-pressable ${tab === item.id ? "md-navitem-active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            <Icon name={item.icon} size={22} />
            {item.id === "report" && (pending ?? 0) > 0 && (
              <span style={{ position: "absolute", top: 2, right: 8, minWidth: 16, height: 16, borderRadius: 999, background: "var(--md-primary)", color: "#fff", fontSize: 9.5, fontWeight: 800, display: "grid", placeItems: "center", padding: "0 4px" }}>
                {pending}
              </span>
            )}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

/* ---------- risk hero (what every villager checks first) ---------- */
function RiskHero({ t, online, zone }: { t: ReturnType<typeof makeT>; online: boolean; zone: { id: string; name: string; hazard_level: number } | null }) {
  const lvl = zone?.hazard_level ?? 0;
  const color = LEVEL_COLORS[Math.min(lvl, 4)];
  return (
    <section className="md-card md-card-elevated md-rise" style={{
      display: "flex", gap: 16, alignItems: "center",
      background: `linear-gradient(135deg, ${color}18, var(--md-surface-1) 55%)`,
      borderColor: `${color}55`,
    }}>
      <div style={{
        width: 66, height: 66, borderRadius: 20, display: "grid", placeItems: "center",
        background: `${color}1f`, color, fontSize: 26, fontWeight: 900, border: `2px solid ${color}66`,
      }}>
        {lvl}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: ".08em", fontWeight: 800, color: "var(--md-on-surface-variant)" }}>
          {t("risk_now")}
        </div>
        <div style={{ fontSize: 21, fontWeight: 800, color, lineHeight: 1.2 }}>{LEVEL_NAMES[Math.min(lvl, 4)]}</div>
        <div style={{ fontSize: 11.5, color: "var(--md-on-surface-variant)" }}>{zone?.name ?? "resolve your zone when online"}</div>
      </div>
      {!online && <Icon name="wifi_off" size={20} style={{ color: "var(--md-on-surface-variant)" }} />}
    </section>
  );
}

/* ---------- emergency broadcast (kept, restyled) ---------- */
function EmergencyBroadcastBanner({ t, lang }: { t: ReturnType<typeof makeT>; lang: LangCode }) {
  const alertText = t("emergency_alert");
  function speakAlert() {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(alertText);
    utterance.lang = lang === "hi" ? "hi-IN" : lang === "bn" ? "bn-IN" : lang === "ne" ? "ne-NP" : "en-IN";
    window.speechSynthesis.speak(utterance);
  }
  return (
    <section className="md-rise" style={{
      borderRadius: "var(--md-radius-l)", border: "1px solid rgba(248,113,113,.5)",
      background: "linear-gradient(135deg, rgba(248,113,113,.14), var(--md-surface-1) 70%)",
      padding: 14,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="md-pulse" style={{ width: 9, height: 9, borderRadius: 999, background: "#f87171", display: "inline-block" }} />
          <span style={{ fontSize: 10.5, fontWeight: 900, letterSpacing: ".1em", color: "#fca5a5" }}>EMERGENCY BROADCAST (DDMA)</span>
        </div>
        <button onClick={speakAlert} className="md-pressable"
          style={{ display: "flex", alignItems: "center", gap: 6, borderRadius: 999, border: "1px solid rgba(248,113,113,.5)", background: "rgba(248,113,113,.12)", color: "#fca5a5", padding: "5px 11px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
          <Icon name="volume" size={13} /> Read aloud
        </button>
      </div>
      <p style={{ margin: "9px 0 0", fontSize: 12.5, fontWeight: 600, lineHeight: 1.55, color: "#fecaca" }}>{alertText}</p>
    </section>
  );
}

/* ---------- report form ---------- */
function ReportSection({ t, onSaved }: { t: ReturnType<typeof makeT>; onSaved: () => void }) {
  const [category, setCategory] = useState<string>("crack");
  const [description, setDescription] = useState("");
  const [photoB64, setPhotoB64] = useState<string | null>(null);
  const [audioB64, setAudioB64] = useState<string | null>(null);
  const [audioDuration, setAudioDuration] = useState<number>(0);
  const [sending, setSending] = useState(false);

  function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setPhotoB64(reader.result as string);
    reader.readAsDataURL(file);
  }

  async function save() {
    setSending(true);
    let lat: number | null = null;
    let lon: number | null = null;
    await new Promise<void>((resolve) => {
      navigator.geolocation?.getCurrentPosition(
        ({ coords }) => { lat = coords.latitude; lon = coords.longitude; resolve(); },
        () => resolve(),
        { timeout: 6000 }
      );
    });
    await queueReport({
      category,
      lat,
      lon,
      description: description || undefined,
      photo_b64: photoB64 || undefined,
      audio_b64: audioB64 || undefined,
      audio_duration_sec: audioDuration || undefined,
      taken_at: new Date().toISOString(),
    });
    navigator.vibrate?.(120);
    setDescription("");
    setPhotoB64(null);
    setAudioB64(null);
    setAudioDuration(0);
    setSending(false);
    onSaved();
  }

  return (
    <section className="md-card md-rise" style={{ animationDelay: ".05s" }}>
      <h3 className="md-card-title"><span className="md-ico"><Icon name="camera" /></span>{t("report")}</h3>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {CATEGORIES.map((c) => (
          <button key={c} onClick={() => setCategory(c)}
            className={`md-chip md-pressable ${category === c ? "md-chip-selected" : ""}`}>
            <span>{CATEGORY_ICONS[c]}</span> {t(c)}
          </button>
        ))}
      </div>

      <label className="md-pressable" style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 12,
        border: "1.5px dashed var(--md-outline)", borderRadius: "var(--md-radius-m)",
        background: "var(--md-surface-2)", padding: 13, fontSize: 13, cursor: "pointer",
        color: photoB64 ? "#34d399" : "var(--md-on-surface-variant)",
      }}>
        <Icon name="camera" size={17} /> {photoB64 ? "Photo attached ✓" : t("photo")}
        <input type="file" accept="image/*" capture="environment" onChange={handlePhotoChange} className="hidden" style={{ display: "none" }} />
      </label>

      {photoB64 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, color: "#34d399", marginBottom: 6 }}>
            <span>On-device AI pre-screen active</span>
            <button onClick={() => setPhotoB64(null)} className="md-pressable" style={{ border: "none", background: "transparent", color: "#f87171", cursor: "pointer", fontWeight: 700 }}>Remove</button>
          </div>
          <EdgeVisionInspector
            imageSrc={photoB64}
            onAnalysisComplete={(res: FissureAnalysisResult) => {
              if (res.structuralRisk !== "SAFE" && !description.includes("Fissure density")) {
                setDescription(
                  (prev) =>
                    `${prev ? prev + " | " : ""}[Edge CV Analysis: ${res.structuralRisk.replace(/_/g, " ")} | Fissure density: ${res.fissureDensityPct}% | Max crack: ${res.maxCrackWidthPx}px]`
                );
              }
            }}
          />
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        <VoiceRecorder
          onAudioRecorded={(b64, dur) => { setAudioB64(b64); setAudioDuration(dur); }}
          onAudioCleared={() => { setAudioB64(null); setAudioDuration(0); }}
          initialAudioB64={audioB64 || undefined}
          initialDurationSec={audioDuration}
        />
      </div>

      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t("note_ph")}
        rows={2}
        className="md-input"
        style={{ marginTop: 12, resize: "vertical" }}
      />
      <button onClick={save} disabled={sending}
        className="md-btn md-btn-filled md-btn-lg md-btn-block md-pressable" style={{ marginTop: 12 }}>
        {sending ? "Saving…" : t("save")}
      </button>
    </section>
  );
}

/* ---------- login ---------- */
function LoginBar({ apiUrl, onMsg, t }: { apiUrl: string; onMsg: (m: string) => void; t: ReturnType<typeof makeT> }) {
  const [email, setEmail] = useState(() => localStorage.getItem("bh_token_email") || "field.noney@bhrakshak.in");
  const [pw, setPw] = useState("Field@123");
  const logged = !!getStoredToken();
  return (
    <section className="md-card md-rise">
      <h3 className="md-card-title">
        <span className="md-ico"><Icon name={logged ? "check" : "login"} /></span>
        {logged ? `${localStorage.getItem("bh_token_email")}` : "Field login"}
        {logged && (
          <button onClick={async () => {
            localStorage.removeItem("bh_token");
            localStorage.removeItem("bh_token_email");
            onMsg("Logged out");
            setTimeout(() => window.location.reload(), 400);
          }} className="md-pressable" style={{ marginLeft: "auto", border: "none", background: "transparent", color: "#f87171", fontWeight: 700, fontSize: 12, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}>
            <Icon name="logout" size={14} /> Logout
          </button>
        )}
      </h3>
      {!logged && (
        <>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="md-input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" inputMode="email" />
            <input className="md-input" value={pw} onChange={(e) => setPw(e.target.value)} type="password" placeholder="password" style={{ width: 110 }} />
          </div>
          <button className="md-btn md-btn-tonal md-btn-block md-pressable" style={{ marginTop: 10 }}
            onClick={async () => {
              const ok = await loginAndStore(apiUrl, email, pw);
              onMsg(ok ? "✓ Logged in" : "Login failed");
            }}>
            Login
          </button>
          <div style={{ marginTop: 8, fontSize: 11, color: "var(--md-on-surface-variant)" }}>
            Demo: field.noney@bhrakshak.in / Field@123
          </div>
        </>
      )}
    </section>
  );
}

/* ---------- sync queue ---------- */
function QueueSection({ pending, t, online, onSync }: { pending: number; t: ReturnType<typeof makeT>; online: boolean; onSync: () => void }) {
  return (
    <section className="md-card md-rise" style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px" }}>
      <div style={{
        width: 44, height: 44, borderRadius: 14, display: "grid", placeItems: "center",
        background: pending > 0 ? "rgba(249,115,22,.15)" : "rgba(52,211,153,.13)",
        color: pending > 0 ? "var(--md-primary)" : "#34d399",
      }}>
        <Icon name={pending > 0 ? "clock" : "check"} size={20} />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14.5, fontWeight: 800 }}>{pending} {t("pending")}</div>
        <div style={{ fontSize: 11.5, color: "var(--md-on-surface-variant)" }}>
          {online ? "connected — sync anytime" : "will auto-sync when network returns"}
        </div>
      </div>
      <button className="md-btn md-btn-outline md-pressable" onClick={onSync} disabled={!online}>
        <Icon name="sync" size={16} /> {t("send_queue")}
      </button>
    </section>
  );
}

// EmergencyBroadcastBanner is rendered inside the home tab via AlertsPanel;
// kept exported for the district-admin deep link view.
export { EmergencyBroadcastBanner };
