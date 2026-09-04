"""Demo storm injector: logs in as admin and fires the rainfall-storm endpoint.

Usage:
  python storm_injector.py --district "East Khasi Hills" --peak 55 --hours 3
"""

import argparse
import json
import sys
import urllib.request

API = "http://localhost:8000/api/v1"


def call(path: str, body: dict | None = None, token: str | None = None) -> dict:
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode() if body else None,
        headers={"Content-Type": "application/json",
                 **({"Authorization": f"Bearer {token}"} if token else {})},
        method="POST" if body is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--district", default="East Khasi Hills")
    ap.add_argument("--location", help="Target location e.g. 'Gangtok highway sector', 'Aizawl north slope', 'Cherrapunji cut-slope area'")
    ap.add_argument("--peak", type=float, default=50.0)
    ap.add_argument("--hours", type=int, default=3)
    args = ap.parse_args()

    loc = args.location or args.district
    tok = call("/auth/login", {"email": "admin@bhrakshak.in", "password": "Admin@123"})["access_token"]
    result = call("/demo/inject-rainfall-storm",
                  {"district": args.district, "location_name": loc, "peak_mm_h": args.peak, "hours": args.hours}, token=tok)
    escalated = [l for l in result.get("levels", []) if l["level"] >= 2]
    print(f"storm injected over {loc}: {result.get('zones_injected')} zones, "
          f"{len(escalated)} at L2+")
    for l in result.get("levels", []):
        bar = "#" * l["level"]
        print(f"  {l['zone_code']:<14} L{l['level']} {bar}")
    if not escalated:
        print("(no escalation - raise --peak)")
        sys.exit(2)


if __name__ == "__main__":
    main()
