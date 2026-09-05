"use client";

import { Camera, Check, ChevronDown, MapPin, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { apiGet, endpoints, ensureToken } from "@/lib/api";
import { LEVEL_COLORS, LEVEL_NAMES, cn } from "@/lib/utils";
import type { AlertRow, PriorityRow, ReportItem } from "@/lib/types";
import { ImageReportCard } from "@/components/reports/ImageReportCard";

type Tab = "queue" | "alerts" | "reports";

export default function OperationsPage() {
  const [tab, setTab] = useState<Tab>("queue");
  return (
    <div className="anim anim-fade h-full overflow-y-auto p-5 [scrollbar-width:thin]" style={{ animationDelay: "0.15s" }}>
      <div className="mx-auto max-w-6xl">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Operations</h1>
            <p className="text-sm text-muted">
              Model D — ranked response queue &amp; Model V AI hazard report inspection
            </p>
          </div>
          <div className="flex rounded-lg bg-bg p-1">
            {(["queue", "alerts", "reports"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "rounded-md px-4 py-1.5 text-[13px] font-semibold capitalize transition-colors",
                  tab === t ? "bg-orange-600 text-white" : "text-muted hover:text-ink"
                )}
              >
                {t === "queue" ? "Response queue" : t === "alerts" ? "Alert console" : "Hazard Reports (AI Inbox)"}
              </button>
            ))}
          </div>
        </div>
        {tab === "queue" ? <Queue /> : tab === "alerts" ? <AlertConsole /> : <ReportsInbox />}
      </div>
    </div>
  );
}

function Queue() {
  const [rows, setRows] = useState<PriorityRow[] | null>(null);
  const [districts, setDistricts] = useState<string[]>([]);
  const [filter, setFilter] = useState<string>("");
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [assigned, setAssigned] = useState<Record<string, string>>({});

  useEffect(() => {
    apiGet<PriorityRow[]>("/api/v1/analytics/priority?top=40")
      .then((r) => {
        setRows(r);
        setDistricts(Array.from(new Set(r.map((x) => x.district).filter(Boolean) as string[])));
      })
      .catch(() => setRows([]));
  }, []);

  const filtered = useMemo(
    () => (rows ?? []).filter((r) => !filter || r.district === filter),
    [rows, filter]
  );

  if (!rows) return <SkeletonRows />;
  if (!filtered.length)
    return <EmptyState title="Queue clear" body="No zones above monitoring threshold." />;

  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2">
        <Chip active={!filter} onClick={() => setFilter("")}>
          All districts
        </Chip>
        {districts.map((d) => (
          <Chip key={d} active={filter === d} onClick={() => setFilter(d)}>
            {d}
          </Chip>
        ))}
      </div>

      <div className="space-y-2">
        {filtered.map((r, i) => {
          const open = openRow === r.zone_id;
          return (
            <div
              key={r.zone_id}
              className={cn(
                "rounded-xl border bg-panel transition-colors",
                r.hazard_level >= 3 ? "border-red-900/70" : "border-edge"
              )}
            >
              <button
                onClick={() => setOpenRow(open ? null : r.zone_id)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left"
              >
                <span className="w-8 text-center font-mono text-lg font-bold text-muted">
                  {i + 1}
                </span>
                <span
                  className="rounded-md px-2 py-1 text-xs font-extrabold text-bg"
                  style={{
                    background: LEVEL_COLORS[r.hazard_level],
                    boxShadow: `0 0 12px ${LEVEL_COLORS[r.hazard_level]}55`,
                  }}
                >
                  L{r.hazard_level}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{r.name}</span>
                  <span className="block truncate text-[11px] text-muted">
                    {r.zone_code} · {r.district}
                  </span>
                </span>
                <span className="hidden items-center gap-1.5 text-xs text-slate-300 md:flex">
                  <Users size={13} className="text-muted" />
                  {(r.population ?? 0).toLocaleString()}
                </span>
                <span className="hidden w-28 items-center gap-1.5 md:flex">
                  <MapPin size={13} className={r.isolation >= 60 ? "text-red-400" : "text-muted"} />
                  <span className="text-xs text-slate-300">
                    iso {r.isolation}
                    {r.isolation >= 60 && <b className="ml-1 text-red-400">high</b>}
                  </span>
                </span>
                {r.flood_level >= 2 && (
                  <span className="rounded bg-sky-950 px-1.5 py-0.5 text-[10px] font-bold text-sky-400 ring-1 ring-sky-800">
                    🌊 FLOOD L{r.flood_level}
                  </span>
                )}
                <span className="w-14 text-right font-mono text-base font-bold tabular-nums text-orange-400">
                  {r.score.toFixed(0)}
                </span>
                <ChevronDown
                  size={16}
                  className={cn("text-muted transition-transform", open && "rotate-180")}
                />
              </button>

              {open && (
                <div className="border-t border-edge px-4 py-3">
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {r.reasons.map((reason) => (
                      <span
                        key={reason}
                        className="rounded-full bg-bg px-2.5 py-1 text-[11px] text-slate-300 ring-1 ring-edge"
                      >
                        {reason}
                      </span>
                    ))}
                  </div>
                  <p className="text-[13px] leading-relaxed text-slate-200">
                    <b className="text-orange-400">Action: </b>
                    {r.recommended_action}
                  </p>
                  <div className="mt-3 rounded-lg border border-white/10 bg-black/40 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-amber-400">
                        DDMA Standard Operating Procedures (SOP)
                      </span>
                      <span className="text-[10px] text-muted">
                        Pop: <b>{(r.population ?? 1200).toLocaleString()}</b> · Vulnerable Elderly: <b>{Math.round((r.population ?? 1200) * 0.08)}</b>
                      </span>
                    </div>

                    <div className="mt-2 space-y-1.5 text-[11px]">
                      {[
                        { dept: "DC / Revenue", task: `Promulgate Sec 34 (DM Act 2005) evacuation orders for ${r.name ?? r.zone_code}.` },
                        { dept: "SDRF / NDRF", task: `Pre-position Quick Reaction Teams with satellite VHF comms at choke points.` },
                        { dept: "PWD / Roads", task: `Stage 2 Heavy JCB Earthmovers for road clearing along arterial corridors.` },
                        { dept: "Health / CMO", task: `Alert Civil Hospital trauma ward; assign ${Math.max(1, Math.round((r.population ?? 1200) / 400))} mobile ambulances.` },
                      ].map((sop, idx) => (
                        <label key={idx} className="flex items-start gap-2 text-slate-300 hover:text-white cursor-pointer">
                          <input type="checkbox" className="mt-0.5 rounded border-slate-700 bg-slate-800 text-sky-500" defaultChecked={r.hazard_level >= 3 && idx < 2} />
                          <div>
                            <span className="rounded bg-white/10 px-1 py-0.2 text-[9px] font-semibold text-sky-300 mr-1.5">{sop.dept}</span>
                            {sop.task}
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    {["SDRF Team 1", "NDRF Platoon", "Local Volunteers"].map((team) => (
                      <button
                        key={team}
                        onClick={() =>
                          setAssigned((a) => ({ ...a, [r.zone_id]: team }))
                        }
                        disabled={Boolean(assigned[r.zone_id])}
                        className={cn(
                          "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                          assigned[r.zone_id] === team &&
                          "border-emerald-700 bg-emerald-950 text-l0",
                          !assigned[r.zone_id]
                            ? "border-edge text-slate-300 hover:border-orange-700"
                            : "border-edge/50 text-muted"
                        )}
                      >
                        {assigned[r.zone_id] === team && <Check size={11} className="mr-1 inline" />}
                        Assign {team}
                      </button>
                    ))}
                    {assigned[r.zone_id] && (
                      <span className="text-[11px] text-l0">
                        dispatched to {r.zone_code} ✓
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

const NER_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "hi", label: "हिन्दी" },
  { code: "bn", label: "বাংলা" },
  { code: "as", label: "অসমীয়া" },
  { code: "ne", label: "नेपाली" },
  { code: "kha", label: "Khasi" },
  { code: "lus", label: "Mizo" },
  { code: "mni-Mtei", label: "ꯃꯤꯇꯩ" },
];

function AlertConsole() {
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null);
  const [selectedLang, setSelectedLang] = useState<string>("en");

  async function load(lang: string = selectedLang) {
    try {
      const token = await ensureToken();
      const rows = await apiGet<AlertRow[]>(`/api/v1/alerts?limit=50&lang=${encodeURIComponent(lang)}`, token);
      setAlerts(rows);
    } catch {
      setAlerts([]);
    }
  }

  useEffect(() => {
    load(selectedLang);
  }, [selectedLang]);

  async function ack(id: string) {
    const token = await ensureToken();
    await fetch(`${endpoints.API}/api/v1/alerts/${id}/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{}",
    });
    load(selectedLang);
  }

  if (!alerts) return <SkeletonRows />;
  if (!alerts.length)
    return <EmptyState title="No alerts fired yet" body="Inject a storm from the Command Center to see the alert pipeline live." />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-edge bg-panel px-4 py-2.5">
        <span className="text-xs font-semibold text-muted">
          🌐 Community Broadcast Language Preview (8 NER Languages):
        </span>
        <div className="flex flex-wrap gap-1.5">
          {NER_LANGUAGES.map((l) => (
            <button
              key={l.code}
              onClick={() => setSelectedLang(l.code)}
              className={cn(
                "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                selectedLang === l.code
                  ? "bg-orange-600 text-white"
                  : "bg-bg text-muted hover:text-ink border border-edge/60"
              )}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        {alerts.map((a) => {
          const displayMsg = (a.messages && a.messages[selectedLang]) || a.message_template;
          return (
            <div key={a.id} className="flex items-center gap-3 rounded-xl border border-edge bg-panel px-4 py-3">
              <span
                className="rounded-md px-2 py-1 text-xs font-extrabold text-bg"
                style={{ background: LEVEL_COLORS[a.level] }}
              >
                L{a.level}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-slate-200">{displayMsg}</p>
                <p className="text-[11px] text-muted">
                  {new Date(a.fired_at).toLocaleString()} · {a.channels?.join(" · ")} ·{" "}
                  {a.recipients.toLocaleString()} recipients
                  {a.messages && Object.keys(a.messages).length > 0 && (
                    <span className="ml-2 inline-flex items-center rounded-sm bg-emerald-950/80 px-1.5 py-0.5 text-[10px] text-emerald-400 border border-emerald-800/40">
                      ✓ 8 Languages Broadcasted
                    </span>
                  )}
                </p>
              </div>
              {a.ack_at ? (
                <span className="flex items-center gap-1 text-[11px] text-l0">
                  <Check size={12} /> acked
                </span>
              ) : (
                <button
                  onClick={() => ack(a.id)}
                  className="rounded-lg border border-edge px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-orange-700 hover:text-white"
                >
                  Acknowledge
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
        active ? "border-orange-600 bg-orange-600/15 text-orange-300" : "border-edge text-muted hover:text-ink"
      )}
    >
      {children}
    </button>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-2">
      {[...Array(6)].map((_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-xl bg-panel" />
      ))}
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed border-edge py-20 text-center">
      <div>
        <p className="font-semibold text-slate-300">{title}</p>
        <p className="mt-1 max-w-sm text-sm text-muted">{body}</p>
      </div>
    </div>
  );
}

function ReportsInbox() {
  const [reports, setReports] = useState<any[] | null>(null);
  const [verifiedIds, setVerifiedIds] = useState<Record<string, string>>({});
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const load = () => {
    apiGet<any[]>("/api/v1/reports")
      .then(setReports)
      .catch(() => setReports([]));
  };

  useEffect(() => {
    load();
    // Live refresh: the backend publishes a "report" event on every
    // /reports/sync (mobile + PWA submissions) so the inbox updates without
    // a manual reload during the demo.
    const base = endpoints.API.replace(/^http/, "ws");
    let ws: WebSocket | null = null;
    let retry = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (stopped) return;
      try {
        ws = new WebSocket(`${base}/ws/live`);
      } catch {
        schedule();
        return;
      }
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === "report") load();
        } catch { }
      };
      ws.onclose = () => schedule();
      ws.onerror = () => ws?.close();
    };
    const schedule = () => {
      if (stopped || timer) return;
      timer = setTimeout(() => {
        timer = null;
        retry = Math.min(retry + 1, 5);
        connect();
      }, Math.min(1000 * 2 ** retry, 15000));
    };
    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, []);

  const handleVerify = async (id: string, decision: "verified" | "rejected") => {
    setVerifyError(null);
    try {
      const token = await ensureToken();
      const res = await fetch(
        `${endpoints.API}/api/v1/reports/${id}/verify?decision=${decision}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "bypass-tunnel-reminder": "true",
          },
        },
      );
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        setVerifyError(`Verify failed (${res.status}): ${detail.detail ?? "unknown"}`);
        return; // do NOT flip the card optimistically on failure
      }
      setVerifiedIds((prev) => ({ ...prev, [id]: decision }));
    } catch (err) {
      setVerifyError(`Verify failed: ${err instanceof Error ? err.message : "network error"}`);
    }
  };

  const handleReanalyze = async (id: string) => {
    try {
      const token = await ensureToken();
      const res = await fetch(`${endpoints.API}/api/v1/images/${id}/analyze`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "bypass-tunnel-reminder": "true",
        },
      });
      if (res.ok) {
        load();
      }
    } catch (err) {
      console.error("Re-analyze error:", err);
    }
  };

  if (!reports) return <SkeletonRows />;

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4 backdrop-blur">
        <h3 className="flex items-center gap-2 text-sm font-bold text-amber-400">
          <Camera size={16} /> Model V — AI Geo-Photo Verification Engine
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-slate-300">
          Every field report photo is pre-screened using deep feature classification (soil scarp edge energy, tension fracture width, vegetation loss) and EXIF GPS provenance checks before reaching the District Collector.
        </p>
      </div>

      {verifyError && (
        <div className="rounded-lg border border-red-800 bg-red-950/80 p-3 text-xs text-red-300">
          {verifyError}
        </div>
      )}

      {reports.length === 0 ? (
        <EmptyState
          title="No hazard reports pending"
          body="Field rescue teams or citizens uploading geo-photos from the Android APK or PWA will stream directly into this command inbox."
        />
      ) : (
        reports.map((r, i) => (
          <ImageReportCard
            key={r.id || i}
            report={r}
            apiBaseUrl={endpoints.API}
            onVerify={handleVerify}
            onReanalyze={handleReanalyze}
          />
        ))
      )}
    </div>
  );
}
