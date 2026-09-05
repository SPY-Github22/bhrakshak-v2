export interface KpisOut {
  zones_l3_l4: number;
  alerts_today: number;
  pending_reports: number;
  sensors_online: number;
  total_zones: number;
}

export interface DdmaSop {
  dept: string;
  task: string;
}

export interface DcDirective {
  level: number;
  urgency: string;
  headline: string;
  evacuation_plan: string;
  ndrf_deployment: string;
  machinery_positioning: string;
  traffic_advisory: string;
  medical_standby: string;
  demographics?: {
    total_population: number;
    elderly_count: number;
    children_under_5: number;
    special_needs: number;
    ambulances_assigned: number;
  };
  ddma_sop_checklist?: DdmaSop[];
}

export interface Driver {
  feature: string;
  name?: string;
  value: string | number;
  val_num?: number;
  contribution: number;
  description?: string;
}

export interface ZoneOut {
  id: string;
  zone_code: string;
  name: string | null;
  district: string | null;
  state: string | null;
  susc_mean: number | null;
  susc_p90: number | null;
  population: number | null;
  road_km: number | null;
  hazard_level: number;
  prob_24h: number | null;
}

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

export interface ReportItem {
  id: string;
  category: string;
  role?: string | null;
  description?: string | null;
  status: string;
  created_at: string;
  lat?: number | null;
  lon?: number | null;
  dup_count?: number;
  exif_geo_ok?: boolean | null;
  image_url?: string | null;
  ai_analysis?: ReportAiAnalysis | null;
}

export interface Dossier {
  zone: ZoneOut;
  rainfall_series: { ts: string; rain_1h: number | null; rain_24h: number | null; eff_rain?: number | null; soil_moisture?: number | null }[];
  sensors: { sensor_id: string; ts: string; soil_moisture: number | null }[];
  reports: ReportItem[];
  alerts: { level: number; fired_at: string; message: string }[];
  drivers: Driver[];
  historical_events: unknown[];
  flood_level?: number;
  isolation?: number;
  dc_directive?: DcDirective | null;
}

export interface TickerEvent {
  type: string;
  zone_code?: string;
  name?: string;
  level?: number;
  message?: string;
  ts?: string;
}

export interface PriorityRow {
  zone_id: string;
  zone_code: string | null;
  name: string | null;
  district: string | null;
  hazard_level: number;
  flood_level: number;
  susc_mean: number | null;
  population: number | null;
  road_km: number | null;
  isolation: number;
  score: number;
  reasons: string[];
  recommended_action: string;
}

export interface RegistryRow {
  id: number;
  name: string;
  version: string;
  git_sha: string | null;
  metrics: Record<string, unknown>;
  artifact_uri: string | null;
  notes: string | null;
  trained_at: string;
}

export interface AlertRow {
  id: string;
  zone_id: string;
  level: number;
  lang: string;
  channels: string[] | null;
  recipients: number;
  message_template: string | null;
  messages?: Record<string, string>;
  ack_at: string | null;
  fired_at: string;
}
