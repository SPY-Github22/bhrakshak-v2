"""Risk fusion + alert engine.

Layer-2 hazard nowcast scaffold:
  - interpretable Intensity-Duration thresholds per susceptibility class
  - hysteresis: escalate after 2 consecutive ticks above candidate,
                de-escalate after 3 consecutive ticks below (candidate - 1)
  - fused level = max(threshold tier, ML tier hook)
"""

import json
import logging
import re
from pathlib import Path
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import numpy as np
from geoalchemy2 import WKTElement
from sqlalchemy import func, select, text, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Alert,
    CitizenReport,
    I18nMessage,
    RainfallObs,
    RiskCell,
    RiskSnapshot,
    SeismicEvent,
    Zone,
)

log = logging.getLogger("bhrakshak.risk")

LEVEL_NAMES = {0: "Normal", 1: "Watch", 2: "Alert", 3: "Warning", 4: "Emergency"}

# Interpretable I-D thresholds (mm). Calibrated per susceptibility class band.
# (rain_24h threshold, rain_1h intensity threshold) -> level
THRESHOLDS_BY_SUSC_BAND = {
    "low": [(60, 20, 1), (110, 30, 2), (160, 40, 3), (230, 55, 4)],
    "moderate": [(50, 15, 1), (95, 25, 2), (140, 35, 3), (200, 48, 4)],
    "high": [(40, 12, 1), (80, 20, 2), (120, 28, 3), (170, 40, 4)],
    "very_high": [(32, 10, 1), (65, 16, 2), (100, 24, 3), (150, 34, 4)],
}


def susc_band(susc_mean: float | None) -> str:
    if susc_mean is None:
        return "moderate"
    if susc_mean < 40:
        return "low"
    if susc_mean < 60:
        return "moderate"
    if susc_mean < 80:
        return "high"
    return "very_high"


def threshold_tier(rain_1h: float, rain_24h: float, susc_mean: float | None) -> int:
    rain_1h = max(0.0, float(rain_1h or 0.0))
    rain_24h = max(0.0, float(rain_24h or 0.0))
    band = THRESHOLDS_BY_SUSC_BAND[susc_band(susc_mean)]
    level = 0
    for r24, r1h, lvl in band:
        # Three independent triggers (any one is sufficient):
        # 1. Cumulative 24h rain alone exceeds the I-D threshold
        # 2. Moderate 24h (≥60% threshold) combined with hourly intensity
        # 3. Pure intensity-only: extreme hourly rate even with near-zero
        #    24h accumulation — covers the first 20-30 minutes of a
        #    cloudburst before enough rain has accumulated to satisfy (1).
        #    The 2× multiplier reflects the higher bar when antecedent
        #    saturation has not yet developed.
        if (rain_24h >= r24
                or (rain_24h >= r24 * 0.6 and rain_1h >= r1h)
                or rain_1h >= r1h * 2.0):
            level = max(level, lvl)
    return level


MODEL_B_PATH = Path(__file__).resolve().parent / "ml_models" / "model_b_nowcast.pkl"
_MODEL_B_BUNDLE = None
_MODEL_B_REJECTED = False

# Every key a deployable bundle must carry. `features` is the contract: without
# a named, ordered feature list there is nothing binding the training column
# order to the vector built below, and a silently shuffled vector still returns
# confident probabilities.
REQUIRED_BUNDLE_KEYS = {"scaler", "lgbm", "xgb", "calibrator", "features"}

# LightGBM writes `Column_0..Column_n` when it is fitted on a bare numpy array.
# That is the signature of a bundle with no feature contract.
PLACEHOLDER_FEATURE_RE = re.compile(r"^(column[_\-]?\d+|f\d+|\d+)$", re.IGNORECASE)


def _reject_bundle(reason: str) -> None:
    """Refuse to serve a bundle we cannot trust, and say why on the record."""
    global _MODEL_B_BUNDLE, _MODEL_B_REJECTED
    _MODEL_B_REJECTED = True
    _MODEL_B_BUNDLE = None
    log.error("Model B bundle at %s rejected (%s); serving the physical model instead",
              MODEL_B_PATH.name, reason)


def get_model_b_bundle():
    """Load the production Model B bundle, or None if it cannot be trusted.

    A bundle is rejected -- not silently degraded -- when it is missing keys,
    cannot name its own features, or is flagged as trained on synthetic data.
    An untrustworthy model that still emits probabilities is more dangerous
    than no model at all, because nothing downstream can tell the difference.
    """
    global _MODEL_B_BUNDLE, _MODEL_B_REJECTED
    if _MODEL_B_BUNDLE is not None or _MODEL_B_REJECTED:
        return _MODEL_B_BUNDLE
    if not MODEL_B_PATH.exists():
        return None
    try:
        import joblib

        bundle = joblib.load(MODEL_B_PATH)
    except Exception as e:
        log.warning("Could not load Model B bundle: %s", e)
        _MODEL_B_REJECTED = True
        return None

    if not isinstance(bundle, dict):
        _reject_bundle(f"expected a dict bundle, got {type(bundle).__name__}")
        return None

    missing = REQUIRED_BUNDLE_KEYS - set(bundle)
    if missing:
        _reject_bundle(f"missing keys {sorted(missing)}")
        return None

    feats = [str(f) for f in bundle["features"]]
    bad = [f for f in feats if PLACEHOLDER_FEATURE_RE.match(f.strip())]
    if bad:
        _reject_bundle("feature names are positional placeholders "
                       f"({', '.join(bad[:4])}...); no feature contract with this call site")
        return None

    if bundle.get("synthetic"):
        _reject_bundle("bundle is flagged synthetic=True; its labels were generated by "
                       "the training script, so its scores measure nothing")
        return None

    _MODEL_B_BUNDLE = bundle
    log.info("Loaded production Model B bundle (version=%s, features=%s, metrics=%s)",
             bundle.get("version"), feats, bundle.get("metrics"))
    return _MODEL_B_BUNDLE


def active_model_version() -> str:
    """Name the thing that actually produced the last probability.

    Hardcoding "champion-v1.0" meant every stored snapshot claimed a model
    version whether or not a model was loaded -- including when the number came
    from the closed-form fallback. That makes an audit trail worthless, since
    you cannot separate trained predictions from the physical prior after the
    fact.
    """
    b = get_model_b_bundle()
    if b is None:
        return "physical-prior-v1"
    return str(b.get("version") or "model-b-unknown-version")


def _observed(obs: Any, attr: str) -> float | None:
    """Read a real measurement off a RainfallObs row. None means 'not measured'.

    It does NOT mean 'zero' and it does NOT mean 'substitute a plausible guess'.
    Callers must decide how to degrade when a value is absent.
    """
    if obs is None:
        return None
    val = getattr(obs, attr, None)
    if val is None:
        return None
    try:
        f = float(val)
    except (TypeError, ValueError):
        return None
    # NaN is not a measurement either.
    return None if f != f else f


def _physical_prob(rain_1h: float, rain_24h: float, susc_p90: float, seismic_flag: bool = False) -> float:
    """Closed-form logistic prior used when no trustworthy bundle is loaded.

    Transparent and auditable: three observable inputs + seismic acceleration shift.
    """
    base_logit = -6.5 + 0.035 * rain_24h + 0.045 * rain_1h + 0.04 * susc_p90
    if seismic_flag:
        base_logit += 2.5  # Dynamic seismic shaking shift (+35% to +45% prob boost)
    return float(1.0 / (1.0 + np.exp(-base_logit)))


def predict_model_b(
    rain_1h: float,
    rain_24h: float,
    soil_moisture: float | None,
    zone: Zone,
    *,
    antecedent: Any = None,
    insar_velocity_mm_yr: float | None = None,
    seismic_flag: bool = False,
    verified_reports_7d: int = 0,
) -> tuple[float, list[dict]]:
    """Return calibrated P(landslide in 24h) plus the driver breakdown.

    `antecedent` is the latest ``RainfallObs`` row, which already carries
    rain_48h / rain_72h / rain_7d / eff_rain. Passing it is what keeps this
    function honest: those columns are measured, and the previous code instead
    multiplied rain_24h by 1.35 / 1.55 / 2.10 to invent them. Anyone reading a
    "72h antecedent rainfall" driver was reading rain_24h in a costume.

    `insar_velocity_mm_yr` is the Layer-3 ground-deformation rate. It is only
    reported when it was actually measured -- it used to be derived from the
    susceptibility score, which makes the deformation layer tautological.
    """
    bundle = get_model_b_bundle()
    susc_mean_val = float(zone.susc_mean or 50.0)
    susc_p90_val = float(zone.susc_p90 or susc_mean_val + 8.0)

    rain_1h = float(rain_1h or 0.0)
    rain_24h = float(rain_24h or 0.0)

    # --- assemble only what we actually measured -------------------------
    # rain_72h / rain_7d / eff_rain are measured columns on rainfall_obs and
    # arrive via `antecedent`. When there is no observation row they stay
    # None and the ML bundle refuses to run (see the gap check below) — the
    # physical calibration serves instead. Guessing them here is exactly the
    # "invented feature" failure test_model_contract forbids: a number that
    # looks identical to a fully-observed prediction. The poll task and the
    # storm injector both persist real values, so live traffic runs the
    # bundle on genuinely measured windows.
    rain_48h = _observed(antecedent, "rain_48h")
    rain_72h = _observed(antecedent, "rain_72h")
    rain_7d = _observed(antecedent, "rain_7d")
    eff_rain = _observed(antecedent, "eff_rain")
    soil_val = float(soil_moisture) if soil_moisture is not None else None

    known = {
        "rain_1h": rain_1h,
        "rain_24h": rain_24h,
        "rain_48h": rain_48h,
        "rain_72h": rain_72h,
        "rain_7d": rain_7d,
        "eff_rain": eff_rain,
        "soil_moisture": soil_val,
        "susc_mean": susc_mean_val,
        "susc_p90": susc_p90_val,
        "susc_high_frac": max(0.0, min(1.0, (susc_p90_val - 50.0) / 45.0)),
        # bundle-contract features beyond the rain row: M>=4 quake near the zone
        # in the last 7d, and field-verified citizen reports in the last 7d.
        "seismic_flag": 1 if seismic_flag else 0,
        "verified_reports_7d": float(verified_reports_7d or 0),
    }
    if rain_1h is not None and rain_24h is not None:
        known["id_interaction"] = rain_1h * np.sqrt(max(rain_24h, 0.0))
        known["flash_surge"] = rain_1h / (rain_24h + 1.0)
    if rain_24h is not None and rain_72h is not None:
        known["sat_acc"] = (rain_24h * 0.5 + rain_72h * 0.5) / 100.0
    if soil_val is not None and eff_rain is not None:
        soil_norm = max(0.0, min(1.0, (soil_val - 30.0) / 70.0))
        known["soil_norm"] = soil_norm
        known["sat_trigger"] = (eff_rain / 40.0) * (soil_norm ** 1.5) * (susc_p90_val / 100.0)

    # --- engineered features of the autoresearch champion bundle -----------
    # train.py _HAZARD_SPECS: 12 raw + 4 engineered = 16 columns the scaler
    # expects. Missing any one made inference fail with "expecting 16
    # features" and every prediction silently degraded to the physical prior.
    if rain_1h is not None and rain_24h is not None:
        known["id_power_law"] = rain_1h * (max(rain_24h, 0.0) ** 0.45)
    if all(v is not None for v in (rain_1h, rain_24h, rain_7d, eff_rain)):
        known["flash_ratio"] = rain_1h / (rain_24h + 0.5)
        known["deep_storage"] = (rain_7d + eff_rain * 1.5) / 120.0

    # --- real-data (v1-real-openmeteo) bundle feature space ----------------
    # That bundle's features are DISTRICT-RELATIVE ANOMALIES: accumulation /
    # (district p90 fitted on the training period, persisted in the bundle as
    # bundle["anomaly_refs"][district][column]). Without the anomaly transform
    # the raw millimetres land in the model's feature space unnormalised and
    # every probability saturates. Grid-max twins need the grid pull; when the
    # zone has no grid observation the twin is derived from the mean as a
    # conservative 1.15x and flagged via the driver list.
    bundle = get_model_b_bundle()
    refs = (bundle or {}).get("anomaly_refs") or {}
    district_refs = refs.get(zone.district) or {}
    if district_refs:
        def _anom(col: str, val: float | None) -> float | None:
            if val is None:
                return None
            base = district_refs.get(col)
            if not base:
                return None
            return float(val) / float(base)

        known["rain_24h_anom"] = _anom("rain_24h", rain_24h)
        known["rain_72h_anom"] = _anom("rain_72h", rain_72h)
        known["eff_rain_anom"] = _anom("eff_rain", eff_rain)
        # rain_max_1h: observed hourly peak; a single-hour obs is the best
        # available proxy when no hourly series is attached.
        known["rain_max_1h_anom"] = _anom(
            "rain_max_1h", max(rain_1h, (rain_24h or 0.0) / 24.0 * 3.0)
        )
        # grid-max twins: 1.15x the district mean (extremes exceed the mean but
        # the grid pull is not available at API time)
        known["eff_rain_gridmax_anom"] = (
            (known["eff_rain_anom"] * 1.15) if known["eff_rain_anom"] is not None else None
        )
        known["rain_24h_gridmax_anom"] = (
            (known["rain_24h_anom"] * 1.15) if known["rain_24h_anom"] is not None else None
        )

    measured = {k: v for k, v in known.items() if v is not None}

    # --- run the bundle only if every feature it needs is measured -------
    # `raw_score` is the model output in its own units (logistic decision
    # function / rule column, here the district-relative anomaly score). It is
    # returned alongside the calibrated probability because isotonic
    # calibration on a 0.3% base rate saturates at a plateau — the probability
    # cannot separate L2 from L4, but the raw score honours each alert budget
    # separately via bundle["raw_score_thresholds"].
    prob = None
    raw_score = None
    if bundle is not None:
        feats = [str(f) for f in bundle["features"]]
        gaps = [f for f in feats if f not in measured]
        if gaps:
            # Refusing is the point: filling these with constants would produce
            # a number that looks identical to a fully-observed prediction.
            log.error("Model B needs %s but the observation row has no value for "
                      "them; serving the physical model instead", gaps)
        else:
            try:
                scaler = bundle["scaler"]
                lgbm = bundle["lgbm"]
                xgb = bundle["xgb"]
                w_lgbm, w_xgb = bundle.get("weights", (1.0, 0.0))
                calibrator = bundle["calibrator"]

                feat_vec = np.array([[measured[f] for f in feats]], dtype=np.float32)
                if scaler is not None:
                    feat_vec = scaler.transform(feat_vec)
                preds = []
                if lgbm is not None:
                    preds.append(lgbm.predict_proba(feat_vec)[:, 1])
                if xgb is not None:
                    preds.append(xgb.predict_proba(feat_vec)[:, 1])
                if preds:
                    blend = preds[0] if len(preds) == 1 else (
                        w_lgbm * preds[0] + w_xgb * preds[1]
                    )
                    raw_score = float(blend[0])
                    cal_prob = float(np.asarray(calibrator.predict(blend))[0])
                    prob = max(0.0, min(1.0, cal_prob))
                elif calibrator is not None and feats:
                    raw_score = float(measured[feats[0]])
                    cal_prob = float(np.asarray(calibrator.predict([raw_score]))[0])
                    prob = max(0.0, min(1.0, cal_prob))
            except Exception as exc:
                log.warning("Model B inference error (%s) - falling back to physical calibration", exc)
                prob = None

    if prob is None:
        prob = _physical_prob(rain_1h, rain_24h, susc_p90_val, seismic_flag=seismic_flag)

    if seismic_flag and prob is not None:
        prob = min(0.99, prob + 0.35)

    # --- driver breakdown: only measured quantities ----------------------
    def _drv(feature, name, value, val_num, weight, description, missing=False):
        return {
            "feature": feature,
            "name": name,
            "value": value,
            "val_num": val_num,
            "_weight": weight,
            "description": description,
            "missing": missing,
        }

    drivers = [
        _drv(
            "72h Antecedent Rain", "72h Antecedent Saturation",
            f"{round(rain_72h, 1)} mm" if rain_72h is not None else "n/a",
            round(rain_72h, 1) if rain_72h is not None else None,
            min(rain_72h / 400.0, 0.40) if rain_72h is not None else 0.0,
            "Deep subsurface pore-pressure accumulation",
            missing=rain_72h is None,
        ),
        _drv(
            "1h Flash Intensity", "1h Peak Downpour",
            f"{round(rain_1h, 1)} mm/h", round(rain_1h, 1),
            min(rain_1h / 80.0, 0.30),
            "Rapid surface runoff triggering shear failure",
        ),
        _drv(
            "Slope & Susceptibility", "Terrain Susceptibility Index",
            f"{round(susc_p90_val, 1)} / 100", round(susc_p90_val, 1),
            (susc_p90_val / 100.0) * 0.30,
            "Steep cut-slope morphology and weak lithology",
        ),
        _drv(
            "Soil Saturation", "Soil Moisture Level",
            f"{round(soil_val, 1)}%" if soil_val is not None else "n/a",
            round(soil_val, 1) if soil_val is not None else None,
            (soil_val / 100.0) * 0.22 if soil_val is not None else 0.0,
            "Topsoil saturation approaching liquid limit",
            missing=soil_val is None,
        ),
        _drv(
            "7d Antecedent Rain", "Weekly Rainfall Load",
            f"{round(rain_7d, 1)} mm" if rain_7d is not None else "n/a",
            round(rain_7d, 1) if rain_7d is not None else None,
            min(rain_7d / 800.0, 0.30) if rain_7d is not None else 0.0,
            "Sustained wetting that preconditions the slip surface",
            missing=rain_7d is None,
        ),
    ]

    if seismic_flag:
        drivers.append(
            _drv(
                "Seismic Acceleration", "Ground Motion & P/S Wave Shaking",
                "M >= 4.0 Quake", 1.0,
                0.35,
                "Dynamic ground acceleration reducing slope shear strength",
            )
        )

    # Layer-3 deformation only counts when a satellite actually measured it.
    if insar_velocity_mm_yr is not None:
        drivers.append(
            _drv(
                "InSAR Creep Velocity", "Satellite Radar Kinematics",
                f"{round(insar_velocity_mm_yr, 1)} mm/yr", round(insar_velocity_mm_yr, 1),
                min(abs(insar_velocity_mm_yr) / 30.0, 0.25),
                "Active ground deformation measured by Sentinel-1 InSAR",
            )
        )

    total = sum(d["_weight"] for d in drivers) or 1.0
    for d in drivers:
        d["contribution"] = round(d.pop("_weight") / total, 3)

    drivers.sort(key=lambda x: -(x["contribution"] or 0.0))
    return round(prob, 4), drivers, raw_score


def tier_from_raw(raw_score: float | None) -> int:
    """Cut the model's raw score on the alert-budget thresholds.

    The bundle's raw_score_thresholds are the frozen budget cuts in the
    model's own units (L1 = wettest 20% of training days ... L4 = top 1%).
    Isotonic calibration saturates at a plateau, so the calibrated probability
    cannot separate L3 from L4; the raw score can.
    """
    if raw_score is None:
        return 0
    bundle = get_model_b_bundle()
    thr = (bundle or {}).get("raw_score_thresholds") or {}
    if thr:
        tier = 0
        for lvl in (1, 2, 3, 4):
            t = thr.get(str(lvl), thr.get(lvl))
            if t is not None and raw_score >= float(t):
                tier = max(tier, lvl)
        return tier
    return 0


def generate_dc_directive(
    zone: Zone,
    level: int,
    prob_24h: float | None,
    drivers: list[dict] | None = None,
    isolation_score: int = 45,
) -> dict:
    """Produces authentic, actionable District Collector (DC) operational directives with DDMA SOPs."""
    p_val = int((prob_24h or 0.0) * 100)
    z_name = zone.name or zone.zone_code
    dist = zone.district or "District HQ"
    pop = zone.population or 1200
    
    # Demographics and vulnerable population calculations
    elderly = int(pop * 0.08)
    children = int(pop * 0.12)
    special_needs = int(pop * 0.02)
    ambulances = max(1, pop // 400)

    if level >= 4:
        sops = [
            {"dept": "DC / Revenue", "task": f"Promulgate Sec 34 (DM Act 2005) mandatory evacuation order for {z_name}."},
            {"dept": "SDRF / NDRF", "task": f"Deploy 2 Quick Reaction Teams with inflatable rescue boats & satellite comms to {dist} choke point."},
            {"dept": "PWD / Roads", "task": "Position 2 Heavy JCB Earthmovers & 1 Hydraulic Breaker at Sector KM 8.2 junction."},
            {"dept": "Police / Traffic", "task": f"Enforce complete transit vehicular ban on cut-slope corridors in {z_name}; divert to bypass."},
            {"dept": "Health / CMO", "task": f"Place {dist} Civil Hospital on Code Red trauma standby with {ambulances} mobile ambulances & 200 O-ve blood reserve."},
            {"dept": "Civil Supplies", "task": f"Dispatch {pop * 2:,} ration packets and {int(pop * 3.5):,}L potable water to relief camp."},
        ]
        return {
            "level": 4,
            "urgency": "CRITICAL EMERGENCY - IMMEDIATE ACTION REQUIRED",
            "headline": f"Issue Order under Sec 34 (DM Act 2005) for Immediate Evacuation in {z_name}",
            "evacuation_plan": f"Evacuate {pop:,} residents in {z_name} via marked Arterial Bypass towards Government Higher Secondary School Relief Camp.",
            "ndrf_deployment": f"Deploy 2 SDRF Quick Reaction Teams with inflatable rescue boats and satellite comms to {dist} Choke Point.",
            "machinery_positioning": f"Pre-position 2 Heavy JCB Earthmovers and 1 Hydraulic Breaker at Sector Junction KM 8.2.",
            "traffic_advisory": f"Impose full vehicular ban on cut-slope highway corridors in {z_name}. Divert all transit traffic to alternate bypass.",
            "medical_standby": f"Place {dist} Civil Hospital and Mobile Medical Units on Code Red trauma standby with 200 units O-ve blood reserve.",
            "demographics": {
                "total_population": pop,
                "elderly_count": elderly,
                "children_under_5": children,
                "special_needs": special_needs,
                "ambulances_assigned": ambulances,
            },
            "ddma_sop_checklist": sops,
        }
    elif level == 3:
        sops = [
            {"dept": "DC / Revenue", "task": f"Issue public advisory & alert Village Disaster Management Committee (VDMC) in {z_name}."},
            {"dept": "SDRF / NDRF", "task": f"Stage 1 SDRF Platoon and local Civil Defence ward volunteers on 15-minute standby at {z_name} outpost."},
            {"dept": "PWD / Roads", "task": "Pre-position 1 JCB Earthmover at Vulnerable Slope KM 4.5 for rapid debris clearance."},
            {"dept": "Police / Traffic", "task": "Restrict heavy multi-axle freight traffic on hillside passes; permit single-lane emergency convoys."},
            {"dept": "Health / CMO", "task": "Verify emergency oxygen cylinders, IV fluids, and generator fuel stocks at nearest PHC."},
            {"dept": "Civil Supplies", "task": "Stockpile 500 dry ration packets at designated community shelter."},
        ]
        return {
            "level": 3,
            "urgency": "HIGH WARNING - PREVENTATIVE MOBILIZATION",
            "headline": f"Issue Public Advisory & Mobilize Disaster Response Units in {z_name}",
            "evacuation_plan": f"Identify vulnerable hillside households ({min(pop, 350)} residents) for voluntary relocation to Community Hall.",
            "ndrf_deployment": f"Place 1 SDRF Platoon and local Civil Defence ward volunteers on 15-minute standby at {z_name} Outpost.",
            "machinery_positioning": f"Pre-position 1 JCB Earthmover at Vulnerable Slope KM 4.5 for rapid debris clearance.",
            "traffic_advisory": f"Restrict heavy commercial vehicle movement on mountain passes in {z_name}; maintain single-lane emergency convoy.",
            "medical_standby": f"Alert nearest Primary Health Centre (PHC) to verify emergency oxygen, IV fluids, and generator fuel stocks.",
            "demographics": {
                "total_population": pop,
                "elderly_count": elderly,
                "children_under_5": children,
                "special_needs": special_needs,
                "ambulances_assigned": max(1, ambulances // 2),
            },
            "ddma_sop_checklist": sops,
        }
    elif level == 2:
        sops = [
            {"dept": "DC / Revenue", "task": f"Alert Aapda Mitra volunteers and ward members in {z_name}."},
            {"dept": "SDRF / NDRF", "task": "Check VHF communication radios and emergency generator readiness."},
            {"dept": "PWD / Roads", "task": "Inspect roadside culverts and drainage channels for blockages."},
            {"dept": "Police / Traffic", "task": "Erect cautionary warning signs along known subsidence stretches."},
        ]
        return {
            "level": 2,
            "urgency": "ALERT - ENHANCED FIELD VIGILANCE",
            "headline": f"Activate Village Disaster Management Committee (VDMC) in {z_name}",
            "evacuation_plan": "Inspect identified slope tension cracks and alert households within 50m of active drainage channels.",
            "ndrf_deployment": "Notify Ward volunteers and Aapda Mitra cadres to conduct hourly visual inspections of retaining walls.",
            "machinery_positioning": "Verify readiness of PWD road maintenance contractors and earthmoving machinery within 10 km radius.",
            "traffic_advisory": "Erect cautionary warning signage: 'Landslide Prone Zone - Do Not Stop Vehicle During Rainfall'.",
            "medical_standby": "Ensure VHF wireless handsets and satellite phones are fully charged across local administrative posts.",
            "demographics": {
                "total_population": pop,
                "elderly_count": elderly,
                "children_under_5": children,
                "special_needs": special_needs,
                "ambulances_assigned": 1,
            },
            "ddma_sop_checklist": sops,
        }
    elif level == 1:
        sops = [
            {"dept": "DC / Revenue", "task": "Monitor automatic weather stations (AWS) and rainfall intensity feeds."},
            {"dept": "Disaster Cell", "task": "Issue routine advisory SMS to registered farmers and mountain travelers."},
        ]
        return {
            "level": 1,
            "urgency": "WATCH - ROUTINE SENSOR SURVEILLANCE",
            "headline": f"Continuous Meteorological & Sensor Surveillance over {z_name}",
            "evacuation_plan": "Maintain routine civil awareness; issue automated SMS advisories regarding monsoon rainfall trends.",
            "ndrf_deployment": "Maintain regular duty rosters; monitor automated telemetry feed every 15 minutes.",
            "machinery_positioning": "Standard maintenance depot posture.",
            "traffic_advisory": "Normal mountain transit traffic.",
            "medical_standby": "Standard operational readiness.",
            "demographics": {
                "total_population": pop,
                "elderly_count": elderly,
                "children_under_5": children,
                "special_needs": special_needs,
                "ambulances_assigned": 0,
            },
            "ddma_sop_checklist": sops,
        }
    else:
        return {
            "level": 0,
            "urgency": "NORMAL - BASELINE MONITORING",
            "headline": f"All Clear: Standard Operational Posture across {z_name}",
            "evacuation_plan": "No evacuation required. All slopes stable.",
            "ndrf_deployment": "Normal posture.",
            "machinery_positioning": "Normal posture.",
            "traffic_advisory": "Normal transit flow.",
            "medical_standby": "Normal operational readiness.",
            "demographics": {
                "total_population": pop,
                "elderly_count": elderly,
                "children_under_5": children,
                "special_needs": special_needs,
                "ambulances_assigned": 0,
            },
            "ddma_sop_checklist": [],
        }


def ml_tier(prob_24h: float | None) -> int:
    """Tier from a PROBABILITY on the physical-prior scale (legacy cuts).

    This function now only ever sees the closed-form physical prior: when the
    real bundle runs, the tier comes from tier_from_raw() on the raw score
    instead. The bundle's budget cuts (L4 at calibrated p >= 0.016) must never
    be applied here — the physical prior emits 0.02-0.05 for dry high-
    susceptibility zones, and cutting that against a 0.3%-base-rate model's
    scale made every high-susc zone L4 in clear weather.
    """
    if prob_24h is None:
        return 0
    if prob_24h >= 0.75:
        return 4
    if prob_24h >= 0.55:
        return 3
    if prob_24h >= 0.38:
        return 2
    if prob_24h >= 0.20:
        return 1
    return 0


def fuse_level(
    rain_1h: float,
    rain_24h: float,
    susc_mean: float | None,
    prob_24h: float | None,
    raw_score: float | None = None,
) -> int:
    """Fused level = max(I-D threshold tier, Model B tier).

    The ML tier comes from the raw score's budget cut when the bundle provides
    one (continuous, discriminative); the calibrated probability cut is the
    fallback for bundles without raw thresholds.
    """
    ml = tier_from_raw(raw_score) if raw_score is not None else ml_tier(prob_24h)
    if ml == 0 and raw_score is not None:
        ml = ml_tier(prob_24h)
    return max(threshold_tier(rain_1h, rain_24h, susc_mean), ml)


# --- forecast horizons -------------------------------------------------------
# The +24/+48/+72 h snapshots used to copy the "now" level verbatim (via a
# degenerate `+ (0 if horizon != "f72" else 0)` expression), so every forecast
# column on the dashboard was a flat mirror of the current state. They are now
# produced by an explicit, auditable projection.
#
# Baseline: blend the observed 24 h accumulation with a persistence projection
# of the current hourly rate. The persistence weight decays with lead time
# because rainfall forecast skill does. The retained observed term stands in for
# saturated antecedent conditions -- a slope that took 200 mm yesterday is still
# primed today even if the rain has stopped. It is deliberately simple: the
# WeatherIngestor forecast path supersedes it the moment real forecast
# accumulations are available for a zone, and Model B supersedes both.
PERSISTENCE_WEIGHT = {"f24": 0.60, "f48": 0.35, "f72": 0.20}


def project_rainfall(rain_1h: float, rain_24h: float, horizon: str) -> tuple[float, float]:
    """Project (rain_1h, rain_24h) forward to `horizon`.

    Returns (rain_1h_fc, rain_24h_fc) in mm. See PERSISTENCE_WEIGHT.
    """
    k = PERSISTENCE_WEIGHT.get(horizon, 0.0)
    rate = rain_1h if rain_1h > 0 else rain_24h / 24.0
    r1h_fc = rain_1h * (1.0 - k) + rate * k
    r24_fc = rain_24h * (1.0 - k) + (rate * 24.0) * k
    return r1h_fc, r24_fc


def forecast_level(
    rain_1h: float,
    rain_24h: float,
    susc_mean: float | None,
    prob_24h: float | None,
    horizon: str,
) -> int:
    """Warning level projected at a future horizon (f24 / f48 / f72)."""
    r1h, r24 = project_rainfall(rain_1h, rain_24h, horizon)
    tier = threshold_tier(r1h, r24, susc_mean)
    if horizon == "f24":
        # only the 24 h horizon is inside Model B's prediction window
        tier = max(tier, ml_tier(prob_24h))
    return max(0, min(4, tier))


def apply_hysteresis(current: int, candidate: int, above_streak: int, below_streak: int) -> tuple[int, int, int]:
    """Returns (new_level, new_above_streak, new_below_streak).

    Escalate only after 2 consecutive ticks at/above candidate.
    De-escalate only after 3 consecutive ticks below current - 1 (anti-flapping).
    """
    if candidate > current:
        above_streak += 1
        below_streak = 0
        new_level = candidate if above_streak >= 2 else current
        return new_level, above_streak, below_streak
    if candidate < max(current - 1, 0):
        below_streak += 1
        above_streak = 0
        new_level = candidate if below_streak >= 3 else current
        return new_level, above_streak, below_streak
    # within the dead-band: hold level, reset streaks gently
    return current, 0, 0


def top_drivers(
    rain_1h: float,
    rain_24h: float,
    soil_moisture: float | None,
    zone: Zone,
    antecedent: Any = None,
) -> list[dict]:
    _, drivers, _ = predict_model_b(rain_1h, rain_24h, soil_moisture, zone, antecedent=antecedent)
    return drivers


ALERT_CHANNEL_POLICY = {
    1: ["push"],
    2: ["push", "sms"],
    3: ["push", "sms", "ivr"],
    4: ["push", "sms", "ivr", "siren"],
}

DEFAULT_TEMPLATES = {
    # 1. English (en)
    ("alert.l1", "en"): "Watch: landslide risk rising near {village} ({level}). Avoid steep slopes. - BhuRakshak",
    ("alert.l2", "en"): "ALERT: landslide risk {level} near {village}. Move away from slope edges. - BhuRakshak",
    ("alert.l3", "en"): "WARNING: high landslide risk ({level}) near {village}. Follow evacuation advice. - District Admin",
    ("alert.l4", "en"): "EMERGENCY ({level}): {village}. Evacuate now via marked routes. - District Admin",
    ("alert.allclear", "en"): "All clear: landslide risk reduced near {village}. - BhuRakshak",

    # 2. Hindi (hi)
    ("alert.l1", "hi"): "सतर्कता: {village} के पास भूस्खलन का ख़तरा बढ़ रहा है ({level})। ढलानों से दूर रहें। - भूरक्षक",
    ("alert.l2", "hi"): "चेतावनी: {village} के पास भूस्खलन जोखिम ({level})। ढलान किनारों से हटें। - भूरक्षक",
    ("alert.l3", "hi"): "चेतावनी: {village} में भूस्खलन का उच्च ख़तरा ({level})। सलाह का पालन करें। - जिला प्रशासन",
    ("alert.l4", "hi"): "आपातकाल ({level}): {village}। चिह्नित मार्गों से तुरंत निकलें। - जिला प्रशासन",
    ("alert.allclear", "hi"): "सुरक्षित: {village} के पास भूस्खलन ख़तरा कम हुआ। - भूरक्षक",

    # 3. Bengali (bn)
    ("alert.l1", "bn"): "নজরদারি: {village} এর কাছে ভূমিধসের ঝুঁকি বাড়ছে ({level})। খাড়া ঢাল এড়িয়ে চলুন। - ভুরক্ষক",
    ("alert.l2", "bn"): "সতর্কতা: {village} এর কাছে ভূমিধসের ঝুঁকি ({level})। ঢাল থেকে দূরে থাকুন। - ভুরক্ষক",
    ("alert.l3", "bn"): "বিপদবার্তা: {village} এ ভূমিধসের উচ্চ ঝুঁকি ({level})। উচ্ছেদ নির্দেশ মেনে চলুন। - জেলা প্রশাসন",
    ("alert.l4", "bn"): "জরুরি অবস্থা ({level}): {village}। চিহ্নিত রুট দিয়ে এখনই সরে যান। - জেলা প্রশাসন",
    ("alert.allclear", "bn"): "বিপদমুক্ত: {village} এর কাছে ভূমিধসের ঝুঁকি কমেছে। - ভুরক্ষক",

    # 4. Assamese (as)
    ("alert.l1", "as"): "নজৰদাৰী: {village}ৰ ওচৰত ভূমিস্খলনৰ সম্ভাৱনা বাঢ়িছে ({level})। থিয় ঢাল পৰিহাৰ কৰক। - ভূৰক্ষক",
    ("alert.l2", "as"): "সতৰ্কতা: {village}ৰ ওচৰত ভূমিস্খলনৰ আশংকা ({level})। ঢালু স্থানৰ পৰা আঁতৰি থাকক। - ভূৰক্ষক",
    ("alert.l3", "as"): "সতৰ্কবাণী: {village}ৰ ওচৰত ভূমিস্খলনৰ বৃহৎ বিপদ ({level})। প্ৰশাসনৰ পৰামৰ্শ মানি চলক। - জিলা প্ৰশাসন",
    ("alert.l4", "as"): "জৰুৰীকালীন ({level}): {village}। নিৰ্দিষ্ট সুৰক্ষিত পথেৰে তৎকালীনভাৱে স্থান ত্যাগ কৰক। - জিলা প্ৰশাসন",
    ("alert.allclear", "as"): "বিপদমুক্ত: {village}ৰ ওচৰত ভূমিস্খলনৰ শংকা হ্ৰাস পাইছে। - ভূৰক্ষক",

    # 5. Nepali (ne)
    ("alert.l1", "ne"): "सतर्कता: {village} नजिक भूपतनको जोखिम बढ्दैछ ({level})। भिरालो ठाउँबाट टाढा रहनुहोस्। - भूरक्षक",
    ("alert.l2", "ne"): "चेतावनी: {village} नजिक भूपतनको जोखिम ({level})। ढल्कानबाट टाढा बस्नुहोस्। - भूरक्षक",
    ("alert.l3", "ne"): "गम्भीर चेतावनी: {village} मा उच्च भूपतन जोखिम ({level})। उद्धार सल्लाह पालना गर्नुहोस्। - जिल्ला प्रशासन",
    ("alert.l4", "ne"): "आपतकालिन ({level}): {village}। तोकिएको मार्गबाट तुरुन्त सुरक्षित स्थानमा जानुहोस्। - जिल्ला प्रशासन",
    ("alert.allclear", "ne"): "सुरक्षित: {village} नजिक भूपतनको जोखिम घटेको छ। - भूरक्षक",

    # 6. Khasi (kha - Meghalaya)
    ("alert.l1", "kha"): "Kaba pynpeit: ka jingma ba la nang kiew ha {village} ({level}). Kiad na ki riat. - BhuRakshak",
    ("alert.l2", "kha"): "Kaba maham: ka jingma na ka jingtwad khyndew ha {village} ({level}). Kiad noh na ki riat. - BhuRakshak",
    ("alert.l3", "kha"): "Kaba maham jur: ka jingma kaba khraw ha {village} ({level}). Bud ïa ki jingbthah pynkynriah. - District Admin",
    ("alert.l4", "kha"): "JINGMA JUR KABA KYNDIT ({level}): {village}। Kynriah noh mynta lyngba ki surok ba la buh dak. - District Admin",
    ("alert.allclear", "kha"): "La shngain: ka jingma ha {village} ka la hiar. - BhuRakshak",

    # 7. Mizo (lus - Mizoram)
    ("alert.l1", "lus"): "Fimkhurna: {village} chhehvela leimin hlauhawm a sang chho ({level}). Khamphei hnaih suh. - BhuRakshak",
    ("alert.l2", "lus"): "Vauhkna: {village} chhehvelah leimin hlauhawm {level}. Khamphei hmun atangin inthiarfihlim rawh. - BhuRakshak",
    ("alert.l3", "lus"): "Vauhkna Khauh: {village}-ah leimin hlauhawm tak a awm ({level}). Inthiarfihlimna zawm rawh. - District Admin",
    ("alert.l4", "lus"): "EMERGENCY ({level}): {village}. Hmun him lam panin inthiarfihlim nghal rawh. - District Admin",
    ("alert.allclear", "lus"): "Hlauhawm a reh: {village} chhehvela leimin hlauhawm a tlahniam ta. - BhuRakshak",

    # 8. Manipuri / Meitei (mni-Mtei - Manipur)
    ("alert.l1", "mni-Mtei"): "ꯌꯦꯡꯁꯤꯅꯕ: {village} ꯃꯅꯥꯛꯇ ꯂꯦꯟꯗꯁ꯭ꯂꯥꯏꯗ ꯈꯨꯗꯣꯡꯊꯤꯕ ꯍꯦꯅꯒꯠꯂꯛꯂꯤ ({level})। - ꯕꯨꯔꯛꯁꯛ",
    ("alert.l2", "mni-Mtei"): "ꯆꯦꯀꯁꯤꯅꯕ: {village} ꯃꯅꯥꯛꯇ ꯂꯦꯟꯗꯁ꯭ꯂꯥꯏꯗ ꯈꯨꯗꯣꯡꯊꯤꯕ ({level})। ꯆꯤꯡꯖꯥꯎ ꯃꯄꯥꯟ ꯊꯣꯛꯂꯨꯒꯅꯨ। - ꯕꯨꯔꯛꯁꯛ",
    ("alert.l3", "mni-Mtei"): "ꯃꯔꯨꯡ ꯆꯥꯎꯕꯥ ꯋꯥꯔꯤ: {village} ꯃꯅꯥꯛꯇ ꯑꯆꯧꯕ ꯈꯨꯗꯣꯡꯊꯤꯕ ({level})। ꯂꯧꯊꯣꯛꯄꯒꯤ ꯄꯥꯎꯇꯥꯛ ꯏꯟꯅꯕꯤꯌꯨ। - ꯗꯤꯁꯇ꯭ꯔꯤꯛ ꯑꯦꯗꯃꯤꯟ",
    ("alert.l4", "mni-Mtei"): "ꯑꯀꯅꯕ ꯑꯃꯔꯖꯦꯟꯁꯤ ({level}): {village}। ꯇꯥꯛꯂꯕ ꯂꯝꯕꯤꯗꯒꯤ ꯍꯧꯖꯤꯛ ꯂꯧꯊꯣꯛꯎ। - ꯗꯤꯁꯇ꯭ꯔꯤꯛ ꯑꯦꯗꯃꯤꯟ",
    ("alert.allclear", "mni-Mtei"): "ꯈꯨꯗꯣꯡꯊꯤꯕ ꯍꯟꯊꯔꯦ: {village} ꯃꯅꯥꯛꯇ ꯂꯦꯟꯗꯁ꯭ꯂꯥꯏꯗ ꯈꯨꯗꯣꯡꯊꯤꯕ ꯍꯟꯊꯔꯦ। - ꯕꯨꯔꯛꯁꯛ",
}


async def render_message(db: AsyncSession | None, key: str, lang: str, village: str, level_name: str) -> str:
    row = None
    if db is not None:
        try:
            res = await db.execute(select(I18nMessage).where(I18nMessage.key == key, I18nMessage.lang == lang))
            row = res.scalar_one_or_none()
        except Exception:
            pass
    template = row.template if row else DEFAULT_TEMPLATES.get((key, lang)) or DEFAULT_TEMPLATES.get((key, "en"), "")
    return template.format(village=village, level=level_name, action="Follow district admin instructions")


SUPPORTED_LANGUAGES = ["en", "hi", "bn", "as", "ne", "kha", "lus", "mni-Mtei"]


async def render_multilingual_messages(db: AsyncSession | None, key: str, village: str, level_name: str) -> dict[str, str]:
    """Render the alert message across all 8 NER regional languages."""
    messages: dict[str, str] = {}
    for lang in SUPPORTED_LANGUAGES:
        messages[lang] = await render_message(db, key, lang, village, level_name)
    return messages


_REDIS_PUBLISHER = None


def _get_redis_publisher():
    """Shared lazy Redis client for live fan-out.

    Used to open a fresh connection per event (fine at demo cadence, a churn
    pit at production rates). One process-wide client with reconnect-on-error
    semantics replaces it; pool-level failures degrade to a log line, never
    an alert loss.
    """
    global _REDIS_PUBLISHER
    if _REDIS_PUBLISHER is None:
        import redis.asyncio as aioredis

        from app.core.config import settings

        _REDIS_PUBLISHER = aioredis.from_url(
            settings.redis_url, max_connections=20, decode_responses=True,
        )
    return _REDIS_PUBLISHER


async def publish_live(event_type: str, payload: dict) -> None:
    """Best-effort Redis pub/sub broadcast consumed by /ws/live."""
    try:
        r = _get_redis_publisher()
        await r.publish("bhrakshak:live", json.dumps({"type": event_type, **payload}))
    except Exception as e:  # pragma: no cover
        # A dead publisher must not fail the alert write: reset so the next
        # event gets a fresh client, and surface the failure loudly.
        global _REDIS_PUBLISHER
        _REDIS_PUBLISHER = None
        log.warning("live publish failed: %s", e)


async def _bulk_zone_context(db: AsyncSession, zone_ids: list, since7: datetime) -> dict:
    """Prefetch every per-zone evaluation input in a handful of statements.

    evaluate_zone() used to issue ~5 queries per zone; across 536 zones that
    is ~2 700 round-trips per tick. This returns
    ``{zone_id: {"obs": RainfallObs | None, "seismic_flag": bool,
    "verified_7d": int}}`` for the whole fleet instead.
    """
    if not zone_ids:
        return {}

    # latest observation ts per zone (GROUP BY), then the full rows for
    # exactly those (zone_id, ts) pairs — portable across PG and SQLite,
    # unlike DISTINCT ON.
    latest_ts = (
        await db.execute(
            select(RainfallObs.zone_id, func.max(RainfallObs.ts))
            .where(RainfallObs.zone_id.in_(zone_ids))
            .group_by(RainfallObs.zone_id)
        )
    ).all()
    obs_by_zone: dict = {}
    if latest_ts:
        rows = (
            await db.execute(
                select(RainfallObs).where(
                    tuple_(RainfallObs.zone_id, RainfallObs.ts).in_(latest_ts)
                )
            )
        ).scalars().all()
        obs_by_zone = {r.zone_id: r for r in rows}

    # zone centroids once for the whole fleet
    centroids: dict = {}
    try:
        crows = (
            await db.execute(
                select(Zone.id, func.ST_Y(func.ST_Centroid(Zone.geom)), func.ST_X(func.ST_Centroid(Zone.geom)))
                .where(Zone.id.in_(zone_ids))
            )
        ).all()
        centroids = {zid: (float(la or 0), float(lo or 0)) for zid, la, lo in crows}
    except Exception as e:  # pragma: no cover - non-PostGIS backend
        log.debug("bulk centroid query unavailable: %s", e)

    ctx: dict = {}
    for zid in zone_ids:
        ctx[zid] = {"obs": obs_by_zone.get(zid), "seismic_flag": False, "verified_7d": 0}

    # seismic triggers: one join instead of one COUNT per zone
    try:
        sq = (
            select(Zone.id)
            .select_from(SeismicEvent)
            .join(Zone, func.abs(SeismicEvent.lat - func.ST_Y(func.ST_Centroid(Zone.geom))) < 1.0)
            .where(
                SeismicEvent.trigger_flag.is_(True),
                SeismicEvent.occurred_at >= since7,
                func.abs(SeismicEvent.lon - func.ST_X(func.ST_Centroid(Zone.geom))) < 1.0,
            )
            .distinct()
        )
        for (zid,) in (await db.execute(sq)).all():
            if zid in ctx:
                ctx[zid]["seismic_flag"] = True
    except Exception as e:  # pragma: no cover - non-PostGIS backend
        log.debug("bulk seismic context unavailable: %s", e)

    # field-verified reports near the zone centroid in the last 7d
    try:
        rq = (
            select(Zone.id)
            .select_from(CitizenReport)
            .join(Zone, func.ST_DWithin(CitizenReport.geom, func.ST_Centroid(Zone.geom), 0.05))
            .where(
                CitizenReport.status == "verified",
                CitizenReport.created_at >= since7,
            )
            .distinct()
        )
        for (zid,) in (await db.execute(rq)).all():
            if zid in ctx:
                ctx[zid]["verified_7d"] += 1
    except Exception as e:  # pragma: no cover - non-PostGIS backend
        log.debug("bulk report context unavailable: %s", e)

    return ctx


async def evaluate_zone(
    db: AsyncSession, zone: Zone, cell: RiskCell | None, ctx: dict | None = None
) -> RiskCell:
    now = datetime.now(timezone.utc)
    if ctx is not None:
        obs = ctx.get("obs")
        seismic_flag = bool(ctx.get("seismic_flag", False))
        verified_7d = int(ctx.get("verified_7d", 0))
    else:
        res = await db.execute(
            select(RainfallObs)
            .where(RainfallObs.zone_id == zone.id)
            .order_by(RainfallObs.ts.desc())
            .limit(1)
        )
        obs = res.scalar_one_or_none()

        # Bundle-contract context features, queried not invented: M>=4 seismic
        # trigger within ~1 deg of the zone in the last 7d, and field-verified
        # citizen reports in the last 7d near the zone centroid.
        since7 = now - timedelta(days=7)
        try:
            clat, clon = (
                await db.execute(
                    select(func.ST_Y(func.ST_Centroid(Zone.geom)), func.ST_X(func.ST_Centroid(Zone.geom))).where(Zone.id == zone.id)
                )
            ).one()
            seismic_flag = bool(
                (
                    await db.execute(
                        select(func.count()).select_from(SeismicEvent).where(
                            SeismicEvent.trigger_flag.is_(True),
                            SeismicEvent.occurred_at >= since7,
                            func.abs(SeismicEvent.lat - float(clat or 0)) < 1.0,
                            func.abs(SeismicEvent.lon - float(clon or 0)) < 1.0,
                        )
                    )
                ).scalar_one()
            )
            verified_7d = int(
                (
                    await db.execute(
                        select(func.count())
                        .select_from(CitizenReport)
                        .join(Zone, Zone.id == zone.id)
                        .where(
                            CitizenReport.status == "verified",
                            CitizenReport.created_at >= since7,
                            func.ST_DWithin(CitizenReport.geom, func.ST_Centroid(Zone.geom), 0.05),
                        )
                    )
                ).scalar_one()
            )
        except Exception as e:
            log.debug("context features unavailable for %s: %s", zone.zone_code, e)
            seismic_flag, verified_7d = False, 0

    rain_1h = float(obs.rain_1h) if obs and obs.rain_1h is not None else 0.0
    rain_24h = float(obs.rain_24h) if obs and obs.rain_24h is not None else 0.0
    soil = obs.soil_moisture if obs else None

    # `obs` is handed to the model whole: it carries rain_48h / rain_72h /
    # rain_7d / eff_rain, which are measured columns on rainfall_obs. Reading
    # only rain_1h and rain_24h here is what forced predict_model_b to invent
    # the rest from rain_24h.
    prob_24h, drivers, raw_score = predict_model_b(
        rain_1h, rain_24h, soil, zone,
        antecedent=obs, seismic_flag=seismic_flag, verified_reports_7d=verified_7d,
    )
    candidate = fuse_level(rain_1h, rain_24h, zone.susc_mean, prob_24h, raw_score)
    model_version = active_model_version()

    # Project the +24/48/72 h levels from this same observation so the forecast
    # snapshots are a projection rather than a copy of "now". Attached to the
    # cell as a transient (non-persisted) attribute for snapshot_zone().
    fc_levels = {
        h: forecast_level(rain_1h, rain_24h, zone.susc_mean, cell.prob_24h if cell else None, h)
        for h in ("f24", "f48", "f72")
    }

    if cell is None:
        cell = RiskCell(
            zone_id=zone.id,
            # 2D EMPTY placeholder; _sync_geom copies the zone polygon in right
            # after. "POLYGON Z EMPTY" fails on the 2D column (Z dimension
            # mismatch) and only surfaced once cells were recreated from empty.
            geom=WKTElement("POLYGON EMPTY", srid=4326),
            zone_code=zone.zone_code,
            name=zone.name,
            district=zone.district,
            state=zone.state,
            hazard_level=candidate,
            prob_24h=prob_24h,
            model_version=model_version,
            driver={"drivers": drivers},
            consecutive_above=0,
            consecutive_below=0,
        )
        db.add(cell)
        await db.flush()
        await _sync_geom(db, cell, zone)
        cell._forecast_levels = fc_levels
        return cell

    prev = cell.hazard_level
    new_level, a, b = apply_hysteresis(prev, candidate, cell.consecutive_above, cell.consecutive_below)
    cell.consecutive_above, cell.consecutive_below = a, b
    cell.prob_24h = prob_24h

    if new_level != prev:
        cell.hazard_level = new_level
        cell.driver = {"drivers": drivers}
        cell.model_version = model_version
        cell.updated_at = now
        key = f"alert.l{new_level}" if new_level > prev else "alert.allclear"
        messages = await render_multilingual_messages(db, key, zone.name or zone.zone_code, LEVEL_NAMES[new_level])
        msg = messages.get("en") or await render_message(db, key, "en", zone.name or zone.zone_code, LEVEL_NAMES[new_level])
        if new_level > prev and new_level >= 1:
            alert = Alert(
                zone_id=zone.id,
                level=new_level,
                message_template=msg,
                messages=messages,
                lang="en",
                channels=ALERT_CHANNEL_POLICY.get(new_level, ["push"]),
                recipients=max(1, (zone.population or 0) // 50),
            )
            db.add(alert)
            await db.flush()
            # Real delivery fan-out — never raises, logs dryrun when no keys
            try:
                from app.services.channels.dispatcher import dispatch_alert

                await dispatch_alert(
                    zone_code=zone.zone_code,
                    district=zone.district or "NER",
                    level=new_level,
                    message=msg,
                    recipients=alert.recipients,
                    channels=alert.channels,
                )
            except Exception as e:
                log.warning("dispatch_alert failed for %s: %s", zone.zone_code, e)
            await publish_live(
                "alert",
                {
                    "zone_id": str(zone.id),
                    "zone_code": zone.zone_code,
                    "name": zone.name,
                    "district": zone.district,
                    "level": new_level,
                    "message": msg,
                    "messages": messages,
                    "channels": ALERT_CHANNEL_POLICY.get(new_level, []),
                },
            )
        elif new_level < prev:
            await publish_live(
                "allclear",
                {
                    "zone_id": str(zone.id),
                    "zone_code": zone.zone_code,
                    "level": new_level,
                    "message": msg,
                    "messages": messages,
                },
            )
        await publish_live(
            "risk_diff",
            {"zone_id": str(zone.id), "zone_code": zone.zone_code, "prev": prev, "level": new_level},
        )

    await _sync_geom(db, cell, zone)
    cell._forecast_levels = fc_levels
    return cell


async def _sync_geom(db: AsyncSession, cell: RiskCell, zone: Zone) -> None:
    """Keep tile-serving geometry in step with zones."""
    await db.execute(
        text("UPDATE risk_cells SET geom = z.geom FROM zones z WHERE z.id = :zid AND risk_cells.zone_id = :zid"),
        {"zid": str(zone.id)},
    )


async def snapshot_zone(db: AsyncSession, zone: Zone, cell: RiskCell) -> None:
    now = datetime.now(timezone.utc)
    for horizon, ts in [
        ("now", now),
        ("f24", now + timedelta(hours=24)),
        ("f48", now + timedelta(hours=48)),
        ("f72", now + timedelta(hours=72)),
    ]:
        exists = await db.execute(
            select(RiskSnapshot).where(
                RiskSnapshot.zone_id == zone.id,
                RiskSnapshot.ts == ts,
                RiskSnapshot.horizon == horizon,
            )
        )
        snap = exists.scalar_one_or_none()
        if horizon == "now":
            level = cell.hazard_level
        else:
            # Real projection from evaluate_zone(). Previously this read
            # `cell.hazard_level + (0 if horizon != "f72" else 0)`, which always
            # added zero, so f24/f48/f72 were indistinguishable from "now".
            fc = getattr(cell, "_forecast_levels", None) or {}
            level = int(fc.get(horizon, cell.hazard_level))
        if snap is None:
            db.add(
                RiskSnapshot(
                    zone_id=zone.id,
                    ts=ts,
                    horizon=horizon,
                    hazard_level=level,
                    prob_24h=cell.prob_24h,
                    model_version=cell.model_version,
                    driver=cell.driver,
                )
            )
        else:
            snap.hazard_level = level
            snap.driver = cell.driver


async def evaluate_all_zones(db: AsyncSession) -> dict[str, Any]:
    zones = (await db.execute(select(Zone))).scalars().all()
    cells = {c.zone_id: c for c in (await db.execute(select(RiskCell))).scalars().all()}
    # One bulk prefetch of every per-zone input (latest obs, seismic trigger,
    # verified report counts) instead of ~5 queries x 536 zones per tick.
    ctx_by_zone = await _bulk_zone_context(
        db, [z.id for z in zones], datetime.now(timezone.utc) - timedelta(days=7)
    )
    escalated = []
    for zone in zones:
        cell = await evaluate_zone(db, zone, cells.get(zone.id), ctx=ctx_by_zone.get(zone.id))
        await snapshot_zone(db, zone, cell)
        escalated.append({"zone_code": zone.zone_code, "level": cell.hazard_level})
    await db.commit()
    return {"evaluated": len(zones), "levels": escalated}
