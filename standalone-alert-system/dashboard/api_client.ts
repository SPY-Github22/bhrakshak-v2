const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export interface InjectPayload {
  district: string;
  location_name: string;
  peak_mm_h: number;
  hours: number;
}

export async function injectStorm(payload: InjectPayload) {
  const res = await fetch(`${API_BASE_URL}/api/v1/demo/inject-rainfall-storm`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`API Error ${res.status}`);
  }
  return res.json();
}

export async function resetStorm() {
  const res = await fetch(`${API_BASE_URL}/api/v1/demo/reset-storm`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`API Error ${res.status}`);
  }
  return res.json();
}

export async function fetchActiveAlerts() {
  const res = await fetch(`${API_BASE_URL}/api/v1/alerts/active`, {
    headers: {
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`API Error ${res.status}`);
  }
  return res.json();
}
