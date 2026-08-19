import {
  ColliderDesc,
  RigidBodyDesc,
  World,
  init,
  type RigidBody
} from '@dimforge/rapier3d-compat/rapier.es.js';
import { Server, Socket } from 'socket.io';
import {
  BIN,
  BUILD_LIMIT,
  ClientInput,
  DOMINO,
  DominoSnapshot,
  FLOOR_SIZE,
  PLAYER_COLORS,
  PlayerSnapshot,
  Quat,
  RESET_DELAY_MS,
  RoomSnapshot,
  SNAPSHOT_RATE,
  TICK_RATE,
  TOPPLE_ANGLE_RAD,
  Vec2,
  Vec3,
  clamp,
  clampToFloor,
  isInsideBin,
  isInsideBuildArea,
  normalizeYaw
} from '../../shared/protocol.js';

type PlayerState = {
  id: string;
  color: string;
  nickname: string;
  input: ClientInput;
  heldDominoId: string | null;
  lastTarget: { point: Vec2; yaw: number; time: number; speed: number } | null;
  serverJitter: number;
};

type DominoBody = {
  id: string;
  ownerId: string;
  state: 'held' | 'placed';
  body: RigidBody;
  createdAt: number;
  placedAt: number; // state가 'placed'로 전환된 시각 (held 중엔 0)
  wobble: number;
};

type ResetState = {
  reason: string;
  at: number;
};

const DEFAULT_INPUT: ClientInput = {
  pointer: null,
  yaw: 0,
  dragging: false,
  jitter: 0,
  seq: 0,
  sentAt: 0
};

export class AuthoritativeDominoRoom {
  private readonly world: World;
  private readonly players = new Map<string, PlayerState>();
  private readonly dominoes = new Map<string, DominoBody>();
  private round = 1;
  private elapsed = 0;
  private reset: ResetState | null = null;
  private nextDominoNumber = 1;
  private toppling = false;
  private topplingStartedAt = 0;

  private constructor(private readonly io: Server) {
    this.world = new World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / TICK_RATE;
    this.createStaticWorld();
  }

  static async create(io: Server) {
    await init();
    const room = new AuthoritativeDominoRoom(io);

    setInterval(() => room.step(), 1000 / TICK_RATE);
    setInterval(() => room.broadcastSnapshot(), 1000 / SNAPSHOT_RATE);

    return room;
  }

  addPlayer(socket: Socket) {
    const color = PLAYER_COLORS[this.players.size % PLAYER_COLORS.length];
    const rawNickname = (socket.handshake.auth as Record<string, unknown>)?.nickname;
    const nickname = typeof rawNickname === 'string' && rawNickname.trim()
      ? rawNickname.trim().slice(0, 20)
      : 'Player';

    const player: PlayerState = {
      id: socket.id,
      color,
      nickname,
      input: { ...DEFAULT_INPUT },
      heldDominoId: null,
      lastTarget: null,
      serverJitter: 0
    };

    this.players.set(socket.id, player);
    socket.emit('snapshot', this.snapshot());

    socket.on('input', (input: ClientInput) => {
      this.handleInput(socket.id, input);
    });

    socket.on('disconnect', () => {
      this.removePlayer(socket.id);
    });
  }

  private handleInput(playerId: string, rawInput: ClientInput) {
    const player = this.players.get(playerId);
    if (!player) return;

    const input = this.sanitizeInput(rawInput);
    player.input = input;

    if (this.reset) return;

    if (input.grab && input.pointer && isInsideBin(input.pointer) && !player.heldDominoId) {
      this.createHeldDomino(player, input.pointer);
    }

    if (player.heldDominoId && input.pointer) {
      this.updateHeldDomino(player, input.pointer, Date.now());
    }

    if (input.release && player.heldDominoId) {
      this.placeHeldDomino(player);
    }

    if (input.topple) {
      this.toppleLastDomino();
    }
  }

  private step() {
    this.elapsed += 1 / TICK_RATE;

    for (const player of this.players.values()) {
      if (!this.reset && player.heldDominoId && player.input.dragging && player.input.pointer) {
        this.updateHeldDomino(player, player.input.pointer, Date.now());
      }
    }

    this.world.step();
    this.checkForTopple();
    this.checkTopplingSettled();
    this.checkResetDeadline();
  }

  private broadcastSnapshot() {
    this.io.emit('snapshot', this.snapshot());
  }

  private snapshot(): RoomSnapshot {
    const dominoes: DominoSnapshot[] = Array.from(this.dominoes.values()).map((domino) => {
      const translation = domino.body.translation();
      const rotation = domino.body.rotation();
      return {
        id: domino.id,
        ownerId: domino.ownerId,
        state: domino.state,
        position: vec3(translation),
        rotation: quat(rotation),
        wobble: round3(domino.wobble),
        placedAt: domino.placedAt
      };
    });

    const players: PlayerSnapshot[] = Array.from(this.players.values()).map((player) => ({
      id: player.id,
      color: player.color,
      nickname: player.nickname,
      dragging: Boolean(player.heldDominoId),
      pointer: player.input.pointer,
      jitter: round3(player.serverJitter)
    }));

    return {
      round: this.round,
      serverTime: Date.now(),
      dominoes,
      players,
      reset: this.reset,
      toppling: this.toppling
    };
  }

  private createStaticWorld() {
    const floorBody = this.world.createRigidBody(RigidBodyDesc.fixed());
    const floorCollider = ColliderDesc.cuboid(FLOOR_SIZE / 2, 0.1, FLOOR_SIZE / 2)
      .setTranslation(0, -0.1, 0)
      .setFriction(1.25)
      .setRestitution(0.02);
    this.world.createCollider(floorCollider, floorBody);

    const edgeThickness = 0.12;
    const edgeHeight = 0.45;
    const half = FLOOR_SIZE / 2;
    const edges = [
      { x: 0, z: -half, sx: half, sz: edgeThickness },
      { x: 0, z: half, sx: half, sz: edgeThickness },
      { x: -half, z: 0, sx: edgeThickness, sz: half },
      { x: half, z: 0, sx: edgeThickness, sz: half }
    ];

    for (const edge of edges) {
      const body = this.world.createRigidBody(
        RigidBodyDesc.fixed().setTranslation(edge.x, edgeHeight / 2, edge.z)
      );
      this.world.createCollider(ColliderDesc.cuboid(edge.sx, edgeHeight / 2, edge.sz), body);
    }

    const binBody = this.world.createRigidBody(RigidBodyDesc.fixed());
    const binWall = 0.12;
    const binHeight = 0.42;
    const walls = [
      { x: BIN.center.x, z: BIN.center.z - BIN.size.z / 2, sx: BIN.size.x / 2, sz: binWall },
      { x: BIN.center.x, z: BIN.center.z + BIN.size.z / 2, sx: BIN.size.x / 2, sz: binWall },
      { x: BIN.center.x - BIN.size.x / 2, z: BIN.center.z, sx: binWall, sz: BIN.size.z / 2 },
      { x: BIN.center.x + BIN.size.x / 2, z: BIN.center.z, sx: binWall, sz: BIN.size.z / 2 }
    ];

    for (const wall of walls) {
      this.world.createCollider(
        ColliderDesc.cuboid(wall.sx, binHeight / 2, wall.sz)
          .setTranslation(wall.x, binHeight / 2, wall.z)
          .setFriction(1.4),
        binBody
      );
    }
  }

  private createHeldDomino(player: PlayerState, pointer: Vec2) {
    const point = clampToFloor(pointer);
    const id = `r${this.round}-d${this.nextDominoNumber++}`;
    const body = this.world.createRigidBody(
      RigidBodyDesc.kinematicPositionBased()
        .setTranslation(point.x, DOMINO.height / 2, point.z)
        .setRotation(axisAngle({ x: 0, y: 1, z: 0 }, player.input.yaw))
    );

    this.world.createCollider(this.dominoColliderDesc(), body);
    this.dominoes.set(id, {
      id,
      ownerId: player.id,
      state: 'held',
      body,
      createdAt: Date.now(),
      placedAt: 0,
      wobble: 0
    });

    player.heldDominoId = id;
    player.lastTarget = {
      point,
      yaw: player.input.yaw,
      time: Date.now(),
      speed: 0
    };
    player.serverJitter = 0;
  }

  private updateHeldDomino(player: PlayerState, pointer: Vec2, now: number) {
    const domino = player.heldDominoId ? this.dominoes.get(player.heldDominoId) : null;
    if (!domino || domino.state !== 'held') return;

    const point = clampToFloor(pointer);
    const yaw = normalizeYaw(player.input.yaw);
    const last = player.lastTarget;
    const dt = last ? Math.max((now - last.time) / 1000, 1 / 120) : 1 / TICK_RATE;
    const distance = last ? Math.hypot(point.x - last.point.x, point.z - last.point.z) : 0;
    const speed = distance / dt;
    const yawRate = last ? Math.abs(shortestAngle(yaw - last.yaw)) / dt : 0;
    const acceleration = last ? Math.abs(speed - last.speed) / dt : 0;
    const serverShake = clamp(speed / 7 + yawRate / 9 + acceleration / 90, 0, 1);
    const clientShake = clamp(player.input.jitter, 0, 1);
    const targetShake = Math.max(serverShake, clientShake);

    player.serverJitter = lerp(player.serverJitter, targetShake, 0.28);
    domino.wobble = player.serverJitter;

    const wobblePhase = this.elapsed * 13 + hashUnit(player.id) * Math.PI * 2;
    const wobbleAngle = Math.sin(wobblePhase) * player.serverJitter * 0.28;
    const tiltAxis = normalizeVec3({
      x: Math.cos(yaw + Math.PI / 2),
      y: 0,
      z: Math.sin(yaw + Math.PI / 2)
    });
    const rotation = multiplyQuat(
      axisAngle({ x: 0, y: 1, z: 0 }, yaw),
      axisAngle(tiltAxis, wobbleAngle)
    );

    domino.body.setNextKinematicTranslation({
      x: point.x,
      y: DOMINO.height / 2,
      z: point.z
    });
    domino.body.setNextKinematicRotation(rotation);

    player.lastTarget = {
      point,
      yaw,
      time: now,
      speed
    };
  }

  private placeHeldDomino(player: PlayerState) {
    const domino = player.heldDominoId ? this.dominoes.get(player.heldDominoId) : null;
    if (!domino) return;

    const translation = domino.body.translation();
    const rotation = domino.body.rotation();
    const point = { x: translation.x, z: translation.z };

    this.world.removeRigidBody(domino.body);
    this.dominoes.delete(domino.id);
    player.heldDominoId = null;

    if (!isInsideBuildArea(point)) {
      player.serverJitter = 0;
      player.lastTarget = null;
      return;
    }

    const body = this.world.createRigidBody(
      RigidBodyDesc.dynamic()
        .setTranslation(translation.x, translation.y, translation.z)
        .setRotation(rotation)
        .setCanSleep(true)
        .setCcdEnabled(true)
    );
    this.world.createCollider(this.dominoColliderDesc(), body);

    if (domino.wobble > 0.22) {
      const wobble = domino.wobble;
      body.setAngvel(
        {
          x: Math.sin(this.elapsed * 5.3) * wobble * 2.8,
          y: Math.sin(this.elapsed * 2.1) * wobble * 0.4,
          z: Math.cos(this.elapsed * 4.7) * wobble * 2.8
        },
        true
      );
    }

    this.dominoes.set(domino.id, {
      ...domino,
      state: 'placed',
      body,
      createdAt: Date.now(),
      placedAt: Date.now()
    });

    player.serverJitter = 0;
    player.lastTarget = null;
  }

  private checkForTopple() {
    // toppling 중엔 연쇄 반응을 방해하지 않도록 즉시 리셋 안 함
    if (this.reset || this.toppling) return;

    const now = Date.now();
    for (const domino of this.dominoes.values()) {
      if (domino.state !== 'placed') continue;
      if (now - domino.createdAt < 450) continue;

      const rotation = domino.body.rotation();
      const translation = domino.body.translation();
      const angle = uprightAngle(rotation);
      const tooLow = translation.y < DOMINO.height * 0.42;

      if (angle > TOPPLE_ANGLE_RAD || tooLow) {
        this.reset = {
          reason: `Domino ${domino.id} fell`,
          at: now + RESET_DELAY_MS
        };
        return;
      }
    }
  }

  private checkResetDeadline() {
    if (!this.reset || Date.now() < this.reset.at) return;

    for (const domino of this.dominoes.values()) {
      this.world.removeRigidBody(domino.body);
    }

    this.dominoes.clear();
    for (const player of this.players.values()) {
      player.heldDominoId = null;
      player.input = { ...DEFAULT_INPUT };
      player.lastTarget = null;
      player.serverJitter = 0;
    }

    this.round += 1;
    this.nextDominoNumber = 1;
    this.reset = null;
    this.toppling = false;
    this.topplingStartedAt = 0;
  }

  private removePlayer(playerId: string) {
    const player = this.players.get(playerId);
    if (!player) return;

    if (player.heldDominoId) {
      const domino = this.dominoes.get(player.heldDominoId);
      if (domino) {
        this.world.removeRigidBody(domino.body);
        this.dominoes.delete(domino.id);
      }
    }

    this.players.delete(playerId);
  }

  private sanitizeInput(input: ClientInput): ClientInput {
    const pointer =
      input.pointer &&
        Number.isFinite(input.pointer.x) &&
        Number.isFinite(input.pointer.z)
        ? clampToFloor(input.pointer)
        : null;

    return {
      pointer,
      yaw: Number.isFinite(input.yaw) ? normalizeYaw(input.yaw) : 0,
      dragging: Boolean(input.dragging),
      jitter: clamp(Number.isFinite(input.jitter) ? input.jitter : 0, 0, 1),
      grab: Boolean(input.grab),
      release: Boolean(input.release),
      topple: Boolean(input.topple),
      seq: Number.isFinite(input.seq) ? input.seq : 0,
      sentAt: Number.isFinite(input.sentAt) ? input.sentAt : 0
    };
  }

  private toppleLastDomino() {
    if (this.reset || this.toppling) return;

    // placedAt이 가장 큰(가장 최근에 세운) 도미노를 찾는다
    let lastDomino: DominoBody | null = null;
    for (const domino of this.dominoes.values()) {
      if (domino.state !== 'placed') continue;
      if (!lastDomino || domino.placedAt > lastDomino.placedAt) {
        lastDomino = domino;
      }
    }

    if (!lastDomino) return;

    // 다른 도미노들의 무게중심 방향으로 밀기
    const lastPos = lastDomino.body.translation();
    let cx = 0, cz = 0, count = 0;
    for (const domino of this.dominoes.values()) {
      if (domino.state !== 'placed' || domino.id === lastDomino.id) continue;
      const pos = domino.body.translation();
      cx += pos.x;
      cz += pos.z;
      count++;
    }

    let dx: number, dz: number;
    if (count > 0) {
      cx /= count;
      cz /= count;
      const rawDx = cx - lastPos.x;
      const rawDz = cz - lastPos.z;
      const len = Math.hypot(rawDx, rawDz) || 1;
      dx = rawDx / len;
      dz = rawDz / len;
    } else {
      // 다른 도미노 없음 — 도미노의 앞수 방향으로 밀기
      const rotation = lastDomino.body.rotation();
      const yaw = Math.atan2(
        2 * (rotation.w * rotation.y + rotation.x * rotation.z),
        1 - 2 * (rotation.y * rotation.y + rotation.z * rotation.z)
      );
      dx = Math.sin(yaw);
      dz = Math.cos(yaw);
    }

    // 도미노 꼭대기(상단 90% 지점)에 아주 작은 수평 힘을 가해
    // 바닥 모서리를 지점으로 손으로 살살 미는 것처럼 천천히 넘어지도록
    const pushForce = 0.12;
    lastDomino.body.applyImpulseAtPoint(
      { x: dx * pushForce, y: 0, z: dz * pushForce },
      { x: lastPos.x, y: lastPos.y + DOMINO.height * 0.45, z: lastPos.z },
      true
    );

    this.toppling = true;
    this.topplingStartedAt = Date.now();
  }

  private checkTopplingSettled() {
    if (!this.toppling || this.reset) return;

    const now = Date.now();
    const elapsed = now - this.topplingStartedAt;

    // 연쇄 반응이 펼지도록 최소 2.5초 대기
    if (elapsed < 2500) return;

    // 모든 배치 도미노의 속도가 충분히 작으면 정착으로 판단
    const placedDominoes = [...this.dominoes.values()].filter(d => d.state === 'placed');
    const allSettled = placedDominoes.length === 0 || placedDominoes.every(d => {
      const linvel = d.body.linvel();
      const angvel = d.body.angvel();
      return (
        Math.hypot(linvel.x, linvel.y, linvel.z) < 0.08 &&
        Math.hypot(angvel.x, angvel.y, angvel.z) < 0.08
      );
    });

    // 정착했거나 10초 초과 시 리셋 카운트다운 시작
    if (allSettled || elapsed > 10000) {
      this.toppling = false;
      this.reset = {
        reason: 'Chain topple complete',
        at: now + RESET_DELAY_MS
      };
    }
  }

  private dominoColliderDesc() {
    return ColliderDesc.cuboid(DOMINO.width / 2, DOMINO.height / 2, DOMINO.depth / 2)
      .setDensity(DOMINO.density)
      .setFriction(1.35)
      .setRestitution(0.01);
  }
}

function vec3(value: Vec3): Vec3 {
  return {
    x: round3(value.x),
    y: round3(value.y),
    z: round3(value.z)
  };
}

function quat(value: Quat): Quat {
  return {
    x: round4(value.x),
    y: round4(value.y),
    z: round4(value.z),
    w: round4(value.w)
  };
}

function axisAngle(axis: Vec3, angle: number): Quat {
  const half = angle / 2;
  const sinHalf = Math.sin(half);
  return {
    x: axis.x * sinHalf,
    y: axis.y * sinHalf,
    z: axis.z * sinHalf,
    w: Math.cos(half)
  };
}

function multiplyQuat(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  };
}

function normalizeVec3(value: Vec3): Vec3 {
  const length = Math.hypot(value.x, value.y, value.z) || 1;
  return {
    x: value.x / length,
    y: value.y / length,
    z: value.z / length
  };
}

function uprightAngle(rotation: Quat) {
  const upY = 1 - 2 * (rotation.x * rotation.x + rotation.z * rotation.z);
  return Math.acos(clamp(upY, -1, 1));
}

function shortestAngle(angle: number) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function lerp(from: number, to: number, alpha: number) {
  return from + (to - from) * alpha;
}

function hashUnit(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function round3(value: number) {
  return Math.round(value * 1000) / 1000;
}

function round4(value: number) {
  return Math.round(value * 10000) / 10000;
}
