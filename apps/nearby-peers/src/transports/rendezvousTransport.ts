/* Wi-Fi / mobile-data transport: consent-gated announce + geo query against
   a rendezvous endpoint (see server/nearby_router.py — DB-free, RAM-only).

   Works whenever ANY IP path exists: home Wi-Fi, mobile data, or the relay
   peer's hotspot where the API is reachable. No link → announce silently
   fails and retries on the next tick; nothing is persisted client-side
   beyond the last-known position. */

import { DEFAULT_RADIUS_M, MAX_RADIUS_M, MIN_RADIUS_M } from "../config.ts";
import { clamp } from "../geo.ts";
import type { AnnouncePayload, QueryResult } from "../types.ts";

export interface RendezvousOptions {
  apiUrl: string;
  /** Bearer token provider; announce/query 401 gracefully when absent. */
  getToken: () => string | null;
  announcePath?: string;
  queryPath?: string;
  timeoutMs?: number;
  log?: (m: string) => void;
}

export class RendezvousTransport {
  readonly kind = "wifi" as const;
  private o: Required<Pick<RendezvousOptions, "apiUrl" | "getToken">> & RendezvousOptions;

  constructor(opts: RendezvousOptions) {
    this.o = { announcePath: "/api/v1/nearby/announce", queryPath: "/api/v1/nearby/query", timeoutMs: 6000, ...opts };
  }

  private async call<T>(path: string, body: unknown, method: "POST" | "DELETE" = "POST"): Promise<{ status: number; data: T | null }> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.o.timeoutMs!);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const token = this.o.getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      const r = await fetch(`${this.o.apiUrl}${path}`, {
        method, headers, body: body == null ? undefined : JSON.stringify(body), signal: ctl.signal,
      });
      const data = r.ok ? ((await r.json().catch(() => null)) as T | null) : null;
      return { status: r.status, data };
    } finally {
      clearTimeout(t);
    }
  }

  /** One announce tick. Returns false when the link is down / unauthorized. */
  async announce(p: AnnouncePayload): Promise<boolean> {
    try {
      const { status } = await this.call<{ accepted: boolean }>(this.o.announcePath!, p);
      if (status === 401) { this.o.log?.("nearby: announce needs a login"); return false; }
      if (status !== 200) { this.o.log?.(`nearby: announce failed (${status})`); return false; }
      return true;
    } catch {
      return false; // offline — next tick retries
    }
  }


  /** Peers within radius, sorted by distance (server-side hint; the client
      store re-computes from raw coords as the source of truth). */
  async query(lat: number, lon: number, radiusM: number = DEFAULT_RADIUS_M, selfPeerId?: string): Promise<QueryResult[]> {
    try {
      const { status, data } = await this.call<{ peers: QueryResult[] }>(this.o.queryPath!, {
        lat, lon, radius_m: clamp(Math.round(radiusM), MIN_RADIUS_M, MAX_RADIUS_M), self_peer_id: selfPeerId ?? null,
      });
      if (status === 401) { this.o.log?.("nearby: sign in to scan for peers"); return []; }
      if (!data?.peers) { this.o.log?.(`nearby: query failed (${status})`); return []; }
      return data.peers;
    } catch {
      return [];
    }
  }

  /** Privacy: ask the server to drop this peer immediately (consent OFF). */
  async forget(peerId: string): Promise<boolean> {
    try {
      const { status } = await this.call(`/api/v1/nearby/${encodeURIComponent(peerId)}`, null, "DELETE");
      return status === 200 || status === 404;
    } catch {
      return false;
    }
  }
}

