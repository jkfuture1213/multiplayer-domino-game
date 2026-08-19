import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { AuthoritativeDominoRoom } from './game/AuthoritativeDominoRoom.js';
import { SERVER_PORT } from '../shared/protocol.js';

async function main() {
  const httpServer = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    response.writeHead(404);
    response.end();
  });

  const io = new Server(httpServer, {
    cors: {
      origin: '*'
    },
    transports: ['websocket']
  });

  const room = await AuthoritativeDominoRoom.create(io);

  io.on('connection', (socket) => {
    room.addPlayer(socket);
  });

  httpServer.listen(SERVER_PORT, '0.0.0.0', () => {
    console.log(`Authoritative domino server listening on http://0.0.0.0:${SERVER_PORT}`);
    console.log(`  → LAN: http://<your-local-IP>:${SERVER_PORT}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
