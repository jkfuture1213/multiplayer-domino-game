export type Vec2 = {
  x: number;
  z: number;
};

export type Vec3 = {
  x: number;
  y: number;
  z: number;
};

export type Quat = {
  x: number;
  y: number;
  z: number;
  w: number;
};

export type DominoState = 'held' | 'placed';

export type DominoSnapshot = {
  id: string;
  ownerId: string;
  state: DominoState;
  position: Vec3;
  rotation: Quat;
  wobble: number;
  placedAt: number; // 배치된 서버 타임스탬프 (ms)
};

export type PlayerSnapshot = {
  id: string;
  color: string;
  nickname: string;
  dragging: boolean;
  pointer: Vec2 | null;
  jitter: number;
};

export type ResetSnapshot = {
  reason: string;
  at: number;
};

export type RoomSnapshot = {
  round: number;
  serverTime: number;
  dominoes: DominoSnapshot[];
  players: PlayerSnapshot[];
  reset: ResetSnapshot | null;
  toppling: boolean; // 연쇄 쓰러짐 애니메이션 진행 중
};

export type ClientInput = {
  pointer: Vec2 | null;
  yaw: number;
  dragging: boolean;
  jitter: number;
  grab?: boolean;
  release?: boolean;
  topple?: boolean; // 마지막 배치 도미노 쓰러뜨리기
  seq: number;
  sentAt: number;
};

export const TICK_RATE = 60;
export const SNAPSHOT_RATE = 20;
export const SERVER_PORT = 2567;
export const FLOOR_SIZE = 18;
export const BUILD_LIMIT = 7.2;
export const RESET_DELAY_MS = 1200;
export const TOPPLE_ANGLE_RAD = 0.62;

export const DOMINO = {
  width: 0.3,
  height: 1.32,
  depth: 0.72,
  density: 0.42
} as const;

export const BIN = {
  center: { x: -7.1, z: 5.9 },
  size: { x: 2.5, z: 2.4 }
} as const;

export const PLAYER_COLORS = [
  '#e85d75',
  '#3caea3',
  '#f6c85f',
  '#5b8def',
  '#f28e2b',
  '#8e6ad8',
  '#59a14f',
  '#edc949'
] as const;

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeYaw(yaw: number) {
  const fullTurn = Math.PI * 2;
  return ((yaw % fullTurn) + fullTurn) % fullTurn;
}

export function isInsideBin(point: Vec2) {
  return (
    Math.abs(point.x - BIN.center.x) <= BIN.size.x / 2 &&
    Math.abs(point.z - BIN.center.z) <= BIN.size.z / 2
  );
}

export function isInsideBuildArea(point: Vec2) {
  return Math.abs(point.x) <= BUILD_LIMIT && Math.abs(point.z) <= BUILD_LIMIT;
}

export function clampToFloor(point: Vec2): Vec2 {
  const half = FLOOR_SIZE / 2 - 0.15;
  return {
    x: clamp(point.x, -half, half),
    z: clamp(point.z, -half, half)
  };
}
