import CANNON from 'cannon'
import { Entity, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import {
  createBirdWorld,
  getThreatPosition,
  moveToward,
  PigeonBird,
  WanderProbe
} from './pigeonBird'

/**
 * Boid pigeon flock migrated from the Godot City-test prototype
 * (flock_manager.gd + boid_pigeon.gd). Spawns a flock that flies in loose
 * formation around a wander anchor near this entity, and panics — bird by
 * bird, depending on each one's bravery — when the falcon (or the walking
 * player) gets close, so the formation only partially breaks.
 *
 * Physics run on a cannon.js world; buildings are sensed with renderer
 * raycasts against the real scene colliders (forward avoidance rays per bird,
 * downward probes to pick anchors near rooftops).
 *
 * @param flockSize - how many pigeons to spawn
 * @param cruiseSpeed - formation flying speed (m/s)
 * @param maxSpeed - top speed while panicking (m/s)
 * @param reactionDistance - falcon distance that panics a bird (m)
 * @param braverySpread - 0-1: how unevenly birds panic (formation breaking)
 * @param wanderRadius - how far from this entity anchors are picked (m)
 * @param retargetTime - seconds before the flock picks a new wander anchor
 * @param wanderRandomness - 0-1: how erratic each bird's path is
 * @param minAltitude - birds steer up below this height (m)
 * @param maxAltitude - birds steer down above this height (m)
 * @param birdScale - model scale per pigeon
 */
export class PigeonFlock {
  // --- per-bird physics, same values as boid_pigeon.gd ---
  private static readonly TURN_SPEED = 1.4 // rad/s (falcon turns faster)
  private static readonly ACCEL = 5
  private static readonly FLEE_ACCEL = 10
  private static readonly AIR_INERTIA = 1.8
  private static readonly GRAVITY = 14
  private static readonly LIFT = 0.95
  // --- boid weights, same values as flock_manager.gd ---
  private static readonly SEPARATION_WEIGHT = 1.4
  private static readonly ALIGNMENT_WEIGHT = 0.9
  private static readonly COHESION_WEIGHT = 0.9
  private static readonly TARGET_WEIGHT = 0.7
  private static readonly SEPARATION_RADIUS = 2

  private world!: CANNON.World
  private probe!: WanderProbe
  private birds: PigeonBird[] = []
  private bravery: number[] = []
  private panic: number[] = []
  private jitter: Vector3.MutableVector3[] = []

  private home: Vector3 = Vector3.Zero()
  private anchor: Vector3 = Vector3.Zero()
  private center: Vector3 = Vector3.Zero()
  private avgVelocity: Vector3 = Vector3.Zero()
  private retargetTimer = 0

  constructor(
    public src: string,
    public entity: Entity,
    public flockSize: number = 14,
    public cruiseSpeed: number = 6,
    public maxSpeed: number = 15,
    public reactionDistance: number = 6,
    public braverySpread: number = 0.5,
    public wanderRadius: number = 40,
    public retargetTime: number = 6,
    public wanderRandomness: number = 0.1,
    public minAltitude: number = 3,
    public maxAltitude: number = 65,
    public birdScale: number = 0.3
  ) {}

  start() {
    this.world = createBirdWorld()
    this.probe = new WanderProbe()
    this.home = Vector3.clone(Transform.get(this.entity).position)
    this.anchor = Vector3.create(this.home.x, Math.max(this.home.y, 20), this.home.z)
    this.pickAnchor()

    // spawn the flock in a loose cluster near the anchor
    const spawnCenter = Vector3.create(
      this.anchor.x + (Math.random() * 8 - 4),
      Math.max(this.anchor.y, 12),
      this.anchor.z + (Math.random() * 8 - 4)
    )
    const config = {
      turnSpeed: PigeonFlock.TURN_SPEED,
      airInertia: PigeonFlock.AIR_INERTIA,
      gravity: PigeonFlock.GRAVITY,
      lift: PigeonFlock.LIFT,
      minAltitude: this.minAltitude,
      maxAltitude: this.maxAltitude,
      cruiseSpeed: this.cruiseSpeed,
      scale: this.birdScale
    }
    for (let i = 0; i < this.flockSize; i++) {
      const pos = Vector3.create(
        spawnCenter.x + (Math.random() * 10 - 5),
        spawnCenter.y + (Math.random() * 6 - 3),
        spawnCenter.z + (Math.random() * 10 - 5)
      )
      this.birds.push(new PigeonBird(config, this.world, pos, Math.random() * Math.PI * 2))
      // bravery varies per bird so only some break formation at first
      this.bravery.push(1 + (Math.random() * 2 - 1) * this.braverySpread)
      this.panic.push(0)
      this.jitter.push(Vector3.Zero())
    }
  }

  update(dt: number) {
    // --- remove birds the falcon caught ---
    for (let i = this.birds.length - 1; i >= 0; i--) {
      if (!this.birds[i].caught) continue
      this.birds[i].destroy(this.world)
      this.birds.splice(i, 1)
      this.bravery.splice(i, 1)
      this.panic.splice(i, 1)
      this.jitter.splice(i, 1)
    }
    if (this.birds.length === 0) return

    // --- flock statistics for the boids ---
    const c = Vector3.Zero()
    const v = Vector3.Zero()
    for (const bird of this.birds) {
      Vector3.addToRef(c, bird.position, c)
      Vector3.addToRef(v, bird.velocity, v)
    }
    this.center = Vector3.scale(c, 1 / this.birds.length)
    this.avgVelocity = Vector3.scale(v, 1 / this.birds.length)

    // --- retarget the wander anchor ---
    this.retargetTimer -= dt
    if (this.retargetTimer <= 0 || Vector3.distance(this.center, this.anchor) < 6) {
      this.pickAnchor()
    }

    const threat = getThreatPosition()

    for (let i = 0; i < this.birds.length; i++) {
      const bird = this.birds[i]
      const pos = bird.position

      // --- boid steering ---
      const desired = Vector3.Zero()
      for (const other of this.birds) {
        if (other === bird) continue
        const d = Vector3.distance(pos, other.position)
        if (d < PigeonFlock.SEPARATION_RADIUS && d > 0.01) {
          const push = Vector3.scale(Vector3.subtract(pos, other.position), 1 / (d * d))
          Vector3.addToRef(desired, Vector3.scale(push, PigeonFlock.SEPARATION_WEIGHT), desired)
        }
      }
      if (Vector3.length(this.avgVelocity) > 0.1) {
        Vector3.addToRef(
          desired,
          Vector3.scale(Vector3.normalize(this.avgVelocity), PigeonFlock.ALIGNMENT_WEIGHT),
          desired
        )
      }
      Vector3.addToRef(
        desired,
        Vector3.scale(Vector3.normalize(Vector3.subtract(this.center, pos)), PigeonFlock.COHESION_WEIGHT),
        desired
      )
      Vector3.addToRef(
        desired,
        Vector3.scale(Vector3.normalize(Vector3.subtract(this.anchor, pos)), PigeonFlock.TARGET_WEIGHT),
        desired
      )

      // --- individual panic (partial formation break) ---
      let panicked = false
      if (threat) {
        panicked = Vector3.distance(pos, threat) < this.reactionDistance * this.bravery[i]
        if (panicked) {
          const away = Vector3.subtract(pos, threat)
          away.y *= 0.3 // mostly flee horizontally
          const flee = Vector3.scale(Vector3.normalize(away), 3)
          // panic overrides flocking: the higher the panic, the more selfish the bird
          Vector3.lerpToRef(desired, flee, this.panic[i], desired)
        }
      }
      this.panic[i] = moveToward(this.panic[i], panicked ? 1 : 0, dt * (panicked ? 3 : 0.7))

      // --- wander jitter (random walk) ---
      const jitter = this.jitter[i]
      jitter.x += (Math.random() * 2 - 1) * dt * 2
      jitter.y += (Math.random() * 0.8 - 0.4) * dt * 2
      jitter.z += (Math.random() * 2 - 1) * dt * 2
      const jitterLength = Vector3.length(jitter)
      if (jitterLength > 1) Vector3.scaleToRef(jitter, 1 / jitterLength, jitter)
      Vector3.addToRef(desired, Vector3.scale(jitter, this.wanderRandomness), desired)

      if (Vector3.lengthSquared(desired) < 0.0001) Vector3.copyFrom(bird.forward, desired)

      const targetSpeed = this.cruiseSpeed + (this.maxSpeed - this.cruiseSpeed) * this.panic[i]
      const accel = PigeonFlock.ACCEL + (PigeonFlock.FLEE_ACCEL - PigeonFlock.ACCEL) * this.panic[i]
      bird.update(dt, desired, targetSpeed, accel, this.panic[i])
    }

    this.world.step(1 / 60, dt, 3)
    for (const bird of this.birds) bird.postStep()
  }

  private pickAnchor() {
    this.retargetTimer = this.retargetTime * (0.7 + Math.random() * 0.6)
    this.probe.probe(this.home, this.wanderRadius, this.minAltitude, this.maxAltitude, (target) => {
      this.anchor = target
    })
  }
}
