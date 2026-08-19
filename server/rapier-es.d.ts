declare module '@dimforge/rapier3d-compat/rapier.es.js' {
  export type Vector3 = {
    x: number;
    y: number;
    z: number;
  };

  export type Quaternion = {
    x: number;
    y: number;
    z: number;
    w: number;
  };

  export type RigidBody = {
    translation(): Vector3;
    rotation(): Quaternion;
    setNextKinematicTranslation(translation: Vector3): void;
    setNextKinematicRotation(rotation: Quaternion): void;
    setAngvel(velocity: Vector3, wakeUp: boolean): void;
    applyImpulse(impulse: Vector3, wakeUp: boolean): void;
    applyTorqueImpulse(torque: Vector3, wakeUp: boolean): void;
    applyImpulseAtPoint(impulse: Vector3, point: Vector3, wakeUp: boolean): void;
    linvel(): Vector3;
    angvel(): Vector3;
  };

  type RigidBodyDescBuilder = {
    setTranslation(x: number, y: number, z: number): RigidBodyDescBuilder;
    setRotation(rotation: Quaternion): RigidBodyDescBuilder;
    setCanSleep(canSleep: boolean): RigidBodyDescBuilder;
    setCcdEnabled(enabled: boolean): RigidBodyDescBuilder;
  };

  type ColliderDescBuilder = {
    setTranslation(x: number, y: number, z: number): ColliderDescBuilder;
    setDensity(density: number): ColliderDescBuilder;
    setFriction(friction: number): ColliderDescBuilder;
    setRestitution(restitution: number): ColliderDescBuilder;
  };

  export class World {
    constructor(gravity: Vector3);
    timestep: number;
    createRigidBody(description: RigidBodyDescBuilder): RigidBody;
    createCollider(description: ColliderDescBuilder, body: RigidBody): unknown;
    removeRigidBody(body: RigidBody): void;
    step(): void;
  }

  export const RigidBodyDesc: {
    fixed(): RigidBodyDescBuilder;
    dynamic(): RigidBodyDescBuilder;
    kinematicPositionBased(): RigidBodyDescBuilder;
  };

  export const ColliderDesc: {
    cuboid(x: number, y: number, z: number): ColliderDescBuilder;
  };

  export function init(options?: unknown): Promise<void>;
}
