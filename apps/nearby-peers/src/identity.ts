/* Ephemeral peer identity. Deliberately NOT an account: a random 4-byte id,
   rotated every day, so a rescuer cannot build a movement history of a
   citizen and a lost phone reveals nothing about its owner. */

import { ALIAS_KEY, PEER_ID_DAY_KEY, PEER_ID_KEY } from "./config.ts";

function todayKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function randomId(): string {
  const b = new Uint8Array(4);
  (globalThis.crypto ?? { getRandomValues: (a: Uint8Array) => a } as any).getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Get (or create) this device's peer id. Rotates at local midnight. */
export function getOrCreatePeerId(now: Date = new Date()): string {
  const day = todayKey(now);
  const current = localStorage.getItem(PEER_ID_KEY);
  const storedDay = localStorage.getItem(PEER_ID_DAY_KEY);
  if (current && storedDay === day) return current;
  const fresh = randomId();
  localStorage.setItem(PEER_ID_KEY, fresh);
  localStorage.setItem(PEER_ID_DAY_KEY, day);
  return fresh;
}

/** Force a new id (used by the "forget me" action). */
export function rotatePeerId(): string {
  const fresh = randomId();
  localStorage.setItem(PEER_ID_KEY, fresh);
  localStorage.setItem(PEER_ID_DAY_KEY, todayKey());
  return fresh;
}

/** Default alias "C-xxxx" derived from the id — human-friendly, not identifying. */
export function defaultAlias(peerId: string): string {
  return `C-${peerId.slice(0, 4).toUpperCase()}`;
}

export function getAlias(): string {
  const stored = localStorage.getItem(ALIAS_KEY);
  if (stored && stored.trim()) return stored.trim().slice(0, 24);
  return defaultAlias(getOrCreatePeerId());
}

export function setAlias(alias: string): string {
  const clean = alias.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 24);
  localStorage.setItem(ALIAS_KEY, clean || defaultAlias(getOrCreatePeerId()));
  return getAlias();
}
