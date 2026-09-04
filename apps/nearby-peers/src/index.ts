/* bhrakshak-nearby-peers — public surface.
   Everything an integrating app needs; nothing else escapes the folder. */

export * from "./types.ts";
export * from "./config.ts";
export { haversineMeters, bearingDeg, compassArrow, cardinal, rssiToMeters, formatDistance, formatAge, clamp } from "./geo.ts";
export { crc8, encodeBeaconFrame, tryDecodeBeaconFrame, type BeaconPayload } from "./frame.ts";
export { getOrCreatePeerId, rotatePeerId, getAlias, setAlias, defaultAlias } from "./identity.ts";
export { getConsent, setConsent, getNeedsHelp, setNeedsHelp } from "./consent.ts";
export { PeerStore, roleLabel } from "./peerStore.ts";
export { RendezvousTransport, type RendezvousOptions } from "./transports/rendezvousTransport.ts";
export { BleTransport, bleScanSupported, type BleTransportOptions } from "./transports/bleTransport.ts";
export { NearbyService, type NearbyServiceOptions, type NearbyStatus } from "./nearbyService.ts";
export { PeerNavigator, requestCompassPermission } from "./components/PeerNavigator.tsx";
export { PeopleNearbyPanel } from "./components/PeopleNearbyPanel.tsx";
export { CitizenBeaconPanel } from "./components/CitizenBeaconPanel.tsx";
export { NearbyTacticalMap, type TacticalMapProps } from "./components/NearbyTacticalMap.tsx";
