import { ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import { MutableRefObject, useCallback, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  BIN,
  BUILD_LIMIT,
  DOMINO,
  DominoSnapshot,
  FLOOR_SIZE,
  PLAYER_COLORS,
  PlayerSnapshot,
  RoomSnapshot,
  Vec2,
  clamp,
  isInsideBin,
  normalizeYaw
} from '../../shared/protocol';
import { ClientControl } from '../App';

type WorldSceneProps = {
  control: ClientControl;
  controlRef: MutableRefObject<ClientControl>;
  playerId: string | null;
  snapshot: RoomSnapshot | null;
  setControl: (updater: ClientControl | ((previous: ClientControl) => ClientControl)) => void;
  sendInput: (partial: { grab?: boolean; release?: boolean }, force?: boolean) => void;
  activeKeysRef: MutableRefObject<Set<string>>;
};

type MotionSample = {
  point: Vec2 | null;
  time: number;
  speed: number;
  jitter: number;
};

const FLOOR_HALF = FLOOR_SIZE / 2;

export function WorldScene({
  control,
  controlRef,
  playerId,
  snapshot,
  setControl,
  sendInput,
  activeKeysRef
}: WorldSceneProps) {
  const motionRef = useRef<MotionSample>({
    point: null,
    time: performance.now(),
    speed: 0,
    jitter: 0
  });
  const grid = useMemo(() => {
    const helper = new THREE.GridHelper(FLOOR_SIZE, FLOOR_SIZE, '#546065', '#9aa0a4');
    helper.position.y = 0.004;
    return helper;
  }, []);

  const pointerToControl = useCallback(
    (point: THREE.Vector3) => {
      const now = performance.now();
      const nextPoint = {
        x: clamp(point.x, -FLOOR_HALF + 0.08, FLOOR_HALF - 0.08),
        z: clamp(point.z, -FLOOR_HALF + 0.08, FLOOR_HALF - 0.08)
      };
      const previous = motionRef.current;
      const dt = Math.max((now - previous.time) / 1000, 1 / 120);
      const distance = previous.point
        ? Math.hypot(nextPoint.x - previous.point.x, nextPoint.z - previous.point.z)
        : 0;
      const speed = distance / dt;
      const acceleration = Math.abs(speed - previous.speed) / dt;
      const rawJitter = clamp(speed / 8 + acceleration / 95, 0, 1);
      const jitter = previous.jitter * 0.78 + rawJitter * 0.22;

      motionRef.current = {
        point: nextPoint,
        time: now,
        speed,
        jitter
      };

      setControl((current) => ({
        ...current,
        pointer: nextPoint,
        jitter
      }));

      return nextPoint;
    },
    [setControl]
  );

  const handlePointerMove = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      pointerToControl(event.point);
    },
    [pointerToControl]
  );

  const handleGrab = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      event.stopPropagation();
      const nextPoint = pointerToControl(event.point);
      const nextControl = {
        ...controlRef.current,
        pointer: nextPoint,
        dragging: true,
        jitter: 0
      };

      motionRef.current = {
        point: nextPoint,
        time: performance.now(),
        speed: 0,
        jitter: 0
      };
      controlRef.current = nextControl;
      setControl(nextControl);
      sendInput({ grab: true }, true);
    },
    [controlRef, pointerToControl, sendInput, setControl]
  );

  useEffect(() => {
    const release = () => {
      const current = controlRef.current;
      if (!current.dragging) return;

      const next = {
        ...current,
        dragging: false
      };
      controlRef.current = next;
      setControl(next);
      sendInput({ release: true }, true);
    };

    window.addEventListener('pointerup', release);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('blur', release);
    };
  }, [controlRef, sendInput, setControl]);

  useFrame(() => {
    sendInput({}, false);
  });

  const playersById = useMemo(() => {
    const result = new Map<string, PlayerSnapshot>();
    for (const player of snapshot?.players ?? []) {
      result.set(player.id, player);
    }
    return result;
  }, [snapshot?.players]);

  return (
    <>
      <CameraRig activeKeysRef={activeKeysRef} />
      <color attach="background" args={['#eef0e7']} />
      <fog attach="fog" args={['#eef0e7', 14, 34]} />
      <ambientLight intensity={0.72} />
      <directionalLight
        castShadow
        intensity={1.8}
        position={[4, 9, 6]}
        shadow-camera-bottom={-12}
        shadow-camera-left={-12}
        shadow-camera-right={12}
        shadow-camera-top={12}
        shadow-mapSize={[2048, 2048]}
      />

      <group rotation={[0, -0.04, 0]}>
        <mesh
          receiveShadow
          rotation={[-Math.PI / 2, 0, 0]}
          onPointerMove={handlePointerMove}
          onPointerDown={handlePointerMove}
        >
          <planeGeometry args={[FLOOR_SIZE, FLOOR_SIZE]} />
          <meshStandardMaterial color="#bfc3b6" roughness={0.92} metalness={0.02} />
        </mesh>
        <primitive object={grid} />
        <BuildBoundary />
        <DominoBin onGrab={handleGrab} />
        <PointerMarker control={control} players={snapshot?.players ?? []} playerId={playerId} />

        {(snapshot?.dominoes ?? []).map((domino) => (
          <DominoMesh
            key={domino.id}
            domino={domino}
            ownerColor={playersById.get(domino.ownerId)?.color ?? PLAYER_COLORS[0]}
          />
        ))}
      </group>
    </>
  );
}

function CameraRig({ activeKeysRef }: { activeKeysRef: MutableRefObject<Set<string>> }) {
  const { camera, gl, size } = useThree();
  const controlsRef = useRef<OrbitControls | null>(null);

  useEffect(() => {
    const compact = size.width < 680;
    camera.position.set(
      compact ? 9.8 : 7.4,
      compact ? 9.8 : 7.6,
      compact ? 11.8 : 8.2
    );

    const controls = new OrbitControls(camera, gl.domElement);
    controls.target.set(0, 0.4, 0);

    // 좌클릭은 게임 인터랙션용으로 유지, 우클릭으로 시점 회전
    controls.mouseButtons = {
      LEFT: -1 as unknown as THREE.MOUSE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE
    };

    // 모바일: 한 손가락 → 게임 인터랙션, 두 손가락 → 카메라 회전, 핀치 → 줌
    controls.touches = {
      ONE: -1 as unknown as THREE.TOUCH,
      TWO: THREE.TOUCH.DOLLY_ROTATE
    };

    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.minDistance = 3;
    controls.maxDistance = 24;
    controls.maxPolarAngle = Math.PI / 2.05; // 바닥 아래로 못 내려가도록
    controls.screenSpacePanning = false;
    controls.update();

    controlsRef.current = controls;
    return () => {
      controls.dispose();
      controlsRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, gl.domElement]);

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.update();

    // WASD / 가상 방향키 카메라 패닝
    const keys = activeKeysRef.current;
    if (keys.size === 0) return;

    const panSpeed = 6 * delta;

    // 카메라 수평 전진 방향 (XZ 평면 투영)
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    const fLen = forward.length();
    if (fLen < 0.001) return;
    forward.divideScalar(fLen);

    const right = new THREE.Vector3()
      .crossVectors(forward, new THREE.Vector3(0, 1, 0))
      .normalize();

    const move = new THREE.Vector3();
    if (keys.has('w')) move.addScaledVector(forward, panSpeed);
    if (keys.has('s')) move.addScaledVector(forward, -panSpeed);
    if (keys.has('a')) move.addScaledVector(right, -panSpeed);
    if (keys.has('d')) move.addScaledVector(right, panSpeed);
    if (move.lengthSq() === 0) return;

    // 바닥 경계 클램핑
    const maxPan = FLOOR_HALF - 0.5;
    const nextX = clamp(controls.target.x + move.x, -maxPan, maxPan);
    const nextZ = clamp(controls.target.z + move.z, -maxPan, maxPan);
    move.x = nextX - controls.target.x;
    move.z = nextZ - controls.target.z;

    controls.target.add(move);
    camera.position.add(move);
  });

  return null;
}

function DominoMesh({ domino, ownerColor }: { domino: DominoSnapshot; ownerColor: string }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const stripeRef = useRef<THREE.Mesh>(null);
  const targetPosition = useMemo(
    () => new THREE.Vector3(domino.position.x, domino.position.y, domino.position.z),
    [domino.position.x, domino.position.y, domino.position.z]
  );
  const targetQuaternion = useMemo(
    () => new THREE.Quaternion(domino.rotation.x, domino.rotation.y, domino.rotation.z, domino.rotation.w),
    [domino.rotation.x, domino.rotation.y, domino.rotation.z, domino.rotation.w]
  );

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const alpha = 1 - Math.exp(-delta * (domino.state === 'held' ? 26 : 16));
    mesh.position.lerp(targetPosition, alpha);
    mesh.quaternion.slerp(targetQuaternion, alpha);
  });

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.position.copy(targetPosition);
    mesh.quaternion.copy(targetQuaternion);
  }, [domino.id, targetPosition, targetQuaternion]);

  return (
    <mesh ref={meshRef} castShadow receiveShadow>
      <boxGeometry args={[DOMINO.width, DOMINO.height, DOMINO.depth]} />
      <meshStandardMaterial
        color={domino.state === 'held' ? '#fff8df' : '#f8f3e7'}
        opacity={domino.state === 'held' ? 0.74 : 1}
        roughness={0.7}
        transparent={domino.state === 'held'}
      />
      <mesh ref={stripeRef} position={[0, DOMINO.height * 0.19, DOMINO.depth / 2 + 0.006]}>
        <boxGeometry args={[DOMINO.width * 0.72, DOMINO.height * 0.07, 0.012]} />
        <meshStandardMaterial color={ownerColor} roughness={0.6} />
      </mesh>
      <mesh position={[0, -DOMINO.height * 0.19, DOMINO.depth / 2 + 0.006]}>
        <boxGeometry args={[DOMINO.width * 0.72, DOMINO.height * 0.07, 0.012]} />
        <meshStandardMaterial color={ownerColor} roughness={0.6} />
      </mesh>
    </mesh>
  );
}

function DominoBin({ onGrab }: { onGrab: (event: ThreeEvent<PointerEvent>) => void }) {
  const wallMaterial = <meshStandardMaterial color="#38454f" roughness={0.8} />;
  return (
    <group position={[BIN.center.x, 0, BIN.center.z]}>
      <mesh receiveShadow position={[0, 0.016, 0]} onPointerDown={onGrab}>
        <boxGeometry args={[BIN.size.x, 0.032, BIN.size.z]} />
        <meshStandardMaterial color="#d8d0ba" roughness={0.86} />
      </mesh>
      <mesh castShadow receiveShadow position={[0, 0.23, -BIN.size.z / 2]}>
        <boxGeometry args={[BIN.size.x, 0.46, 0.12]} />
        {wallMaterial}
      </mesh>
      <mesh castShadow receiveShadow position={[0, 0.23, BIN.size.z / 2]}>
        <boxGeometry args={[BIN.size.x, 0.46, 0.12]} />
        {wallMaterial}
      </mesh>
      <mesh castShadow receiveShadow position={[-BIN.size.x / 2, 0.23, 0]}>
        <boxGeometry args={[0.12, 0.46, BIN.size.z]} />
        {wallMaterial}
      </mesh>
      <mesh castShadow receiveShadow position={[BIN.size.x / 2, 0.23, 0]}>
        <boxGeometry args={[0.12, 0.46, BIN.size.z]} />
        {wallMaterial}
      </mesh>
      {Array.from({ length: 8 }).map((_, index) => {
        const x = -0.82 + index * 0.24;
        const yaw = index % 2 === 0 ? 0.12 : -0.1;
        return (
          <mesh key={index} castShadow receiveShadow position={[x, DOMINO.height / 2 + 0.04, 0]} rotation={[0, yaw, 0]}>
            <boxGeometry args={[DOMINO.width, DOMINO.height, DOMINO.depth]} />
            <meshStandardMaterial color={index % 3 === 0 ? '#f4efe2' : '#e7dfca'} roughness={0.72} />
          </mesh>
        );
      })}
    </group>
  );
}

function BuildBoundary() {
  const thickness = 0.035;
  const height = 0.035;
  const length = BUILD_LIMIT * 2;
  return (
    <group position={[0, height / 2, 0]}>
      <mesh position={[0, 0, -BUILD_LIMIT]}>
        <boxGeometry args={[length, height, thickness]} />
        <meshStandardMaterial color="#346d6a" roughness={0.5} />
      </mesh>
      <mesh position={[0, 0, BUILD_LIMIT]}>
        <boxGeometry args={[length, height, thickness]} />
        <meshStandardMaterial color="#346d6a" roughness={0.5} />
      </mesh>
      <mesh position={[-BUILD_LIMIT, 0, 0]}>
        <boxGeometry args={[thickness, height, length]} />
        <meshStandardMaterial color="#346d6a" roughness={0.5} />
      </mesh>
      <mesh position={[BUILD_LIMIT, 0, 0]}>
        <boxGeometry args={[thickness, height, length]} />
        <meshStandardMaterial color="#346d6a" roughness={0.5} />
      </mesh>
    </group>
  );
}

function PointerMarker({
  control,
  playerId,
  players
}: {
  control: ClientControl;
  playerId: string | null;
  players: PlayerSnapshot[];
}) {
  const remotePlayers = players.filter((player) => player.id !== playerId && player.pointer);
  return (
    <>
      {control.pointer ? (
        <mesh position={[control.pointer.x, 0.018, control.pointer.z]} rotation={[-Math.PI / 2, 0, normalizeYaw(control.yaw)]}>
          <ringGeometry args={[0.24, 0.28, 40]} />
          <meshBasicMaterial color={isInsideBin(control.pointer) ? '#e85d75' : '#1d6f73'} transparent opacity={0.9} />
        </mesh>
      ) : null}
      {remotePlayers.map((player) => {
        const pointer = player.pointer;
        if (!pointer) return null;
        return (
          <mesh key={player.id} position={[pointer.x, 0.025, pointer.z]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[0.12 + player.jitter * 0.18, 24]} />
            <meshBasicMaterial color={player.color} transparent opacity={0.64} />
          </mesh>
        );
      })}
    </>
  );
}
