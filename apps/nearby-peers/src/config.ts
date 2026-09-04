/* Tuning constants for nearby-peers. Everything an integrator may want to
   change lives here — the rest of the module reads these defaults. */

/* ---- BLE beacon identity ------------------------------------------------- */
/** Manufacturer-specific-data company id used for the beacon. 0xFFFF is the
    Bluetooth SIG reserved id for internal use/testing — correct for a demo
    and for offline disaster use where no SIG id is registered. */
export const NEARBY_MANUFACTURER_ID = 0xffff;
export const NEARBY_FRAME_MAGIC = 0xb8; // "Bh"
export const NEARBY_FRAME_VERSION = 0x01;
/** magic(1)+ver(1)+flags(1)+seq(2)+peer(4)+role(1)+batt(1)+lat(4)+lon(4)+acc(1)+crc(1) */
export const NEARBY_FRAME_LEN = 21;

/* ---- Timing -------------------------------------------------------------- */
export const ANNOUNCE_INTERVAL_MS = 20_000;
export const ANNOUNCE_JITTER_MS = 5_000;
export const QUERY_INTERVAL_MS = 15_000;
export const QUERY_JITTER_MS = 4_000;
export const SWEEP_INTERVAL_MS = 10_000;
/** BLE scans in duty-cycle windows: scan 12s, rest 3s (battery + radio duty). */
export const BLE_SCAN_WINDOW_MS = 12_000;
export const BLE_SCAN_REST_MS = 3_000;
/** How long a peer stays visible in the on-device store without a refresh. */
export const CLIENT_PEER_TTL_MS = 90_000;

/* ---- Server-side (mirror of server/nearby_router.py) ---------------------- */
export const SERVER_PEER_TTL_S = 600;
export const DEFAULT_RADIUS_M = 500;
export const MIN_RADIUS_M = 50;
export const MAX_RADIUS_M = 10_000;
export const MAX_PEERS_RETURNED = 200;

/* ---- RSSI → distance model (log-distance path loss) ----------------------- */
/** RSSI nominally measured at 1 m from a phone-class advertiser. */
export const TX_POWER_AT_1M = -59;
/** Indoor/urban clutter exponent — 2.2 works well for open landslide debris. */
export const PATH_LOSS_EXPONENT = 2.2;

/* ---- localStorage keys (prefix your app if you rename them) ---------------- */
export const CONSENT_KEY = "bh_nearby_consent";
export const PEER_ID_KEY = "bh_nearby_peer_id";
export const PEER_ID_DAY_KEY = "bh_nearby_peer_id_day";
export const ALIAS_KEY = "bh_nearby_alias";
export const NEEDS_HELP_KEY = "bh_nearby_needs_help";
