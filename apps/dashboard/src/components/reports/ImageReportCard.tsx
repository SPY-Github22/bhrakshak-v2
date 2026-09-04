"use client";

import React, { useState } from "react";
import { Camera, Check, X, RefreshCw, ZoomIn, AlertTriangle, ShieldCheck, MapPin } from "lucide-react";

export interface ReportAiAnalysis {
  verdict: "POSITIVE" | "POSSIBLE" | "NEGATIVE" | string;
  probability?: number;
  gps_mismatch_m?: number | null;
  flags?: string[];
  signature?: {
    fresh_soil_frac?: number;
    horizontal_edge_energy?: number;
    vegetation_frac?: number;
    rock_frac?: number;
  };
}

export interface ImageReportItem {
  id: string;
  category: string;
  role?: string | null;
  description?: string | null;
  created_at?: string;
  lat?: number | null;
  lon?: number | null;
  dup_count?: number;
  exif_geo_ok?: boolean | null;
  image_url?: string | null;
  ai_analysis?: ReportAiAnalysis | null;
  status?: "pending" | "verified" | "rejected" | string;
}

interface ImageReportCardProps {
  report: ImageReportItem;
  apiBaseUrl?: string;
  onVerify?: (id: string, decision: "verified" | "rejected") => Promise<void> | void;
  onReanalyze?: (id: string) => Promise<void> | void;
}

export function ImageReportCard({
  report,
  apiBaseUrl = "",
  onVerify,
  onReanalyze,
}: ImageReportCardProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [statusOverride, setStatusOverride] = useState<string | null>(null);

  const status = statusOverride || report.status || "pending";
  const analysis = report.ai_analysis;

  // Build full image URL if relative
  const fullImageUrl = report.image_url
    ? report.image_url.startsWith("http")
      ? report.image_url
      : `${apiBaseUrl.replace(/\/$/, "")}${report.image_url}`
    : null;

  const handleAction = async (decision: "verified" | "rejected") => {
    setStatusOverride(decision);
    if (onVerify) {
      try {
        await onVerify(report.id, decision);
      } catch (err) {
        setStatusOverride(null);
      }
    }
  };

  const handleReanalyze = async () => {
    if (!onReanalyze || reanalyzing) return;
    setReanalyzing(true);
    try {
      await onReanalyze(report.id);
    } finally {
      setReanalyzing(false);
    }
  };

  const verdictColor =
    analysis?.verdict === "POSITIVE"
      ? "text-emerald-400 bg-emerald-950/60 border-emerald-700/50"
      : analysis?.verdict === "POSSIBLE"
      ? "text-amber-400 bg-amber-950/60 border-amber-700/50"
      : "text-slate-400 bg-slate-900 border-slate-700";

  return (
    <>
      <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-4 shadow-xl backdrop-blur transition-all hover:border-slate-700">
        {/* Top Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-orange-950/60 ring-1 ring-orange-700/50">
              <Camera size={20} className="text-orange-400" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-orange-600/20 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-orange-400 ring-1 ring-orange-600/40">
                  {report.category || "hazard"}
                </span>
                <span className="text-xs text-slate-400">
                  Author: <b className="text-slate-200">{report.role || "citizen"}</b> ·{" "}
                  {report.created_at ? new Date(report.created_at).toLocaleTimeString() : "Just now"}
                </span>
              </div>

              {/* Citizen's Own Message */}
              <div className="mt-2 rounded-lg bg-slate-950/70 p-2.5 border border-slate-800/80">
                <p className="text-[11px] font-semibold text-amber-300/90 uppercase tracking-wider">
                  Citizen / Field Note:
                </p>
                <p className="mt-0.5 text-sm font-medium leading-snug text-slate-100">
                  "{report.description || "No message attached"}"
                </p>
              </div>

              {/* Geo & EXIF metadata */}
              <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[11px] text-slate-400">
                <span className="flex items-center gap-1">
                  <MapPin size={12} className="text-orange-400" />
                  Lat: <b>{report.lat != null ? Number(report.lat).toFixed(4) : "n/a"}</b>, Lon:{" "}
                  <b>{report.lon != null ? Number(report.lon).toFixed(4) : "n/a"}</b>
                </span>
                <span>DUPs: <b>{report.dup_count || 0}</b></span>
                {report.exif_geo_ok === true && (
                  <span className="text-emerald-400 font-semibold flex items-center gap-0.5">
                    <ShieldCheck size={12} /> EXIF Geo-Match Verified
                  </span>
                )}
                {report.exif_geo_ok === false && (
                  <span className="text-amber-400 font-semibold flex items-center gap-0.5">
                    <AlertTriangle size={12} /> EXIF Mismatch
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2">
            {status === "verified" ? (
              <span className="rounded-lg bg-emerald-950 px-3 py-1.5 text-xs font-bold text-emerald-400 ring-1 ring-emerald-700 flex items-center gap-1">
                <Check size={14} /> Verified by DC
              </span>
            ) : status === "rejected" ? (
              <span className="rounded-lg bg-red-950 px-3 py-1.5 text-xs font-bold text-red-400 ring-1 ring-red-700 flex items-center gap-1">
                <X size={14} /> Rejected False Alarm
              </span>
            ) : (
              <>
                <button
                  onClick={() => handleAction("verified")}
                  className="rounded-lg border border-emerald-700 bg-emerald-950/80 px-3 py-1.5 text-xs font-bold text-emerald-300 transition-all hover:bg-emerald-900 hover:text-white"
                >
                  ✅ Verify
                </button>
                <button
                  onClick={() => handleAction("rejected")}
                  className="rounded-lg border border-red-900 bg-red-950/60 px-3 py-1.5 text-xs font-semibold text-red-400 transition-all hover:bg-red-900 hover:text-white"
                >
                  ✕ Reject
                </button>
              </>
            )}
          </div>
        </div>

        {/* Image & AI Analysis Grid */}
        <div className="mt-3.5 grid grid-cols-1 md:grid-cols-12 gap-3">
          {/* Photo Thumbnail */}
          {fullImageUrl ? (
            <div className="md:col-span-4 relative group rounded-lg overflow-hidden border border-slate-700 bg-black aspect-video md:aspect-auto md:h-36">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={fullImageUrl}
                alt="Field report capture"
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
              />
              <button
                onClick={() => setModalOpen(true)}
                className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1.5 text-xs font-semibold text-white backdrop-blur-[2px]"
              >
                <ZoomIn size={16} /> Click to enlarge
              </button>
              <div className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-slate-300 font-mono">
                Field Photo
              </div>
            </div>
          ) : (
            <div className="md:col-span-4 grid place-items-center rounded-lg border border-dashed border-slate-800 bg-slate-950/40 p-4 text-center">
              <span className="text-[11px] text-slate-500 flex items-center gap-1">
                <Camera size={14} /> No photo uploaded
              </span>
            </div>
          )}

          {/* Model V AI Vision Analysis */}
          <div className={fullImageUrl ? "md:col-span-8" : "md:col-span-8"}>
            {analysis ? (
              <div className="h-full rounded-lg border border-white/10 bg-black/60 p-3 flex flex-col justify-between">
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-orange-400 flex items-center gap-1.5">
                      Model V AI Vision Verdict:
                      <span className={`px-2 py-0.5 rounded border text-xs font-extrabold ${verdictColor}`}>
                        {analysis.verdict} ({Math.round((analysis.probability ?? 0) * 100)}%)
                      </span>
                    </span>

                    {onReanalyze && fullImageUrl && (
                      <button
                        onClick={handleReanalyze}
                        disabled={reanalyzing}
                        className="rounded border border-slate-700 bg-slate-800/80 px-2 py-1 text-[11px] font-medium text-slate-300 hover:text-white hover:border-orange-600 transition flex items-center gap-1"
                      >
                        <RefreshCw size={11} className={reanalyzing ? "animate-spin" : ""} />
                        {reanalyzing ? "Analyzing..." : "Re-analyze"}
                      </button>
                    )}
                  </div>

                  {/* Feature Breakdown */}
                  <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                    <div className="rounded bg-slate-900/80 p-1.5 border border-slate-800">
                      <span className="text-slate-400 block text-[10px]">Fresh Soil:</span>
                      <b className="text-orange-300 font-mono">
                        {analysis.signature?.fresh_soil_frac != null
                          ? `${(analysis.signature.fresh_soil_frac * 100).toFixed(1)}%`
                          : "n/a"}
                      </b>
                    </div>
                    <div className="rounded bg-slate-900/80 p-1.5 border border-slate-800">
                      <span className="text-slate-400 block text-[10px]">Scarp Energy:</span>
                      <b className="text-sky-300 font-mono">
                        {analysis.signature?.horizontal_edge_energy != null
                          ? analysis.signature.horizontal_edge_energy.toFixed(2)
                          : "n/a"}
                      </b>
                    </div>
                    <div className="rounded bg-slate-900/80 p-1.5 border border-slate-800">
                      <span className="text-slate-400 block text-[10px]">Vegetation:</span>
                      <b className="text-emerald-300 font-mono">
                        {analysis.signature?.vegetation_frac != null
                          ? `${(analysis.signature.vegetation_frac * 100).toFixed(1)}%`
                          : "n/a"}
                      </b>
                    </div>
                  </div>
                </div>

                <div className="mt-2 text-[11px] text-slate-400 flex flex-wrap items-center justify-between gap-1">
                  <span>
                    {analysis.gps_mismatch_m != null
                      ? `EXIF GPS delta ${analysis.gps_mismatch_m} m`
                      : "No EXIF GPS in image"}
                  </span>
                  {(analysis.flags ?? []).length > 0 && (
                    <span className="text-[10px] text-amber-400 font-semibold">
                      ⚠ {analysis.flags?.join(" · ")}
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div className="h-full rounded-lg border border-dashed border-white/10 bg-black/30 p-4 flex items-center justify-between">
                <span className="text-xs text-slate-500">
                  No vision analysis attached yet.
                </span>
                {onReanalyze && fullImageUrl && (
                  <button
                    onClick={handleReanalyze}
                    disabled={reanalyzing}
                    className="rounded border border-orange-700 bg-orange-950/60 px-2.5 py-1 text-xs font-semibold text-orange-300 hover:bg-orange-900 transition flex items-center gap-1.5"
                  >
                    <RefreshCw size={12} className={reanalyzing ? "animate-spin" : ""} />
                    Analyze with Model V
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Lightbox Modal */}
      {modalOpen && fullImageUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={() => setModalOpen(false)}
        >
          <div
            className="relative max-w-4xl max-h-[90vh] overflow-hidden rounded-xl border border-slate-700 bg-slate-950 p-2 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-2 px-2">
              <span className="text-xs font-bold text-slate-300">
                Field Photo — {report.category} ({report.id})
              </span>
              <button
                onClick={() => setModalOpen(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white transition"
              >
                <X size={18} />
              </button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={fullImageUrl}
              alt="Enlarged field report"
              className="max-h-[75vh] w-auto mx-auto object-contain rounded-lg"
            />
            {report.description && (
              <p className="mt-2 text-xs text-slate-300 text-center font-medium bg-slate-900/80 p-2 rounded">
                "{report.description}"
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
