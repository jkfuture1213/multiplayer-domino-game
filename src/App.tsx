import { Canvas } from '@react-three/fiber';
import { Hand, RotateCcw, RotateCw, Users, Wifi, WifiOff, Zap } from 'lucide-react';
import { MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import { ClientInput, RoomSnapshot, Vec2, normalizeYaw } from '../shared/protocol';
import { WorldScene } from './game/WorldScene';
import { useAuthoritativeRoom } from './game/useAuthoritativeRoom';

export type ClientControl = {
  pointer: Vec2 | null;
  yaw: number;
  dragging: boolean;
  jitter: number;
};

const INITIAL_CONTROL: ClientControl = {
  pointer: null,
  yaw: 0,
  dragging: false,
  jitter: 0
};

const isTouchDevice =
  typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

// WASD 키 목록
const WASD_KEYS = new Set(['w', 'a', 's', 'd']);

export default function App() {
  const [nickname, setNickname] = useState<string | null>(null);
  const { connected, playerId, snapshot, sendInput } = useAuthoritativeRoom(nickname);
  const [control, setControlState] = useState<ClientControl>(INITIAL_CONTROL);
  const controlRef = useRef<ClientControl>(INITIAL_CONTROL);

  // 활성 이동 키 (가상 D-pad + WASD 키보드 공유)
  const activeKeysRef = useRef<Set<string>>(new Set());
  const [activeKeys, setActiveKeys] = useState<Set<string>>(new Set());

  const pressKey = useCallback((key: string) => {
    if (activeKeysRef.current.has(key)) return;
    const next = new Set([...activeKeysRef.current, key]);
    activeKeysRef.current = next;
    setActiveKeys(new Set(next));
  }, []);

  const releaseKey = useCallback((key: string) => {
    const next = new Set(activeKeysRef.current);
    if (!next.delete(key)) return;
    activeKeysRef.current = next;
    setActiveKeys(new Set(next));
  }, []);

  // WASD 키보드 이벤트 (데스크탑)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (!WASD_KEYS.has(key) || e.repeat) return;
      // 입력창 포커스 중일 땐 무시
      if (document.activeElement?.tagName === 'INPUT') return;
      e.preventDefault();
      pressKey(key);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (!WASD_KEYS.has(key)) return;
      releaseKey(key);
    };
    const onBlur = () => {
      activeKeysRef.current = new Set();
      setActiveKeys(new Set());
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [pressKey, releaseKey]);

  const setControl = useCallback((updater: ClientControl | ((previous: ClientControl) => ClientControl)) => {
    setControlState((previous) => {
      const next = typeof updater === 'function' ? updater(previous) : updater;
      controlRef.current = next;
      return next;
    });
  }, []);

  const emitControl = useCallback(
    (partial: Partial<ClientInput>, force = false) => {
      const current = controlRef.current;
      sendInput(
        {
          pointer: current.pointer,
          yaw: normalizeYaw(current.yaw),
          dragging: current.dragging,
          jitter: current.jitter,
          ...partial
        },
        force
      );
    },
    [sendInput]
  );

  const rotate = useCallback(
    (direction: -1 | 1) => {
      setControl((previous) => ({
        ...previous,
        yaw: normalizeYaw(previous.yaw + direction * 0.18)
      }));
    },
    [setControl]
  );

  const topple = useCallback(() => {
    emitControl({ topple: true }, true);
  }, [emitControl]);

  useEffect(() => {
    const handleWheel = (event: WheelEvent) => {
      if (!controlRef.current.dragging) return;
      event.preventDefault();
      const direction = event.deltaY > 0 ? 1 : -1;
      rotate(direction);
    };

    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => window.removeEventListener('wheel', handleWheel);
  }, [rotate]);

  // 닉네임 미입력 시 입장 화면
  if (!nickname) {
    return <NicknameScreen onJoin={setNickname} />;
  }

  return (
    <main className="app-shell">
      <Canvas shadows camera={{ position: [7.4, 7.6, 8.2], fov: 50, near: 0.1, far: 80 }}>
        <WorldScene
          control={control}
          controlRef={controlRef}
          playerId={playerId}
          snapshot={snapshot}
          setControl={setControl}
          sendInput={emitControl}
          activeKeysRef={activeKeysRef}
        />
      </Canvas>

      <Hud
        connected={connected}
        control={control}
        playerId={playerId}
        rotate={rotate}
        snapshot={snapshot}
        topple={topple}
      />

      {/* 가상 D-pad */}
      <VirtualDPad
        activeKeys={activeKeys}
        onPress={pressKey}
        onRelease={releaseKey}
      />

      <div className="camera-hint" aria-label="Camera controls">
        {isTouchDevice ? (
          <><kbd>두 손가락</kbd> 시점 회전&nbsp;·&nbsp;<kbd>핀치</kbd> 줌</>
        ) : (
          <><kbd>우클릭</kbd> 시점 회전&nbsp;·&nbsp;<kbd>스크롤</kbd> 줌</>
        )}
      </div>
    </main>
  );
}

// ──────────────────────────────────────────────
// 가상 D-pad
// ──────────────────────────────────────────────
type DPadDirection = { key: string; label: string; symbol: string; col: number; row: number };

const DPAD_DIRS: DPadDirection[] = [
  { key: 'w', label: 'W', symbol: '▲', col: 2, row: 1 },
  { key: 'a', label: 'A', symbol: '◀', col: 1, row: 2 },
  { key: 's', label: 'S', symbol: '▼', col: 2, row: 3 },
  { key: 'd', label: 'D', symbol: '▶', col: 3, row: 2 },
];

function VirtualDPad({
  activeKeys,
  onPress,
  onRelease,
}: {
  activeKeys: Set<string>;
  onPress: (key: string) => void;
  onRelease: (key: string) => void;
}) {
  return (
    <div className="dpad" aria-label="카메라 이동 컨트롤">
      {DPAD_DIRS.map(({ key, label, symbol, col, row }) => (
        <button
          key={key}
          className={`dpad-btn${activeKeys.has(key) ? ' is-active' : ''}`}
          style={{ gridColumn: col, gridRow: row }}
          aria-label={`이동 ${label}`}
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            onPress(key);
          }}
          onPointerUp={() => onRelease(key)}
          onPointerCancel={() => onRelease(key)}
        >
          <span className="dpad-icon">{symbol}</span>
          <span className="dpad-key">{label}</span>
        </button>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────
// 닉네임 입력 화면
// ──────────────────────────────────────────────
function NicknameScreen({ onJoin }: { onJoin: (nickname: string) => void }) {
  const [value, setValue] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed) onJoin(trimmed);
  };

  return (
    <div className="nickname-screen">
      <div className="nickname-card">
        <div className="nickname-dominos" aria-hidden>
          <span className="nd" style={{ transform: 'rotate(-12deg) translateY(4px)' }} />
          <span className="nd" />
          <span className="nd" style={{ transform: 'rotate(12deg) translateY(4px)' }} />
        </div>

        <div className="nickname-logo">
          <h1>Multi Domino</h1>
          <p>실시간 멀티플레이어 도미노</p>
        </div>

        <form className="nickname-form" onSubmit={handleSubmit}>
          <label htmlFor="nickname-input">닉네임</label>
          <input
            id="nickname-input"
            className="nickname-input"
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="닉네임을 입력하세요"
            maxLength={20}
            autoFocus
            autoComplete="off"
          />
          <button type="submit" className="join-button" disabled={!value.trim()}>
            게임 입장
          </button>
        </form>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// HUD
// ──────────────────────────────────────────────
function Hud({
  connected,
  control,
  playerId,
  rotate,
  snapshot,
  topple
}: {
  connected: boolean;
  control: ClientControl;
  playerId: string | null;
  rotate: (direction: -1 | 1) => void;
  snapshot: RoomSnapshot | null;
  topple: () => void;
}) {
  const dominoCount = snapshot?.dominoes.filter((domino) => domino.state === 'placed').length ?? 0;
  const resetSeconds =
    snapshot?.reset?.at && snapshot.reset.at > Date.now()
      ? Math.max(0, (snapshot.reset.at - Date.now()) / 1000)
      : null;
  const myPlayer = snapshot?.players.find((player) => player.id === playerId);
  const stability = Math.round((1 - Math.max(control.jitter, myPlayer?.jitter ?? 0)) * 100);

  return (
    <section className="hud" aria-label="Game status">
      <div className="status-strip">
        <span className={`connection ${connected ? 'is-online' : 'is-offline'}`}>
          {connected ? <Wifi size={17} /> : <WifiOff size={17} />}
          {connected ? 'Online' : 'Connecting'}
        </span>
        <span>Round {snapshot?.round ?? 1}</span>
        <span>{dominoCount} placed</span>
        <span>{control.dragging ? 'Holding' : 'Ready'}</span>
      </div>

      <div className="tool-strip">
        <button type="button" className="icon-button" title="Rotate left" onClick={() => rotate(-1)}>
          <RotateCcw size={20} />
        </button>
        <button type="button" className="icon-button hold-indicator" title="Grab from the tray" aria-pressed={control.dragging}>
          <Hand size={20} />
        </button>
        <button type="button" className="icon-button" title="Rotate right" onClick={() => rotate(1)}>
          <RotateCw size={20} />
        </button>
        <div className="tool-strip-divider" />
        <button
          type="button"
          className="icon-button topple-button"
          title="마지막 도미노 쓰러뜨리기"
          disabled={dominoCount === 0 || Boolean(snapshot?.reset) || Boolean(snapshot?.toppling)}
          onClick={topple}
        >
          <Zap size={20} />
        </button>
      </div>

      <div className="stability-meter" aria-label={`Stability ${stability} percent`}>
        <span>Stability</span>
        <div className="meter-track">
          <div className="meter-fill" style={{ width: `${stability}%` }} />
        </div>
      </div>

      {snapshot?.toppling ? (
        <div className="toppling-banner">&#9889; Chain toppling…</div>
      ) : snapshot?.reset ? (
        <div className="reset-banner">Reset in {resetSeconds?.toFixed(1) ?? '0.0'}s</div>
      ) : null}

      <PlayersPanel players={snapshot?.players ?? []} playerId={playerId} />
    </section>
  );
}

// ──────────────────────────────────────────────
// 접속자 패널
// ──────────────────────────────────────────────
function PlayersPanel({
  players,
  playerId
}: {
  players: RoomSnapshot['players'];
  playerId: string | null;
}) {
  return (
    <div className="players-panel" aria-label="Connected players">
      <div className="players-header">
        <Users size={13} />
        <span>{players.length}명 접속</span>
      </div>
      {players.map((player) => (
        <div key={player.id} className={`player-item${player.id === playerId ? ' is-me' : ''}`}>
          <span className="player-dot" style={{ background: player.color }} />
          <span className="player-name">
            {player.nickname}
            {player.id === playerId ? ' (나)' : ''}
          </span>
        </div>
      ))}
    </div>
  );
}
