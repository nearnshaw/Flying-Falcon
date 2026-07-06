import CANNON from 'cannon'
import {
  Animator,
  AudioSource,
  ColliderLayer,
  engine,
  Entity,
  GltfContainer,
  InputAction,
  inputSystem,
  PointerEventType,
  RaycastQueryType,
  raycastSystem,
  Transform
} from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import {
  getFalconEntity,
  isFalconAirborne,
  isFlightModeActive,
  setCatchHintVisible
} from '@modules/flightMode'

// Shared per-bird logic for the pigeons migrated from the Godot City-test
// prototype (pigeon.gd / boid_pigeon.gd). A PigeonBird owns its entities, its
// cannon.js body and its obstacle-avoidance raycast; the flock/spawner scripts
// act as the "brain" and feed it a desired direction each frame.

export const PIGEON_MODEL = 'assets/models/pigeon/pigeon-flight.glb'
export const PIGEON_CLIPS = ['Slow_Flap', 'Idle_Glide', 'Hysterical_Flap'] as const
export type PigeonClip = (typeof PIGEON_CLIPS)[number]

// same playable-area bounds the falcon respects
const SCENE_MIN_X = 2
const SCENE_MAX_X = 238
const SCENE_MIN_Z = 2
const SCENE_MAX_Z = 238

const BODY_RADIUS = 0.2
const AVOID_RAY_DISTANCE = 12 // how far ahead a pigeon senses buildings
const AVOID_RAY_INTERVAL = 0.25 // seconds between one-shot forward rays (staggered per bird)
const PROBE_HEIGHT = 70 // wander-target probes are cast down from this altitude

export interface BirdPhysicsConfig {
  turnSpeed: number // rad/s
  airInertia: number // lower = driftier velocity
  gravity: number
  lift: number // fraction of gravity cancelled at cruise speed
  minAltitude: number
  maxAltitude: number
  cruiseSpeed: number
  scale: number
}

/** while riding the falcon the pigeons flee the falcon, otherwise the walking player */
export function getThreatPosition(): Vector3 | null {
  if (isFlightModeActive()) {
    const falcon = getFalconEntity()
    if (falcon) {
      const t = Transform.getOrNull(falcon)
      if (t) return t.position
    }
  }
  const player = Transform.getOrNull(engine.PlayerEntity)
  return player ? player.position : null
}

export function clampToSceneXZ(v: Vector3.MutableVector3) {
  v.x = Math.min(Math.max(v.x, SCENE_MIN_X), SCENE_MAX_X)
  v.z = Math.min(Math.max(v.z, SCENE_MIN_Z), SCENE_MAX_Z)
}

export function moveToward(current: number, target: number, maxDelta: number): number {
  if (Math.abs(target - current) <= maxDelta) return target
  return current + Math.sign(target - current) * maxDelta
}

/**
 * Picks wander targets near the buildings: casts a one-shot ray down at a
 * random point and anchors beside/above whatever it finds, like the Godot
 * scripts did with their "perchable" group (the plaza has no such list, so
 * the rooftop height comes from the scene colliders instead).
 */
export class WanderProbe {
  private readonly entity: Entity = engine.addEntity()
  private probing = false

  constructor() {
    Transform.create(this.entity, { position: Vector3.create(0, PROBE_HEIGHT, 0) })
  }

  probe(center: Vector3, radius: number, minAltitude: number, maxAltitude: number, done: (target: Vector3) => void) {
    const point = Vector3.create(
      center.x + (Math.random() * 2 - 1) * radius,
      PROBE_HEIGHT,
      center.z + (Math.random() * 2 - 1) * radius
    )
    clampToSceneXZ(point)
    if (this.probing) {
      // previous ray still in flight — settle for a random altitude
      done(Vector3.create(point.x, minAltitude + 3 + Math.random() * 20, point.z))
      return
    }
    this.probing = true
    Transform.getMutable(this.entity).position = point
    raycastSystem.registerGlobalDirectionRaycast(
      {
        entity: this.entity,
        opts: {
          queryType: RaycastQueryType.RQT_HIT_FIRST,
          direction: Vector3.Down(),
          maxDistance: PROBE_HEIGHT,
          continuous: false,
          collisionMask: ColliderLayer.CL_PHYSICS
        }
      },
      (result) => {
        this.probing = false
        const hit = result.hits[0]
        const surfaceY = hit?.position ? hit.position.y : 0
        // hover 4-10m over whatever is down there (rooftop or street)
        let y = surfaceY + 4 + Math.random() * 6
        y = Math.min(Math.max(y, minAltitude + 2), maxAltitude)
        done(Vector3.create(point.x, y, point.z))
      }
    )
  }

  destroy() {
    raycastSystem.removeRaycasterEntity(this.entity)
    engine.removeEntity(this.entity)
  }
}

export class PigeonBird {
  readonly root: Entity = engine.addEntity()
  private readonly model: Entity = engine.addEntity()

  readonly body: CANNON.Body
  forward: Vector3.MutableVector3
  speed: number
  /** set by the catch system; the owning flock/spawner destroys the bird on its next update */
  caught = false

  private currentAnim: PigeonClip | '' = ''
  private avoidTimer: number
  private avoidHit: { distance: number; normal: Vector3 } | null = null

  constructor(
    private readonly config: BirdPhysicsConfig,
    world: CANNON.World,
    position: Vector3,
    yawRadians: number
  ) {
    this.speed = config.cruiseSpeed
    const yawDeg = yawRadians * (180 / Math.PI)
    this.forward = Vector3.rotate(Vector3.Forward(), Quaternion.fromEulerDegrees(0, yawDeg, 0))

    Transform.create(this.root, {
      position: Vector3.clone(position),
      rotation: Quaternion.fromEulerDegrees(0, yawDeg, 0)
    })
    // the Godot Model child carried a 180° Y flip that cancels against the
    // Godot(-Z fwd) ↔ DCL(+Z fwd) convention swap, so no extra rotation here
    Transform.create(this.model, {
      parent: this.root,
      scale: Vector3.create(config.scale, config.scale, config.scale)
    })
    GltfContainer.create(this.model, {
      src: PIGEON_MODEL,
      visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
      invisibleMeshesCollisionMask: ColliderLayer.CL_NONE
    })
    Animator.create(this.model, {
      states: PIGEON_CLIPS.map((clip) => ({
        clip,
        playing: false,
        loop: true,
        // slightly different playback rate per bird desyncs the flock's
        // wingbeats (Godot did this with anim.seek(randf()))
        speed: 0.85 + Math.random() * 0.3
      }))
    })
    this.playAnim('Slow_Flap')

    this.body = new CANNON.Body({ mass: 1 })
    this.body.addShape(new CANNON.Sphere(BODY_RADIUS))
    this.body.position.set(position.x, position.y, position.z)
    world.addBody(this.body)

    this.avoidTimer = Math.random() * AVOID_RAY_INTERVAL // stagger rays across the flock
    activeBirds.push(this)
  }

  get position(): Vector3.ReadonlyVector3 {
    return Transform.get(this.root).position
  }

  get velocity(): Vector3 {
    return Vector3.create(this.body.velocity.x, this.body.velocity.y, this.body.velocity.z)
  }

  /**
   * Steer, accelerate and animate for this frame. `desired` need not be
   * normalized; `panic` (0-1) picks the animation exactly like the Godot birds.
   * Call before the shared world.step(); call postStep() after it.
   */
  update(dt: number, desired: Vector3, targetSpeed: number, accel: number, panic: number) {
    let dir = Vector3.normalize(desired)

    // --- obstacle avoidance: steer along the wall normal, biased upward ---
    this.avoidTimer -= dt
    if (this.avoidTimer <= 0) {
      this.avoidTimer = AVOID_RAY_INTERVAL
      this.castAvoidRay()
    }
    if (this.avoidHit) {
      const urgency = 1 - this.avoidHit.distance / AVOID_RAY_DISTANCE
      dir = Vector3.add(dir, Vector3.scale(this.avoidHit.normal, 2 * urgency))
      dir.y += urgency // buildings are best cleared by climbing
      dir = Vector3.normalize(dir)
    }

    // --- altitude limits (Godot: push up/down near the floor/ceiling) ---
    const pos = this.position
    if (pos.y < this.config.minAltitude) dir.y = Math.abs(dir.y) + 0.5
    else if (pos.y > this.config.maxAltitude) dir.y = -Math.abs(dir.y) - 0.5
    dir.y = Math.min(Math.max(dir.y, -0.6), 0.6)
    dir = Vector3.normalize(dir)

    // --- limited-agility turn: rotate current heading toward the desired one ---
    const angle = Math.acos(Math.min(Math.max(Vector3.dot(this.forward, dir), -1), 1))
    if (angle > 0.001) {
      const axis = Vector3.cross(this.forward, dir)
      if (Vector3.lengthSquared(axis) > 0.000001) {
        const step = Math.min(this.config.turnSpeed * dt, angle)
        this.forward = Vector3.normalize(
          Vector3.rotate(this.forward, Quaternion.fromAngleAxis(step * (180 / Math.PI), Vector3.normalize(axis)))
        )
      }
    }

    // --- speed & velocity with inertia (mirrors the Godot _physics_process) ---
    const accelerating = targetSpeed > this.speed + 0.3
    this.speed = moveToward(this.speed, targetSpeed, accel * dt)
    const blend = 1 - Math.exp(-this.config.airInertia * dt)
    const target = Vector3.scale(this.forward, this.speed)
    const v = this.body.velocity
    v.set(
      v.x + (target.x - v.x) * blend,
      v.y + (target.y - v.y) * blend,
      v.z + (target.z - v.z) * blend
    )
    const liftRatio = Math.min(Math.max(this.speed / this.config.cruiseSpeed, 0), 1) * this.config.lift
    v.y -= this.config.gravity * (1 - liftRatio) * dt

    // --- animation ---
    let wanted: PigeonClip = 'Idle_Glide'
    if (panic > 0.5 && this.speed > this.config.cruiseSpeed + 1) wanted = 'Hysterical_Flap'
    else if (accelerating || panic > 0.1) wanted = 'Slow_Flap'
    this.playAnim(wanted)
  }

  /** copy the stepped physics body back onto the rendered entity */
  postStep() {
    const transform = Transform.getMutable(this.root)
    transform.position.x = this.body.position.x
    transform.position.y = this.body.position.y
    transform.position.z = this.body.position.z
    clampToSceneXZ(transform.position)
    this.body.position.x = transform.position.x
    this.body.position.z = transform.position.z
    if (Math.abs(this.forward.y) < 0.99) {
      transform.rotation = Quaternion.lookRotation(this.forward, Vector3.Up())
    }
  }

  destroy(world: CANNON.World) {
    const index = activeBirds.indexOf(this)
    if (index >= 0) activeBirds.splice(index, 1)
    raycastSystem.removeRaycasterEntity(this.root)
    world.remove(this.body)
    engine.removeEntity(this.model)
    engine.removeEntity(this.root)
  }

  private playAnim(clip: PigeonClip) {
    if (this.currentAnim === clip) return
    this.currentAnim = clip
    Animator.playSingleAnimation(this.model, clip)
  }

  private castAvoidRay() {
    // one-shot ray so 26 birds don't keep 26 continuous renderer rays alive;
    // re-registering replaces the previous Raycast component on the root
    raycastSystem.registerLocalDirectionRaycast(
      {
        entity: this.root,
        opts: {
          queryType: RaycastQueryType.RQT_HIT_FIRST,
          direction: Vector3.Forward(),
          maxDistance: AVOID_RAY_DISTANCE,
          continuous: false,
          collisionMask: ColliderLayer.CL_PHYSICS
        }
      },
      (result) => {
        const hit = result.hits[0]
        this.avoidHit =
          hit?.normalHit && hit.length !== undefined
            ? { distance: hit.length, normal: Vector3.create(hit.normalHit.x, hit.normalHit.y, hit.normalHit.z) }
            : null
      }
    )
  }
}

/** zero-gravity world (gravity is applied manually per bird, like the falcon's) */
export function createBirdWorld(): CANNON.World {
  const world = new CANNON.World()
  const ground = new CANNON.Body({ mass: 0 })
  ground.addShape(new CANNON.Plane())
  ground.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2)
  world.addBody(ground)
  return world
}

// ------------------------------------------------------------ catching

// every living bird, across the flock and the spawner (birds register
// themselves on construction and deregister in destroy())
export const activeBirds: PigeonBird[] = []

const CATCH_DISTANCE = 3
const CATCH_SOUND = 'assets/sounds/cake splat/cake_splat_1.mp3'
const catchSoundEntity = engine.addEntity()

/**
 * While the falcon is airborne, shows the "Press E to Catch" prompt whenever a
 * pigeon is within reach, and resolves the catch on E. Runs once for the whole
 * scene (module-level system); the prompt itself is rendered by src/ui.tsx.
 */
function pigeonCatchSystem() {
  if (!isFlightModeActive() || !isFalconAirborne()) {
    setCatchHintVisible(false)
    return
  }
  const falcon = getFalconEntity()
  const falconTransform = falcon ? Transform.getOrNull(falcon) : null
  if (!falconTransform) {
    setCatchHintVisible(false)
    return
  }

  let nearest: PigeonBird | null = null
  let nearestDistance = CATCH_DISTANCE
  for (const bird of activeBirds) {
    if (bird.caught) continue
    const distance = Vector3.distance(bird.position, falconTransform.position)
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearest = bird
    }
  }
  setCatchHintVisible(nearest !== null)

  if (nearest && inputSystem.isTriggered(InputAction.IA_PRIMARY, PointerEventType.PET_DOWN)) {
    nearest.caught = true // the owning flock/spawner removes it on its next update
    Transform.createOrReplace(catchSoundEntity, { position: Vector3.clone(nearest.position) })
    AudioSource.createOrReplace(catchSoundEntity, { audioClipUrl: CATCH_SOUND, playing: true, volume: 1 })
    setCatchHintVisible(false)
  }
}

engine.addSystem(pigeonCatchSystem)
