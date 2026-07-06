import CANNON from 'cannon'
import {
  Animator,
  ColliderLayer,
  engine,
  Entity,
  InputAction,
  InputModifier,
  inputSystem,
  MainCamera,
  Name,
  PointerEventType,
  pointerEventsSystem,
  Raycast,
  RaycastQueryType,
  raycastSystem,
  Transform,
  VirtualCamera,
  VisibilityComponent
} from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import { movePlayerTo } from '~system/RestrictedActions'
import { setControlsHintVisible, setFalconAirborne, setFalconEntity, setFlightMode } from '@modules/flightMode'

enum FalconMode {
  PERCHED,
  FLYING
}

/**
 * Rideable falcon migrated from the Godot City-test prototype.
 * Click the falcon to take control of it: while perched, Space or Shift takes off
 * and E dismounts. In flight, steer with W/S (pitch) and A/D (yaw), hold Shift to
 * flap (speed up / climb) and Space to divebomb. Land on flat ground to perch again.
 * Physics (velocity integration + ground collision) runs on a cannon.js world.
 *
 * @param glideSpeed - cruising speed with wings spread (m/s)
 * @param flapSpeed - top speed while beating wings with Shift (m/s)
 * @param diveSpeed - top speed while divebombing with Space (m/s)
 * @param gravity - downward acceleration while flying (m/s²)
 * @param turnSpeed - yaw rate in radians/s (A/D)
 * @param pitchSpeed - pitch rate in radians/s (W = nose down, S = nose up)
 * @param takeoffImpulse - upward kick when leaving a perch (m/s)
 * @param camDistance - how far behind the falcon the camera flies (m)
 * @param camHeight - how far above the falcon the camera flies (m)
 * @param camFollow - how quickly the camera swings behind the falcon (higher = snappier)
 * @param maxLandSpeed - flying faster than this skims off surfaces instead of landing (m/s)
 */
export class FalconController {
  // --- flight tuning not exposed in the editor UI (same values as the Godot prototype) ---
  private static readonly MIN_AIR_SPEED = 6 // below this the nose drops (stall)
  private static readonly FLAP_ACCEL = 15
  private static readonly GLIDE_DECEL = 5
  private static readonly DIVE_ACCEL = 40
  private static readonly AIR_INERTIA = 2.5 // how quickly velocity follows facing (lower = driftier)
  private static readonly GLIDE_LIFT = 0.85 // fraction of gravity cancelled while gliding at speed
  private static readonly FLAP_LIFT = 1.05 // lift while flapping (>1 lets you climb)
  private static readonly STALL_PITCH_DOWN = 0.8 // rad/s the nose drops when too slow
  private static readonly MAX_PITCH_DEG = 65
  private static readonly DIVE_PITCH_DEG = 70 // nose-down angle forced during a dive
  private static readonly DIVE_PITCH_SNAP = 4
  private static readonly BANK_AMOUNT = 0.7 // visual roll when turning (rad)
  private static readonly PERCH_MIN_NORMAL_Y = 0.7 // how flat a surface must be to perch on it
  private static readonly BODY_RADIUS = 0.35
  private static readonly CEILING_Y = 120
  private static readonly FORWARD_RAY_DISTANCE = 30 // how far ahead the falcon senses walls
  private static readonly DOWN_RAY_DISTANCE = 60 // how far below the falcon senses landing spots
  // model swapping is done by moving the inactive model far underground instead of
  // VisibilityComponent: the renderer does not reliably re-show a GLTF whose
  // visibility is toggled back on (the posed model stayed invisible after landing).
  // the "shown" positions are whatever the editor authored (recorded in start())
  private static readonly MODEL_HIDDEN_Y = -200 // parked far below the scene

  private mode: FalconMode = FalconMode.PERCHED
  private controlled = false
  private launchJumpHeld = false // Space is still held from the take-off press
  private controlsHintCountdown = -1 // <0 waiting for first take-off, >0 counting down
  private speed = 0
  private pitch = 0 // radians, positive = nose down (DCL/Unity convention)
  private bank = 0
  private yaw = 0
  private currentAnim = ''

  private posedEntity: Entity | null = null
  private flightEntity: Entity | null = null
  // editor-authored local positions of the two models, captured at start():
  // the posed falcon may be dragged around relative to the root in the Creator
  // Hub, and showing/hiding must restore exactly that pose
  private posedHome: Vector3.MutableVector3 = Vector3.Zero()
  private flightHome: Vector3.MutableVector3 = Vector3.Zero()
  private cameraEntity: Entity = engine.addEntity()

  private world!: CANNON.World
  private body!: CANNON.Body
  private groundContactNormalY = -1

  // scene-collider sensing: the renderer resolves these rays against the real
  // GLB collider meshes (CL_PHYSICS), so buildings need no cannon counterpart
  private forwardRayEntity: Entity = engine.addEntity()
  private downRayEntity: Entity = engine.addEntity()
  private raysActive = false
  private downRayActive = false
  private forwardHit: { distance: number; normal: Vector3 } | null = null
  private downHit: { distance: number; normalY: number; surfaceY: number } | null = null

  // spring-arm camera ray (Godot used SpringArm3D): pulls the chase camera in
  // front of any collider between the falcon and the desired camera position
  private camRayEntity: Entity = engine.addEntity()
  private camRayActive = false
  private camObstruction: { distance: number } | null = null

  constructor(
    public src: string,
    public entity: Entity,
    public glideSpeed: number = 12,
    public flapSpeed: number = 26,
    public diveSpeed: number = 55,
    public gravity: number = 18,
    public turnSpeed: number = 2,
    public pitchSpeed: number = 1.6,
    public takeoffImpulse: number = 10,
    public camDistance: number = 7,
    public camHeight: number = 2.5,
    public camFollow: number = 3,
    public maxLandSpeed: number = 30
  ) {}

  start() {
    setFalconEntity(this.entity) // lets the pigeons know what to flee from
    const rootTransform = Transform.get(this.entity)
    this.yaw = Quaternion.toEulerAngles(rootTransform.rotation).y * (Math.PI / 180)

    this.findModelChildren()

    // remember where the editor placed each model relative to the root, so
    // show/hide restores the authored pose instead of assuming (0, y, 0).
    // guard against a composite saved mid-flight with a model still parked
    // at MODEL_HIDDEN_Y
    if (this.posedEntity) {
      this.posedHome = Vector3.clone(Transform.get(this.posedEntity).position)
      if (this.posedHome.y <= FalconController.MODEL_HIDDEN_Y / 2) this.posedHome.y = 0
    }
    if (this.flightEntity) {
      this.flightHome = Vector3.clone(Transform.get(this.flightEntity).position)
      if (this.flightHome.y <= FalconController.MODEL_HIDDEN_Y / 2) this.flightHome.y = 0
    }

    this.setupPhysics(rootTransform.position)
    this.setupCamera(rootTransform.position)

    // visibility is driven purely by position (see MODEL_HIDDEN_Y) — make sure
    // no VisibilityComponent (e.g. from the composite) can keep a model hidden
    for (const model of [this.posedEntity, this.flightEntity]) {
      if (model && VisibilityComponent.has(model)) VisibilityComponent.deleteFrom(model)
    }

    // make the flight animations loop, regardless of what the composite says —
    // a Creator Hub re-save normalizes Animator states back to loop: false
    if (this.flightEntity) {
      const flightAnimator = Animator.getMutableOrNull(this.flightEntity)
      if (flightAnimator) {
        for (const state of flightAnimator.states) state.loop = true
      }
    }

    this.updateModeVisuals()

    // ray origins sit at the body center (root sits at the falcon's feet);
    // parented to the root so the forward ray rotates with the facing
    Transform.create(this.forwardRayEntity, {
      position: Vector3.create(0, FalconController.BODY_RADIUS, 0),
      parent: this.entity
    })
    Transform.create(this.downRayEntity, {
      position: Vector3.create(0, FalconController.BODY_RADIUS, 0),
      parent: this.entity
    })
    Transform.create(this.camRayEntity, {
      position: Vector3.create(0, FalconController.BODY_RADIUS, 0),
      parent: this.entity
    })

    // the collider lives on the posed model's meshes, so pointer events land on that child
    pointerEventsSystem.onPointerDown(
      {
        entity: this.posedEntity ?? this.entity,
        opts: { button: InputAction.IA_POINTER, hoverText: 'Ride falcon', maxDistance: 8 }
      },
      () => {
        if (!this.controlled) this.takeControl()
      }
    )
  }

  private findModelChildren() {
    for (const [child] of engine.getEntitiesWith(Transform)) {
      if (Transform.get(child).parent !== this.entity) continue
      const name = Name.getOrNull(child)
      if (!name) continue
      if (name.value.includes('Posed')) this.posedEntity = child
      else if (name.value.includes('Flight')) this.flightEntity = child
    }
    if (!this.posedEntity || !this.flightEntity) {
      console.error('[Falcon] missing "Falcon Posed" / "Falcon Flight" child entities')
    }
  }

  private setupPhysics(startPosition: Vector3.ReadonlyVector3) {
    // Gravity and lift are applied manually each frame (mirroring the original
    // controller), so the world itself carries no gravity. Cannon integrates the
    // body and resolves ground contacts.
    this.world = new CANNON.World()
    this.world.gravity.set(0, 0, 0)

    const groundMaterial = new CANNON.Material('ground')
    const ground = new CANNON.Body({ mass: 0, material: groundMaterial })
    ground.addShape(new CANNON.Plane())
    ground.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2)
    this.world.addBody(ground)

    const falconMaterial = new CANNON.Material('falcon')
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(groundMaterial, falconMaterial, { friction: 0.9, restitution: 0 })
    )

    this.body = new CANNON.Body({ mass: 1, material: falconMaterial })
    this.body.addShape(new CANNON.Sphere(FalconController.BODY_RADIUS))
    this.body.position.set(startPosition.x, startPosition.y + FalconController.BODY_RADIUS, startPosition.z)
    this.body.addEventListener('collide', (event: { contact: CANNON.ContactEquation; body: CANNON.Body }) => {
      // cannon's contact normal points from body i to body j; flip it when the
      // falcon is bi so we always get the surface normal (pointing up off the ground)
      const normal = event.contact.bi === this.body ? event.contact.ni.scale(-1) : event.contact.ni
      this.groundContactNormalY = normal.y
    })
    this.world.addBody(this.body)
  }

  private setupCamera(falconPosition: Vector3.ReadonlyVector3) {
    Transform.create(this.cameraEntity, {
      position: this.cameraPositionFor(falconPosition),
      rotation: Quaternion.Identity()
    })
    VirtualCamera.create(this.cameraEntity, {
      defaultTransition: { transitionMode: VirtualCamera.Transition.Time(0.8) },
      lookAtEntity: this.entity
    })
  }

  private cameraPositionFor(falconPosition: Vector3.ReadonlyVector3): Vector3 {
    const back = Vector3.rotate(Vector3.Forward(), Quaternion.fromEulerDegrees(0, (this.yaw * 180) / Math.PI, 0))
    return Vector3.create(
      falconPosition.x - back.x * this.camDistance,
      falconPosition.y + this.camHeight,
      falconPosition.z - back.z * this.camDistance
    )
  }

  // ------------------------------------------------------------ control

  private takeControl() {
    this.controlled = true
    setFlightMode(true)
    setControlsHintVisible(true)
    this.controlsHintCountdown = -1 // countdown starts at the first take-off

    // fly from wherever the posed falcon actually is right now
    this.adoptPosedPose()
    this.syncBodyToTransform()
    this.registerCamRay()

    InputModifier.createOrReplace(engine.PlayerEntity, {
      mode: InputModifier.Mode.Standard({ disableAll: true })
    })
    const falconPos = Transform.get(this.entity).position
    Transform.getMutable(this.cameraEntity).position = this.cameraPositionFor(falconPos)
    MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: this.cameraEntity })
  }

  private releaseControl() {
    this.controlled = false
    setFlightMode(false)
    setFalconAirborne(false)
    setControlsHintVisible(false)
    this.removeRays()
    this.removeCamRay()

    InputModifier.deleteFrom(engine.PlayerEntity)
    const mainCamera = MainCamera.getMutableOrNull(engine.CameraEntity)
    if (mainCamera) mainCamera.virtualCameraEntity = undefined
    // bring the (frozen, possibly far away) avatar to where the falcon perched
    const falconPos = Transform.get(this.entity).position
    movePlayerTo({ newRelativePosition: Vector3.create(falconPos.x + 1.5, falconPos.y, falconPos.z + 1.5) })
  }

  // ------------------------------------------------------------ lifecycle

  update(dt: number) {
    if (!this.controlled) return

    if (this.controlsHintCountdown > 0) {
      this.controlsHintCountdown -= dt
      if (this.controlsHintCountdown <= 0) {
        this.controlsHintCountdown = 0
        setControlsHintVisible(false)
      }
    }

    if (this.mode === FalconMode.PERCHED) {
      this.updatePerched()
    } else {
      this.updateFlying(dt)
    }
    this.updateCamera(dt)
  }

  private updatePerched() {
    this.body.velocity.set(0, 0, 0)
    if (
      inputSystem.isTriggered(InputAction.IA_JUMP, PointerEventType.PET_DOWN) ||
      inputSystem.isTriggered(InputAction.IA_MODIFIER, PointerEventType.PET_DOWN)
    ) {
      this.takeOff()
    } else if (inputSystem.isTriggered(InputAction.IA_PRIMARY, PointerEventType.PET_DOWN)) {
      this.releaseControl()
    }
  }

  private registerRays() {
    if (this.raysActive) return
    this.raysActive = true
    this.forwardHit = null

    raycastSystem.registerLocalDirectionRaycast(
      {
        entity: this.forwardRayEntity,
        opts: {
          queryType: RaycastQueryType.RQT_HIT_FIRST,
          direction: Vector3.Forward(),
          maxDistance: FalconController.FORWARD_RAY_DISTANCE,
          continuous: true,
          collisionMask: ColliderLayer.CL_PHYSICS
        }
      },
      (result) => {
        const hit = result.hits[0]
        this.forwardHit =
          hit?.normalHit && hit.length !== undefined
            ? { distance: hit.length, normal: Vector3.create(hit.normalHit.x, hit.normalHit.y, hit.normalHit.z) }
            : null
      }
    )

    this.updateDownRay()
  }

  /**
   * The landing (down) ray only exists while flying slowly enough to land:
   * above maxLandSpeed there is nothing to detect, so the continuous renderer
   * raycast is dropped instead of paid for every frame of a fast pass.
   */
  private updateDownRay() {
    const canLand = this.speed <= this.maxLandSpeed
    if (canLand === this.downRayActive) return
    this.downRayActive = canLand

    if (!canLand) {
      raycastSystem.removeRaycasterEntity(this.downRayEntity)
      this.downHit = null
      return
    }

    raycastSystem.registerGlobalDirectionRaycast(
      {
        entity: this.downRayEntity,
        opts: {
          queryType: RaycastQueryType.RQT_HIT_FIRST,
          direction: Vector3.Down(),
          maxDistance: FalconController.DOWN_RAY_DISTANCE,
          continuous: true,
          collisionMask: ColliderLayer.CL_PHYSICS
        }
      },
      (result) => {
        const hit = result.hits[0]
        this.downHit =
          hit?.normalHit && hit.position && hit.length !== undefined
            ? { distance: hit.length, normalY: hit.normalHit.y, surfaceY: hit.position.y }
            : null
      }
    )
  }

  private removeRays() {
    if (!this.raysActive && !this.downRayActive) return
    this.raysActive = false
    raycastSystem.removeRaycasterEntity(this.forwardRayEntity)
    this.forwardHit = null
    if (this.downRayActive) {
      this.downRayActive = false
      raycastSystem.removeRaycasterEntity(this.downRayEntity)
      this.downHit = null
    }
  }

  private registerCamRay() {
    if (this.camRayActive) return
    this.camRayActive = true
    this.camObstruction = null
    raycastSystem.registerGlobalTargetRaycast(
      {
        entity: this.camRayEntity,
        opts: {
          queryType: RaycastQueryType.RQT_HIT_FIRST,
          target: this.cameraPositionFor(Transform.get(this.entity).position),
          maxDistance: this.camDistance + this.camHeight + 2,
          continuous: true,
          collisionMask: ColliderLayer.CL_PHYSICS
        }
      },
      (result) => {
        const hit = result.hits[0]
        this.camObstruction = hit?.length !== undefined ? { distance: hit.length } : null
      }
    )
  }

  private removeCamRay() {
    if (!this.camRayActive) return
    this.camRayActive = false
    raycastSystem.removeRaycasterEntity(this.camRayEntity)
    this.camObstruction = null
  }

  /**
   * The posed model may have been dragged away from the root in the Creator Hub
   * editor (the editor moves the child with the meshes, not the script root).
   * All flight logic — physics body, camera, rays — is root-relative, so fold
   * the posed model's local offset and rotation into the root once, when the
   * player takes control: flight then starts exactly where the visible falcon
   * is. Safe to call repeatedly (after the first fold it is a no-op).
   */
  private adoptPosedPose() {
    if (!this.posedEntity) return
    const root = Transform.getMutable(this.entity)
    const posed = Transform.getMutable(this.posedEntity)
    const home = this.posedHome
    // fold only x/z: the local y is the model's pivot lift (the posed GLB is
    // centered, not foot-pivoted) and must keep applying on every future perch
    const offset = Vector3.rotate(
      Vector3.create(home.x * root.scale.x, 0, home.z * root.scale.z),
      root.rotation
    )
    root.position = Vector3.add(root.position, offset)
    root.rotation = Quaternion.multiply(root.rotation, posed.rotation)
    posed.rotation = Quaternion.Identity()
    this.posedHome.x = 0
    this.posedHome.z = 0
    // re-place both models against the new root; the posed model's world pose
    // does not change, the flight model now takes off from that same spot
    this.updateModeVisuals()
  }

  /** re-sync the physics body to wherever the entity currently is (it may have
   *  been repositioned in the editor or by other scene code since start()) */
  private syncBodyToTransform() {
    const rootTransform = Transform.get(this.entity)
    this.body.position.set(
      rootTransform.position.x,
      rootTransform.position.y + FalconController.BODY_RADIUS,
      rootTransform.position.z
    )
    this.yaw = (Quaternion.toEulerAngles(rootTransform.rotation).y * Math.PI) / 180
  }

  private takeOff() {
    this.syncBodyToTransform()
    this.mode = FalconMode.FLYING
    // if the launch key was Space, keep treating it as wing-beating until released
    this.launchJumpHeld = inputSystem.isPressed(InputAction.IA_JUMP)
    // the controls panel lingers for 10 more seconds after the first take-off
    if (this.controlsHintCountdown < 0) this.controlsHintCountdown = 10
    setFalconAirborne(true)
    this.updateModeVisuals()
    this.registerRays()
    console.log(
      `[Falcon] taking off from (${this.body.position.x.toFixed(1)}, ${this.body.position.y.toFixed(1)}, ${this.body.position.z.toFixed(1)})`
    )
    this.playAnim('Idle_Gliding')
    this.pitch = -0.15 // slight nose-up launch
    this.speed = this.glideSpeed
    const forward = this.forwardVector()
    this.body.velocity.set(
      forward.x * this.speed,
      forward.y * this.speed + this.takeoffImpulse,
      forward.z * this.speed
    )
  }

  private updateFlying(dt: number) {
    let diving = inputSystem.isPressed(InputAction.IA_JUMP)
    let flapping = inputSystem.isPressed(InputAction.IA_MODIFIER)

    // a Space launch must not turn into an instant dive: while the launch
    // press is still held, Space keeps beating wings (same as Shift); once
    // released, Space goes back to meaning dive
    if (this.launchJumpHeld) {
      if (diving) {
        diving = false
        flapping = true
      } else {
        this.launchJumpHeld = false
      }
    }

    this.playAnim(diving ? 'Dive_FreeFall' : flapping ? 'Flap_Hard' : 'Idle_Gliding')

    // --- steering ---
    let yawInput = 0
    if (inputSystem.isPressed(InputAction.IA_LEFT)) yawInput -= 1
    if (inputSystem.isPressed(InputAction.IA_RIGHT)) yawInput += 1
    this.yaw += yawInput * this.turnSpeed * dt

    let pitchInput = 0 // W = nose down, S = nose up
    if (inputSystem.isPressed(InputAction.IA_FORWARD)) pitchInput += 1
    if (inputSystem.isPressed(InputAction.IA_BACKWARD)) pitchInput -= 1

    const maxPitch = (FalconController.MAX_PITCH_DEG * Math.PI) / 180
    if (diving) {
      const divePitch = (FalconController.DIVE_PITCH_DEG * Math.PI) / 180
      this.pitch += (divePitch - this.pitch) * Math.min(1, FalconController.DIVE_PITCH_SNAP * dt)
    } else {
      this.pitch += pitchInput * this.pitchSpeed * dt
      if (this.speed < FalconController.MIN_AIR_SPEED) {
        this.pitch += FalconController.STALL_PITCH_DOWN * dt // stall: nose drops to regain speed
      }
      this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch))
    }

    // visual banking: roll into the turn (positive Z roll tips the left wing down)
    const targetBank = -yawInput * FalconController.BANK_AMOUNT
    this.bank += (targetBank - this.bank) * Math.min(1, 5 * dt)

    // --- speed ---
    if (diving) {
      this.speed = this.moveToward(this.speed, this.diveSpeed, FalconController.DIVE_ACCEL * dt)
    } else if (flapping) {
      this.speed = this.moveToward(this.speed, this.flapSpeed, FalconController.FLAP_ACCEL * dt)
    } else {
      this.speed = this.moveToward(this.speed, this.glideSpeed, FalconController.GLIDE_DECEL * dt)
    }

    // --- velocity: follow facing with inertia ---
    const forward = this.forwardVector()
    const follow = 1 - Math.exp(-FalconController.AIR_INERTIA * dt)
    const vel = this.body.velocity
    vel.x += (forward.x * this.speed - vel.x) * follow
    vel.y += (forward.y * this.speed - vel.y) * follow
    vel.z += (forward.z * this.speed - vel.z) * follow

    // --- gravity minus lift ---
    let liftRatio =
      Math.max(0, Math.min(1, this.speed / this.glideSpeed)) *
      (flapping ? FalconController.FLAP_LIFT : FalconController.GLIDE_LIFT)
    if (diving) liftRatio = 0 // wings tucked: full gravity
    vel.y -= this.gravity * (1 - liftRatio) * dt

    // landing is only possible below maxLandSpeed; the down ray comes and goes
    // with that threshold (updateDownRay drops the continuous ray while fast)
    const canLand = this.speed <= this.maxLandSpeed
    this.updateDownRay()

    // --- wall response: slide off steep surfaces the forward ray sees ---
    // while slow, flat surfaces (normalY >= perch threshold) are deliberately
    // excluded so a descent onto a roof reaches the down-ray landing check
    // instead of hovering; while too fast to land, flat surfaces slide too —
    // the falcon skims off rooftops rather than tunneling through them (the
    // cannon world only knows the y=0 ground plane, not the buildings)
    if (this.forwardHit && (!canLand || this.forwardHit.normal.y < FalconController.PERCH_MIN_NORMAL_Y)) {
      const brakeDistance = FalconController.BODY_RADIUS + this.speed * 0.35
      if (this.forwardHit.distance <= brakeDistance) {
        const n = this.forwardHit.normal
        const into = vel.x * n.x + vel.y * n.y + vel.z * n.z
        if (into < 0) {
          // remove the velocity component pushing into the wall and scrub speed
          vel.x -= n.x * into
          vel.y -= n.y * into
          vel.z -= n.z * into
          this.speed = Math.min(this.speed, this.glideSpeed)
        }
      }
    }

    // --- physics step: cannon integrates position and resolves ground contact ---
    this.groundContactNormalY = -1
    this.world.step(1 / 60, dt, 3)
    this.keepInsideScene()

    // --- write back to the entity ---
    const transform = Transform.getMutable(this.entity)
    transform.position = Vector3.create(
      this.body.position.x,
      this.body.position.y - FalconController.BODY_RADIUS,
      this.body.position.z
    )
    transform.rotation = Quaternion.fromEulerDegrees(
      (this.pitch * 180) / Math.PI,
      (this.yaw * 180) / Math.PI,
      (this.bank * 180) / Math.PI
    )

    // --- perch detection (only below maxLandSpeed; too fast just keeps flying) ---
    // 1) down ray: descending onto flat scene geometry (rooftops, terraces, ground)
    if (
      canLand &&
      this.downHit &&
      this.body.velocity.y <= 0 &&
      this.downHit.normalY >= FalconController.PERCH_MIN_NORMAL_Y
    ) {
      // reach grows with fall speed to absorb the one-frame raycast latency
      const reach = FalconController.BODY_RADIUS + Math.max(0.15, -this.body.velocity.y * 0.12)
      if (this.downHit.distance <= reach) {
        this.body.position.y = this.downHit.surfaceY + FalconController.BODY_RADIUS
        transform.position = Vector3.create(
          this.body.position.x,
          this.downHit.surfaceY,
          this.body.position.z
        )
        this.perch()
        return
      }
    }
    // 2) cannon ground plane at y=0 (fallback for the open plaza floor); a
    // too-fast ground hit just skids along the plane until the bird slows
    if (canLand && this.groundContactNormalY >= FalconController.PERCH_MIN_NORMAL_Y) {
      this.perch()
    }
  }

  private perch() {
    this.mode = FalconMode.PERCHED
    setFalconAirborne(false)
    this.updateModeVisuals()
    this.removeRays()
    if (this.flightEntity) Animator.stopAllAnimations(this.flightEntity)
    this.currentAnim = ''
    this.body.velocity.set(0, 0, 0)
    this.speed = 0
    this.pitch = 0
    this.bank = 0
    const transform = Transform.getMutable(this.entity)
    transform.rotation = Quaternion.fromEulerDegrees(0, (this.yaw * 180) / Math.PI, 0)
    console.log(
      `[Falcon] perched at (${transform.position.x.toFixed(1)}, ${transform.position.y.toFixed(1)}, ${transform.position.z.toFixed(1)})`
    )
  }

  private updateCamera(dt: number) {
    const falconPos = Transform.get(this.entity).position
    const falconCenter = Vector3.create(falconPos.x, falconPos.y + FalconController.BODY_RADIUS, falconPos.z)
    const desired = this.cameraPositionFor(falconPos)

    // keep the spring-arm ray aimed from the falcon at the desired camera spot
    const camRay = Raycast.getMutableOrNull(this.camRayEntity)
    if (camRay) camRay.direction = { $case: 'globalTarget', globalTarget: desired }

    // spring arm: if geometry sits between falcon and camera, pull the camera
    // in front of it so the falcon is never occluded (Godot's SpringArm3D)
    let target = desired
    const boomLength = Vector3.distance(falconCenter, desired)
    if (this.camObstruction && this.camObstruction.distance < boomLength) {
      const boomDir = Vector3.normalize(Vector3.subtract(desired, falconCenter))
      const pulledDistance = Math.max(0.5, this.camObstruction.distance - 0.3)
      target = Vector3.add(falconCenter, Vector3.scale(boomDir, pulledDistance))
    }

    const camTransform = Transform.getMutable(this.cameraEntity)
    const follow = this.mode === FalconMode.FLYING ? 1 - Math.exp(-this.camFollow * dt) : Math.min(1, 5 * dt)
    camTransform.position = Vector3.lerp(camTransform.position, target, follow)
    // never let the chase camera clip under the ground
    if (camTransform.position.y < 0.5) camTransform.position.y = 0.5
  }

  // ------------------------------------------------------------ helpers

  private updateModeVisuals() {
    const showPosed = this.mode === FalconMode.PERCHED
    this.placeModel(this.posedEntity, this.posedHome, showPosed)
    this.placeModel(this.flightEntity, this.flightHome, !showPosed)
  }

  private placeModel(model: Entity | null, home: Vector3, shown: boolean) {
    if (!model) return
    const transform = Transform.getMutable(model)
    transform.position.x = home.x
    transform.position.z = home.z
    transform.position.y = shown ? home.y : FalconController.MODEL_HIDDEN_Y
  }

  private playAnim(clip: string) {
    if (!this.flightEntity || this.currentAnim === clip) return
    this.currentAnim = clip
    Animator.playSingleAnimation(this.flightEntity, clip)
  }

  private forwardVector(): Vector3 {
    return Vector3.rotate(
      Vector3.Forward(),
      Quaternion.fromEulerDegrees((this.pitch * 180) / Math.PI, (this.yaw * 180) / Math.PI, 0)
    )
  }

  private moveToward(current: number, target: number, maxDelta: number): number {
    if (Math.abs(target - current) <= maxDelta) return target
    return current + Math.sign(target - current) * maxDelta
  }

  private keepInsideScene() {
    const pos = this.body.position
    const margin = 2
    // scene is 240m x 240m (15x15 parcels); keep a soft clamp so the falcon
    // never flies outside the scene bounds where entities stop rendering
    pos.x = Math.max(margin, Math.min(240 - margin, pos.x))
    pos.z = Math.max(margin, Math.min(240 - margin, pos.z))
    if (pos.y > FalconController.CEILING_Y) {
      pos.y = FalconController.CEILING_Y
      this.body.velocity.y = Math.min(this.body.velocity.y, 0)
    }
  }
}
