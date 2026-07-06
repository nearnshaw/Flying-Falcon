import CANNON from 'cannon'
import { Entity, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import {
  createBirdWorld,
  getThreatPosition,
  PigeonBird,
  WanderProbe
} from './pigeonBird'

/**
 * Individual wandering pigeons migrated from the Godot City-test prototype
 * (pigeon_spawner.gd + pigeon.gd). Unlike the boid flock, each bird wanders on
 * its own: it picks a waypoint near the buildings, drifts toward it with heavy
 * inertia and slow turns, and flees when the falcon (or the walking player)
 * gets within reactionDistance.
 *
 * Physics run on a cannon.js world; buildings are sensed with renderer
 * raycasts against the real scene colliders (forward avoidance rays per bird,
 * downward probes to pick waypoints near rooftops).
 *
 * @param pigeonCount - how many pigeons to spawn
 * @param cruiseSpeed - normal wandering speed (m/s)
 * @param maxSpeed - top speed while fleeing (m/s)
 * @param reactionDistance - falcon distance that triggers fleeing (m)
 * @param wanderRadius - how far from this entity waypoints are picked (m)
 * @param retargetTime - seconds before a bird picks a new waypoint
 * @param wanderRandomness - 0-1: how erratic the flight path is
 * @param minAltitude - birds steer up below this height (m)
 * @param maxAltitude - birds steer down above this height (m)
 * @param birdScale - model scale per pigeon
 */
export class PigeonSpawner {
  // --- flight physics, same values as pigeon.gd (less agile than the falcon) ---
  private static readonly TURN_SPEED = 1.2 // rad/s
  private static readonly ACCEL = 4
  private static readonly FLEE_ACCEL = 9
  private static readonly AIR_INERTIA = 1.5
  private static readonly GRAVITY = 14
  private static readonly LIFT = 0.95

  private world!: CANNON.World
  private birds: PigeonBird[] = []
  private probes: WanderProbe[] = []
  private targets: Vector3[] = []
  private jitter: Vector3.MutableVector3[] = []
  private retargetTimers: number[] = []
  private home: Vector3 = Vector3.Zero()

  constructor(
    public src: string,
    public entity: Entity,
    public pigeonCount: number = 12,
    public cruiseSpeed: number = 6,
    public maxSpeed: number = 14,
    public reactionDistance: number = 12,
    public wanderRadius: number = 50,
    public retargetTime: number = 8,
    public wanderRandomness: number = 0.4,
    public minAltitude: number = 3,
    public maxAltitude: number = 65,
    public birdScale: number = 0.3
  ) {}

  start() {
    this.world = createBirdWorld()
    this.home = Vector3.clone(Transform.get(this.entity).position)

    const config = {
      turnSpeed: PigeonSpawner.TURN_SPEED,
      airInertia: PigeonSpawner.AIR_INERTIA,
      gravity: PigeonSpawner.GRAVITY,
      lift: PigeonSpawner.LIFT,
      minAltitude: this.minAltitude,
      maxAltitude: this.maxAltitude,
      cruiseSpeed: this.cruiseSpeed,
      scale: this.birdScale
    }
    for (let i = 0; i < this.pigeonCount; i++) {
      const pos = Vector3.create(
        this.home.x + (Math.random() * 2 - 1) * this.wanderRadius,
        8 + Math.random() * 25,
        this.home.z + (Math.random() * 2 - 1) * this.wanderRadius
      )
      this.birds.push(new PigeonBird(config, this.world, pos, Math.random() * Math.PI * 2))
      this.probes.push(new WanderProbe())
      this.targets.push(Vector3.clone(pos))
      this.jitter.push(Vector3.Zero())
      this.retargetTimers.push(0) // forces a waypoint pick on the first frame
    }
  }

  update(dt: number) {
    // --- remove birds the falcon caught ---
    for (let i = this.birds.length - 1; i >= 0; i--) {
      if (!this.birds[i].caught) continue
      this.birds[i].destroy(this.world)
      this.probes[i].destroy()
      this.birds.splice(i, 1)
      this.probes.splice(i, 1)
      this.targets.splice(i, 1)
      this.jitter.splice(i, 1)
      this.retargetTimers.splice(i, 1)
    }
    if (this.birds.length === 0) return

    const threat = getThreatPosition()

    for (let i = 0; i < this.birds.length; i++) {
      const bird = this.birds[i]
      const pos = bird.position

      // --- pick desired direction ---
      const threatDistance = threat ? Vector3.distance(pos, threat) : Infinity
      const fleeing = threatDistance < this.reactionDistance
      let desired: Vector3
      let targetSpeed: number
      let accel: number
      if (fleeing && threat) {
        const away = Vector3.subtract(pos, threat)
        away.y *= 0.3 // mostly flee horizontally
        desired = Vector3.length(away) > 0.1 ? Vector3.normalize(away) : Vector3.Right()
        targetSpeed = this.maxSpeed
        accel = PigeonSpawner.FLEE_ACCEL
      } else {
        this.retargetTimers[i] -= dt
        if (this.retargetTimers[i] <= 0 || Vector3.distance(pos, this.targets[i]) < 4) {
          this.pickTarget(i)
        }
        desired = Vector3.normalize(Vector3.subtract(this.targets[i], pos))
        targetSpeed = this.cruiseSpeed
        accel = PigeonSpawner.ACCEL
      }

      // --- wander jitter (random walk) ---
      const jitter = this.jitter[i]
      jitter.x += (Math.random() * 2 - 1) * dt * 2
      jitter.y += (Math.random() * 0.8 - 0.4) * dt * 2
      jitter.z += (Math.random() * 2 - 1) * dt * 2
      const jitterLength = Vector3.length(jitter)
      if (jitterLength > 1) Vector3.scaleToRef(jitter, 1 / jitterLength, jitter)
      Vector3.addToRef(desired, Vector3.scale(jitter, this.wanderRandomness), desired)

      bird.update(dt, desired, targetSpeed, accel, fleeing ? 1 : 0)
    }

    this.world.step(1 / 60, dt, 3)
    for (const bird of this.birds) bird.postStep()
  }

  private pickTarget(index: number) {
    this.retargetTimers[index] = this.retargetTime * (0.6 + Math.random() * 0.8)
    this.probes[index].probe(this.home, this.wanderRadius, this.minAltitude, this.maxAltitude, (target) => {
      this.targets[index] = target
    })
  }
}
