/* NearbyTacticalMap — Zero-dependency, disaster-resilient multi-peer tactical map.
   Renders the rescuer's real-time position, device compass orientation cone,
   concentric metric distance radar rings, and ALL nearby citizens simultaneously.
   Draws active bearing vectors/lines from the rescuer directly to each citizen,
   highlighting SOS survivors with urgent alerts and distance tags. */

import React, { useMemo, useState } from "react";
import { formatDistance, formatAge } from "../geo.ts";
import { bearingTo, distanceTo } from "../navigation.ts";
import type { PeerInfo } from "../types.ts";

export interface TacticalMapProps {
  peers: PeerInfo[];
  selfPos: { lat: number; lon: number; accuracyM?: number | null } | null;
  heading?: number | null; // degrees clockwise from North
  selectedPeerId?: string | null;
  onSelectPeer?: (peerId: string) => void;
  height?: number | string;
}

const RAD = Math.PI / 180;
const METERS_PER_DEG_LAT = 111_139;

export function NearbyTacticalMap({
  peers,
  selfPos,
  heading = null,
  selectedPeerId = null,
  onSelectPeer,
  height = 360,
}: TacticalMapProps) {
  // Zoom level: radius in meters visible from center to boundary
  const [viewRadiusM, setViewRadiusM] = useState<number>(150);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [dragState, setDragState] = useState<{ startX: number; startY: number; initX: number; initY: number } | null>(null);
  const [orientWithCompass, setOrientWithCompass] = useState<boolean>(false);

  // Filter and calculate relative metric offsets (dx meters east, dy meters north)
  const peerPositions = useMemo(() => {
    const rescuerLat = selfPos?.lat ?? 0;
    const rescuerLon = selfPos?.lon ?? 0;
    const cosLat = selfPos ? Math.cos(rescuerLat * RAD) : 1;

    return peers.map((p, index) => {
      let dx = 0;
      let dy = 0;
      let hasExactCoords = false;
      const distM = distanceTo(selfPos, p);
      const bDeg = bearingTo(selfPos, p);

      if (selfPos && p.lat != null && p.lon != null) {
        // Precise equirectangular local metric projection
        dx = (p.lon - rescuerLon) * METERS_PER_DEG_LAT * cosLat;
        dy = (p.lat - rescuerLat) * METERS_PER_DEG_LAT;
        hasExactCoords = true;
      } else if (distM != null) {
        // BLE-only / buried victim without GPS fix
        // Distribute over a circular radar angle so multiple buried victims don't overlap
        const angleDeg = bDeg != null ? bDeg : ((index * 67) % 360);
        const rad = angleDeg * RAD;
        dx = Math.sin(rad) * distM;
        dy = Math.cos(rad) * distM;
      }

      return {
        peer: p,
        dx, // meters east
        dy, // meters north
        hasExactCoords,
        distanceM: distM,
        bearingDeg: bDeg,
      };
    });
  }, [peers, selfPos]);

  // Adjust zoom to encompass all peers or reset
  const fitAll = () => {
    setPanOffset({ x: 0, y: 0 });
    if (peerPositions.length === 0) {
      setViewRadiusM(150);
      return;
    }
    const maxDist = Math.max(...peerPositions.map((p) => Math.hypot(p.dx, p.dy)));
    setViewRadiusM(Math.min(3000, Math.max(50, Math.ceil(maxDist * 1.35))));
  };

  const centerOnRescuer = () => {
    setPanOffset({ x: 0, y: 0 });
  };

  // SVG Dimensioning
  const svgSize = 400;
  const center = svgSize / 2;
  const scale = (svgSize * 0.44) / Math.max(20, viewRadiusM); // pixels per meter

  // Rotation angle for map canvas if orientation lock is on
  const mapRotation = orientWithCompass && heading != null ? -heading : 0;

  // Selected peer details
  const selectedItem = peerPositions.find((p) => p.peer.peerId === selectedPeerId);

  // Drag pan handlers
  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    setDragState({
      startX: e.clientX,
      startY: e.clientY,
      initX: panOffset.x,
      initY: panOffset.y,
    });
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    setPanOffset({
      x: dragState.initX + dx,
      y: dragState.initY + dy,
    });
  };

  const handlePointerUp = () => {
    setDragState(null);
  };

  // Dynamic tactical concentric rings based on current zoom
  const rings = useMemo(() => {
    const r = viewRadiusM;
    if (r <= 60) return [10, 25, 50];
    if (r <= 160) return [25, 50, 100];
    if (r <= 400) return [50, 100, 250];
    if (r <= 1000) return [100, 250, 500];
    return [250, 500, 1000, 2000];
  }, [viewRadiusM]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--md-surface-2, #111827)",
        border: "1px solid var(--md-outline, rgba(255,255,255,.12))",
        borderRadius: "var(--md-radius-l, 16px)",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* Top Map Bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          background: "rgba(15, 23, 42, 0.75)",
          borderBottom: "1px solid rgba(255,255,255,.08)",
          fontSize: 12,
          fontWeight: 700,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "#38bdf8" }}>🗺️ TACTICAL RADAR</span>
          <span
            style={{
              fontSize: 10,
              padding: "2px 6px",
              borderRadius: 999,
              background: "rgba(56,189,248,.16)",
              color: "#38bdf8",
            }}
          >
            {peerPositions.length} {peerPositions.length === 1 ? "person" : "people"}
          </span>
          {peerPositions.some((p) => p.peer.needsHelp) && (
            <span
              style={{
                fontSize: 10,
                padding: "2px 6px",
                borderRadius: 999,
                background: "rgba(248,113,113,.2)",
                color: "#f87171",
              }}
            >
              ⚠ SOS ACTIVE
            </span>
          )}
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 4 }}>
          <button
            type="button"
            title="Auto-fit all peers"
            onClick={fitAll}
            className="md-pressable"
            style={{
              background: "rgba(255,255,255,.08)",
              border: "1px solid rgba(255,255,255,.15)",
              borderRadius: 6,
              color: "#e2e8f0",
              padding: "3px 7px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            ⛶ Fit
          </button>
          <button
            type="button"
            title="Center on rescuer"
            onClick={centerOnRescuer}
            className="md-pressable"
            style={{
              background: "rgba(255,255,255,.08)",
              border: "1px solid rgba(255,255,255,.15)",
              borderRadius: 6,
              color: "#e2e8f0",
              padding: "3px 7px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            🎯 Me
          </button>
          <button
            type="button"
            title="Toggle Compass Alignment"
            onClick={() => setOrientWithCompass((v) => !v)}
            className="md-pressable"
            style={{
              background: orientWithCompass ? "rgba(56,189,248,.25)" : "rgba(255,255,255,.08)",
              border: orientWithCompass ? "1px solid #38bdf8" : "1px solid rgba(255,255,255,.15)",
              borderRadius: 6,
              color: orientWithCompass ? "#38bdf8" : "#e2e8f0",
              padding: "3px 7px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            🧭 {orientWithCompass ? "Head-Up" : "North-Up"}
          </button>
        </div>
      </div>

      {/* Main Map SVG Viewport */}
      <div
        style={{
          position: "relative",
          width: "100%",
          height: typeof height === "number" ? `${height}px` : height,
          background: "radial-gradient(circle at center, #0e1726 0%, #080d1a 100%)",
          overflow: "hidden",
          touchAction: "none",
          userSelect: "none",
        }}
      >
        <svg
          viewBox={`0 0 ${svgSize} ${svgSize}`}
          style={{ width: "100%", height: "100%", cursor: dragState ? "grabbing" : "grab" }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <defs>
            {/* Grid pattern */}
            <pattern id="tactical-grid" width="20" height="20" patternUnits="userSpaceOnUse">
              <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(56,189,248,0.06)" strokeWidth="0.5" />
            </pattern>

            {/* Gradient for rescuer orientation cone */}
            <radialGradient id="cone-grad" cx="50%" cy="100%" r="90%">
              <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.45" />
              <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
            </radialGradient>

            {/* Pulsing SOS ring animation */}
            <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" />
              <feMerge>
                <feMergeNode />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Metric Grid Background */}
          <rect width={svgSize} height={svgSize} fill="url(#tactical-grid)" />

          {/* Compass Rose Header (Cardinal North indicator) */}
          <g transform={`translate(${center}, ${center})`}>
            {/* Rotatable Map Group (pans and rotates with compass if active) */}
            <g
              transform={`translate(${panOffset.x}, ${panOffset.y}) rotate(${mapRotation})`}
              style={{ transition: dragState ? "none" : "transform 0.15s ease-out" }}
            >
              {/* Concentric Distance Radar Rings */}
              {rings.map((dist) => {
                const ringPx = dist * scale;
                return (
                  <g key={dist}>
                    <circle
                      cx="0"
                      cy="0"
                      r={ringPx}
                      fill="none"
                      stroke="rgba(148, 163, 184, 0.22)"
                      strokeWidth="1"
                      strokeDasharray="4 5"
                    />
                    <text
                      x="4"
                      y={-ringPx + 11}
                      fill="rgba(148, 163, 184, 0.6)"
                      fontSize="9"
                      fontFamily="sans-serif"
                      fontWeight="600"
                    >
                      {dist}m
                    </text>
                  </g>
                );
              })}

              {/* Crosshair Axes */}
              <line x1={-svgSize} y1="0" x2={svgSize} y2="0" stroke="rgba(148, 163, 184, 0.12)" strokeWidth="1" />
              <line x1="0" y1={-svgSize} x2="0" y2={svgSize} stroke="rgba(148, 163, 184, 0.12)" strokeWidth="1" />

              {/* Cardinal Labels */}
              <text x="0" y={-center + 20} textAnchor="middle" fill="#38bdf8" fontSize="10" fontWeight="800">
                N
              </text>
              <text x={center - 15} y="4" textAnchor="middle" fill="rgba(148,163,184,.6)" fontSize="9" fontWeight="700">
                E
              </text>
              <text x="0" y={center - 10} textAnchor="middle" fill="rgba(148,163,184,.6)" fontSize="9" fontWeight="700">
                S
              </text>
              <text x={-center + 15} y="4" textAnchor="middle" fill="rgba(148,163,184,.6)" fontSize="9" fontWeight="700">
                W
              </text>

              {/* Direction Vectors / Bearing Lines from Rescuer to Each Citizen */}
              {peerPositions.map(({ peer, dx, dy, distanceM, hasExactCoords }) => {
                const px = dx * scale;
                const py = -dy * scale; // SVG y is downward, North (dy > 0) is upward
                const isSelected = peer.peerId === selectedPeerId;
                const isSos = peer.needsHelp;
                const strokeColor = isSos ? "#f87171" : isSelected ? "#38bdf8" : "rgba(56,189,248,0.45)";
                const midX = px / 2;
                const midY = py / 2;

                return (
                  <g key={`vector-${peer.peerId}`} pointerEvents="none">
                    {/* Bearing Ray Line */}
                    <line
                      x1="0"
                      y1="0"
                      x2={px}
                      y2={py}
                      stroke={strokeColor}
                      strokeWidth={isSelected ? "2.5" : isSos ? "1.8" : "1.2"}
                      strokeDasharray={hasExactCoords ? (isSelected ? "none" : "3 3") : "5 5"}
                      opacity={isSelected ? 1 : 0.75}
                    />

                    {/* Midpoint Distance Badge */}
                    {distanceM != null && (
                      <g transform={`translate(${midX}, ${midY})`}>
                        <rect
                          x="-19"
                          y="-8"
                          width="38"
                          height="16"
                          rx="4"
                          fill="rgba(15, 23, 42, 0.85)"
                          stroke={strokeColor}
                          strokeWidth="0.8"
                        />
                        <text
                          x="0"
                          y="3.5"
                          textAnchor="middle"
                          fill={isSos ? "#fca5a5" : "#e2e8f0"}
                          fontSize="8.5"
                          fontWeight="700"
                        >
                          {formatDistance(distanceM)}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}

              {/* Rescuer Marker (At Center: 0, 0) */}
              <g>
                {/* Orientation Cone (Flashlight beam showing phone's magnetometer heading) */}
                {heading != null && !orientWithCompass && (
                  <g transform={`rotate(${heading})`}>
                    <path
                      d={`M 0 0 L ${-scale * 45} ${-scale * 80} A ${scale * 90} ${scale * 90} 0 0 1 ${scale * 45} ${-scale * 80} Z`}
                      fill="url(#cone-grad)"
                    />
                    <line x1="0" y1="0" x2="0" y2={-scale * 80} stroke="#38bdf8" strokeWidth="1.5" strokeDasharray="3 3" />
                  </g>
                )}

                {/* Rescuer Pulse Halo */}
                <circle cx="0" cy="0" r="14" fill="rgba(56, 189, 248, 0.2)" />
                {/* Center Core */}
                <circle cx="0" cy="0" r="7" fill="#38bdf8" stroke="#ffffff" strokeWidth="2" />
                <circle cx="0" cy="0" r="2.5" fill="#0c4a6e" />
                <text x="0" y="22" textAnchor="middle" fill="#38bdf8" fontSize="9" fontWeight="800">
                  RESCUER (YOU)
                </text>
              </g>

              {/* Citizen Markers (Multiple Citizens) */}
              {peerPositions.map(({ peer, dx, dy, distanceM, hasExactCoords }) => {
                const px = dx * scale;
                const py = -dy * scale;
                const isSelected = peer.peerId === selectedPeerId;
                const isSos = peer.needsHelp;
                const color = isSos ? "#ef4444" : "#38bdf8";

                return (
                  <g
                    key={`peer-${peer.peerId}`}
                    transform={`translate(${px}, ${py})`}
                    style={{ cursor: "pointer" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectPeer?.(peer.peerId);
                    }}
                  >
                    {/* Pulsing Selection Halo */}
                    {isSelected && (
                      <circle cx="0" cy="0" r="20" fill="none" stroke="#38bdf8" strokeWidth="2" strokeDasharray="4 3" />
                    )}

                    {/* SOS Warning Ring */}
                    {isSos && (
                      <circle
                        cx="0"
                        cy="0"
                        r="16"
                        fill="rgba(239, 68, 68, 0.25)"
                        stroke="#ef4444"
                        strokeWidth="1.5"
                        filter="url(#glow)"
                      />
                    )}

                    {/* Marker Outer Bubble */}
                    <circle
                      cx="0"
                      cy="0"
                      r={isSos ? 9.5 : 8}
                      fill={color}
                      stroke="#ffffff"
                      strokeWidth={isSelected ? "2.5" : "1.5"}
                    />

                    {/* Icon / Role Badge inside */}
                    <circle cx="0" cy="0" r={isSos ? 4 : 3} fill="#0f172a" />

                    {/* Peer Label & SOS Callout */}
                    <g transform="translate(0, -14)" pointerEvents="none">
                      <rect
                        x="-24"
                        y="-12"
                        width="48"
                        height="13"
                        rx="3"
                        fill="rgba(15, 23, 42, 0.9)"
                        stroke={color}
                        strokeWidth="0.8"
                      />
                      <text
                        x="0"
                        y="-3"
                        textAnchor="middle"
                        fill={isSos ? "#fca5a5" : "#e2e8f0"}
                        fontSize="8"
                        fontWeight="800"
                      >
                        {isSos ? `SOS · ${peer.alias}` : peer.alias}
                      </text>
                    </g>

                    {/* Accuracy or Buried estimate indicator */}
                    {!hasExactCoords && (
                      <text x="0" y="16" textAnchor="middle" fill="rgba(148, 163, 184, 0.85)" fontSize="7.5" fontWeight="600">
                        (BLE range)
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </g>
        </svg>

        {/* Zoom Controls Overlay */}
        <div
          style={{
            position: "absolute",
            bottom: 12,
            right: 12,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            zIndex: 10,
          }}
        >
          <button
            type="button"
            onClick={() => setViewRadiusM((r) => Math.max(25, Math.round(r * 0.7)))}
            className="md-pressable"
            title="Zoom in"
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "rgba(15, 23, 42, 0.9)",
              border: "1px solid rgba(255,255,255,0.2)",
              color: "#e2e8f0",
              fontWeight: 800,
              fontSize: 16,
              cursor: "pointer",
              display: "grid",
              placeItems: "center",
            }}
          >
            +
          </button>
          <button
            type="button"
            onClick={() => setViewRadiusM((r) => Math.min(3000, Math.round(r * 1.4)))}
            className="md-pressable"
            title="Zoom out"
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "rgba(15, 23, 42, 0.9)",
              border: "1px solid rgba(255,255,255,0.2)",
              color: "#e2e8f0",
              fontWeight: 800,
              fontSize: 16,
              cursor: "pointer",
              display: "grid",
              placeItems: "center",
            }}
          >
            −
          </button>
        </div>

        {/* Legend Overlay */}
        <div
          style={{
            position: "absolute",
            top: 10,
            left: 10,
            pointerEvents: "none",
            fontSize: 10,
            color: "rgba(148, 163, 184, 0.85)",
            background: "rgba(15, 23, 42, 0.7)",
            padding: "4px 8px",
            borderRadius: 6,
            backdropFilter: "blur(4px)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          Radius: <b>{viewRadiusM} m</b> · Drag to pan
        </div>
      </div>

      {/* Bottom Selected Peer Telemetry Strip */}
      {selectedItem && (
        <div
          style={{
            padding: "10px 14px",
            background: "rgba(15, 23, 42, 0.95)",
            borderTop: "1px solid rgba(255,255,255,.1)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <b style={{ fontSize: 13, color: selectedItem.peer.needsHelp ? "#f87171" : "#38bdf8" }}>
                {selectedItem.peer.alias}
              </b>
              {selectedItem.peer.needsHelp && (
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 800,
                    background: "rgba(248,113,113,.2)",
                    color: "#f87171",
                    padding: "2px 6px",
                    borderRadius: 999,
                  }}
                >
                  SOS
                </span>
              )}
              <span style={{ fontSize: 9.5, color: "var(--md-on-surface-variant, #94a3b8)" }}>
                {selectedItem.peer.source.toUpperCase()} · seen {formatAge(Date.now() - selectedItem.peer.lastSeen)}
              </span>
            </div>

            <div style={{ fontSize: 11, color: "var(--md-on-surface, #e2e8f0)", marginTop: 2 }}>
              Distance: <b>{formatDistance(selectedItem.distanceM)}</b>
              {selectedItem.bearingDeg != null && <> · Bearing: <b>{Math.round(selectedItem.bearingDeg)}°</b></>}
              {selectedItem.peer.batteryPct != null && <> · Battery: <b>{selectedItem.peer.batteryPct}%</b></>}
              {selectedItem.peer.rssi != null && <> · RSSI: <b>{selectedItem.peer.rssi} dBm</b></>}
            </div>
          </div>

          <button
            type="button"
            onClick={() => onSelectPeer?.(selectedItem.peer.peerId)}
            className="md-pressable"
            style={{
              border: "none",
              borderRadius: 999,
              padding: "6px 14px",
              fontSize: 11.5,
              fontWeight: 800,
              background: selectedItem.peer.needsHelp ? "#ef4444" : "#38bdf8",
              color: "#06121f",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            🎯 Lock & Guide
          </button>
        </div>
      )}
    </div>
  );
}
