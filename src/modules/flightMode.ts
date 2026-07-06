// Global flight-mode flag, set by the falcon controller (assets/scripts/FalconController.ts)
// while the player is riding the falcon. Heavy per-frame systems check this flag and
// early-return so the scene spends its frame budget on flying.

import { Entity } from '@dcl/sdk/ecs'

let _flightModeActive = false
let _falconEntity: Entity | null = null

export function setFlightMode(active: boolean) {
  _flightModeActive = active
}

export function isFlightModeActive(): boolean {
  return _flightModeActive
}

// The falcon registers itself here so other creatures (pigeons) can locate it
// without depending on entity names or composite ids.
export function setFalconEntity(entity: Entity) {
  _falconEntity = entity
}

export function getFalconEntity(): Entity | null {
  return _falconEntity
}

// distinct from flight mode: true only between take-off and perch/dismount,
// so E can mean "catch pigeon" in the air but still mean "dismount" on a perch
let _falconAirborne = false

export function setFalconAirborne(airborne: boolean) {
  _falconAirborne = airborne
}

export function isFalconAirborne(): boolean {
  return _falconAirborne
}

// falcon controls panel: shown from the moment the falcon is activated until
// 10 seconds into the first flight (timer runs in FalconController)
let _controlsHintVisible = false

export function setControlsHintVisible(visible: boolean) {
  _controlsHintVisible = visible
}

export function isControlsHintVisible(): boolean {
  return _controlsHintVisible
}

// "Press E to Catch" prompt: written by the pigeon catch system
// (assets/scripts/pigeonBird.ts), read by the UI renderer (src/ui.tsx)
let _catchHintVisible = false

export function setCatchHintVisible(visible: boolean) {
  _catchHintVisible = visible
}

export function isCatchHintVisible(): boolean {
  return _catchHintVisible
}
