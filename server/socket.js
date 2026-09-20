const { Server } = require('socket.io');
const auth = require('./auth');
const db = require('./db');
const { ehClientId, validarConteudo } = require('./validar');

const sala = (login) => `user:${login}`;

function iniciarSocket(httpServer) {
  const io = new Server(httpServer, {
    // Sem CORS: só aceitamos conexões vindas da própria página.
    cors: false,
    maxHttpBufferSize: 64_000, // só texto trafega aqui; fotos e áudios vão por HTTP
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

    // Limite simples: no máximo 30 ações a cada 10 s por conexão.
    let janela = [];
    const dentroDoLimite = () => {
      const agora = Date.now();
      janela = janela.filter((t) => agora - t < 10_000);
      if (janela.length >= 30) return false;
      janela.push(agora);
      return true;
    };

    /** Envolve um handler: valida o ack, aplica o limite e trata erros de forma uniforme. */
    const acao = (nome, corpo) =>
      socket.on(nome, async (payload, ack) => {
        const responder = typeof ack === 'function' ? ack : () => {};
        try {
          if (!dentroDoLimite()) return responder({ ok: false, erro: 'Devagar! Muitas ações seguidas.' });
          await corpo(payload || {}, responder);
        } catch (err) {
          if (err.validacao) return responder({ ok: false, erro: err.message });
          console.error(`[socket] ${nome}`, err.message);
          responder({ ok: false, erro: 'Erro no servidor. Tente de novo.' });
        }
      });

    // Registramos os handlers ANTES de qualquer await, para não perder eventos.

    acao('message:send', async (p, responder) => {
      if (!ehClientId(p.clientId)) return responder({ ok: false, erro: 'Identificador inválido' });
      const dados = validarConteudo(p.dados);

      const { mensagem, duplicada } = await db.inserirMensagem({
        sender: eu,
        recipient: outro,
        clientId: p.clientId,
        dados,
        entregue: estaOnline(outro),
      });

      responder({ ok: true, mensagem });

      if (!duplicada) {
        socket.to(sala(eu)).emit('message:new', mensagem); // outras abas minhas
        io.to(sala(outro)).emit('message:new', mensagem);
      }
    });

    acao('message:edit', async (p, responder) => {
      if (!Number.isSafeInteger(p.id)) return responder({ ok: false, erro: 'Mensagem inválida' });
      const dados = validarConteudo(p.dados, { soTexto: true });

      const r = await db.editarMensagem({ id: p.id, sender: eu, dados });
      if (!r) return responder({ ok: false, erro: 'Não é possível editar esta mensagem.' });

      responder({ ok: true, ...r });
      socket.to(sala(eu)).emit('message:edited', r);
      io.to(sala(outro)).emit('message:edited', r);
    });

    acao('message:delete', async (p, responder) => {
      if (!Number.isSafeInteger(p.id)) return responder({ ok: false, erro: 'Mensagem inválida' });

      const r = await db.apagarMensagem({ id: p.id, sender: eu });
      if (!r) return responder({ ok: false, erro: 'Não é possível apagar esta mensagem.' });

      responder({ ok: true, ...r });
      socket.to(sala(eu)).emit('message:deleted', r);
      io.to(sala(outro)).emit('message:deleted', r);
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
