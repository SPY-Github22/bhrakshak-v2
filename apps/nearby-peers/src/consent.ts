/* Consent is the kill-switch for the whole feature: when it is off the device
   neither announces over Wi-Fi nor advertises over BLE, and the app calls the
   server's DELETE endpoint so any stored sighting is dropped immediately. */

import { CONSENT_KEY, NEEDS_HELP_KEY } from "./config.ts";

export function getConsent(): boolean {
  return localStorage.getItem(CONSENT_KEY) === "1";
}

export function setConsent(on: boolean): boolean {
  localStorage.setItem(CONSENT_KEY, on ? "1" : "0");
  return on;
}

export function getNeedsHelp(): boolean {
  return localStorage.getItem(NEEDS_HELP_KEY) === "1";
}

export function setNeedsHelp(v: boolean): boolean {
  localStorage.setItem(NEEDS_HELP_KEY, v ? "1" : "0");
  return v;
}
