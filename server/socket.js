const { Server } = require('socket.io');
const auth = require('./auth');
const db = require('./db');

const MAX_CARACTERES = 4000;

const sala = (login) => `user:${login}`;

function iniciarSocket(httpServer) {
  const io = new Server(httpServer, {
    // Sem CORS: só aceitamos conexões vindas da própria página.
    cors: false,
    maxHttpBufferSize: 20_000, // mensagens são só texto
    pingInterval: 20_000,
    pingTimeout: 20_000,
  });

  // Quantas conexões (abas/aparelhos) cada pessoa tem abertas.
  const conexoes = new Map();
  const estaOnline = (login) => (conexoes.get(login) || 0) > 0;

  // --- Autenticação da conexão -------------------------------------------
  io.use((socket, next) => {
    const h = socket.handshake.headers;

    // Bloqueia conexões originadas em outro site (proteção contra CSWSH).
    if (h.origin) {
      let host;
      try {
        host = new URL(h.origin).host;
      } catch {
        return next(new Error('origem inválida'));
      }
      if (host !== h.host) return next(new Error('origem não permitida'));
    }

    const usuario = auth.usuarioDoCookieHeader(h.cookie);
    if (!usuario) return next(new Error('não autenticado'));

    socket.data.usuario = usuario;
    next();
  });

  // --- Conexão ------------------------------------------------------------
  io.on('connection', (socket) => {
    const eu = socket.data.usuario.login;
    const outro = auth.parceiroDe(eu).login;

    socket.join(sala(eu));

    // Limite simples: no máximo 30 mensagens a cada 10 s por conexão.
    let janela = [];
    const dentroDoLimite = () => {
      const agora = Date.now();
      janela = janela.filter((t) => agora - t < 10_000);
      if (janela.length >= 30) return false;
      janela.push(agora);
      return true;
    };

    // Registramos os handlers ANTES de qualquer await, para não perder eventos.

    socket.on('message:send', async (payload, ack) => {
      const responder = typeof ack === 'function' ? ack : () => {};
      try {
        const body = typeof payload?.body === 'string' ? payload.body.trim() : '';
        const clientId = typeof payload?.clientId === 'string' ? payload.clientId.slice(0, 64) : null;

        if (!body) return responder({ ok: false, erro: 'Mensagem vazia' });
        if (body.length > MAX_CARACTERES) return responder({ ok: false, erro: 'Mensagem muito longa' });
        if (!clientId) return responder({ ok: false, erro: 'Identificador ausente' });
        if (!dentroDoLimite()) return responder({ ok: false, erro: 'Devagar! Muitas mensagens seguidas' });

        const { mensagem, duplicada } = await db.inserirMensagem({
          sender: eu,
          recipient: outro,
          body,
          clientId,
          entregue: estaOnline(outro),
        });

        responder({ ok: true, mensagem });

        if (!duplicada) {
          socket.to(sala(eu)).emit('message:new', mensagem); // outras abas minhas
          io.to(sala(outro)).emit('message:new', mensagem);
        }
      } catch (err) {
        console.error('[socket] message:send', err.message);
        responder({ ok: false, erro: 'Erro ao salvar a mensagem' });
      }
    });

    socket.on('messages:read', async () => {
      try {
        const ids = await db.marcarLidas(eu);
        if (ids.length) {
          io.to(sala(outro)).emit('messages:read', { ids, at: new Date().toISOString() });
        }
      } catch (err) {
        console.error('[socket] messages:read', err.message);
      }
    });

    socket.on('typing', (digitando) => {
      io.to(sala(outro)).emit('typing', Boolean(digitando));
    });

    socket.on('disconnect', async () => {
      const restantes = (conexoes.get(eu) || 1) - 1;
      if (restantes > 0) return conexoes.set(eu, restantes);

      conexoes.delete(eu);
      io.to(sala(outro)).emit('typing', false);
      try {
        const visto = await db.salvarVisto(eu);
        io.to(sala(outro)).emit('presence', { online: false, lastSeen: visto });
      } catch (err) {
        console.error('[socket] salvarVisto', err.message);
        io.to(sala(outro)).emit('presence', { online: false, lastSeen: new Date().toISOString() });
      }
    });

    // --- Estado inicial ---------------------------------------------------
    (async () => {
      try {
        const eraOffline = !estaOnline(eu);
        conexoes.set(eu, (conexoes.get(eu) || 0) + 1);

        // Avisa o parceiro que estou online (só na primeira conexão)
        if (eraOffline) io.to(sala(outro)).emit('presence', { online: true, lastSeen: null });

        // Me diz como está o parceiro
        socket.emit('presence', {
          online: estaOnline(outro),
          lastSeen: estaOnline(outro) ? null : await db.lerVisto(outro),
        });

        // Tudo que chegou enquanto eu estava fora passa a "entregue"
        const ids = await db.marcarEntregues(eu);
        if (ids.length) {
          io.to(sala(outro)).emit('messages:delivered', { ids, at: new Date().toISOString() });
        }
      } catch (err) {
        console.error('[socket] estado inicial', err.message);
      }
    })();
  });

  return io;
}

module.exports = { iniciarSocket };
