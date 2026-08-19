import { useCallback, useEffect, useRef, useState } from 'react';
import { Socket, io } from 'socket.io-client';
import { ClientInput, RoomSnapshot, SERVER_PORT } from '../../shared/protocol';

const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ??
  `http://${window.location.hostname}:${SERVER_PORT}`;

export function useAuthoritativeRoom(nickname: string | null) {
  const socketRef = useRef<Socket | null>(null);
  const sequenceRef = useRef(0);
  const lastSentAtRef = useRef(0);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [playerId, setPlayerId] = useState<string | null>(null);

  useEffect(() => {
    if (!nickname) return; // 닉네임 없으면 연결 안 함

    const socket = io(SERVER_URL, {
      transports: ['websocket'],
      reconnection: true,
      auth: { nickname }
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      setPlayerId(socket.id ?? null);
    });

    socket.on('disconnect', () => {
      setConnected(false);
      setPlayerId(null);
    });

    socket.on('snapshot', (nextSnapshot: RoomSnapshot) => {
      setSnapshot(nextSnapshot);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [nickname]);

  const sendInput = useCallback((input: Omit<ClientInput, 'seq' | 'sentAt'>, force = false) => {
    const socket = socketRef.current;
    const now = performance.now();
    if (!socket?.connected) return;
    if (!force && now - lastSentAtRef.current < 33) return;

    lastSentAtRef.current = now;
    const message: ClientInput = {
      ...input,
      seq: sequenceRef.current,
      sentAt: Date.now()
    };
    sequenceRef.current += 1;
    socket.emit('input', message);
  }, []);

  return {
    connected,
    playerId,
    snapshot,
    sendInput
  };
}
