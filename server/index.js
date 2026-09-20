const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const auth = require('./auth');
const db = require('./db');
const { iniciarSocket } = require('./socket');
const { ehUuid, assinaturaConfere, MIMES_ARQUIVO } = require('./validar');

const app = express();
const server = http.createServer(app);

// Atrás do proxy da hospedagem (Render, etc.) o IP real vem no cabeçalho.
app.set('trust proxy', config.isProd ? 1 : false);
app.disable('x-powered-by');

// --- Cabeçalhos de segurança ----------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'"],
        'style-src': ["'self'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'connect-src': ["'self'", 'ws:', 'wss:'],
        // blob: = fotos e áudios baixados pelo app e exibidos a partir da memória do navegador
        'img-src': ["'self'", 'data:', 'blob:'],
        'media-src': ["'self'", 'blob:'],
        // Em http://localhost não podemos forçar https.
        'upgrade-insecure-requests': config.isProd ? [] : null,
      },
    },
  })
);

app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

// --- Proteção CSRF: requisições que alteram dados precisam vir do mesmo site --
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origem = req.get('origin');
  if (origem) {
    try {
      if (new URL(origem).host !== req.get('host')) throw new Error();
    } catch {
      return res.status(403).json({ erro: 'Origem não permitida' });
    }
  }
  next();
});

// --- Arquivos estáticos (CSS, JS, ícones). As páginas HTML são servidas abaixo. --
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

// --- Páginas -----------------------------------------------------------------
app.get('/', (req, res) => {
  if (!auth.usuarioDaRequisicao(req)) return res.redirect('/login');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'views', 'chat.html'));
});

app.get('/login', (req, res) => {
  if (auth.usuarioDaRequisicao(req)) return res.redirect('/');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'views', 'login.html'));
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));

// --- API ---------------------------------------------------------------------

// Máximo de 8 tentativas erradas a cada 15 minutos por IP.
const limitarLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' },
});

app.post('/api/login', limitarLogin, async (req, res) => {
  const { login, senha } = req.body || {};
  const usuario = await auth.verificarCredenciais(login, senha);
  if (!usuario) return res.status(401).json({ erro: 'Usuário ou senha incorretos' });
  auth.definirCookie(res, usuario.login);
  res.json({ ok: true });
});

// Público de propósito: a tela de login mostra "Juntos há…" (só existe se JUNTOS_DESDE estiver no .env).
app.get('/api/inicio', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ juntosDesde: config.juntosDesde });
});

app.post('/api/logout', (req, res) => {
  auth.limparCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', auth.exigirLogin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    eu: auth.publico(req.usuario),
    parceiro: auth.publico(auth.parceiroDe(req.usuario.login)),
  });
});

app.get('/api/messages', auth.exigirLogin, async (req, res) => {
  try {
    const limite = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const antes = parseInt(req.query.before, 10);
    const mensagens = await db.listarMensagens({
      antesDoId: Number.isFinite(antes) ? antes : null,
      limite,
    });
    res.set('Cache-Control', 'no-store');
    res.json({ mensagens, temMais: mensagens.length === limite });
  } catch (err) {
    console.error('[api] messages', err.message);
    res.status(500).json({ erro: 'Erro ao carregar mensagens' });
  }
});

// --- Arquivos (fotos e áudios) -------------------------------------------------
const LIMITE_ARQUIVO = 6 * 1024 * 1024;
const tipoDe = (req) => (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();

const limitarUpload = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.usuario.login,
  message: { erro: 'Muitos envios seguidos. Aguarde um pouco.' },
});

app.post(
  '/api/media/:id',
  auth.exigirLogin,
  limitarUpload,
  express.raw({ type: (req) => MIMES_ARQUIVO.has(tipoDe(req)), limit: LIMITE_ARQUIVO }),
  async (req, res) => {
    const mime = tipoDe(req);
    if (!ehUuid(req.params.id)) return res.status(400).json({ erro: 'Identificador inválido' });
    if (!MIMES_ARQUIVO.has(mime)) return res.status(415).json({ erro: 'Tipo de arquivo não permitido' });
    if (!Buffer.isBuffer(req.body) || req.body.length < 64) return res.status(400).json({ erro: 'Arquivo inválido' });
    // Confere os primeiros bytes: um arquivo de outro tipo não passa por foto ou áudio.
    if (!assinaturaConfere(mime, req.body)) return res.status(400).json({ erro: 'O arquivo não parece ser do tipo informado' });
    try {
      const ok = await db.salvarMidia({ id: req.params.id, owner: req.usuario.login, mime, data: req.body });
      if (!ok) return res.status(409).json({ erro: 'Identificador em uso' });
      res.status(201).json({ ok: true });
    } catch (err) {
      console.error('[api] upload', err.message);
      res.status(500).json({ erro: 'Erro ao salvar o arquivo' });
    }
  }
);

app.get('/api/media/:id', auth.exigirLogin, async (req, res) => {
  if (!ehUuid(req.params.id)) return res.status(400).json({ erro: 'Identificador inválido' });
  try {
    const arquivo = await db.lerMidia(req.params.id);
    if (!arquivo) return res.status(404).json({ erro: 'Arquivo não encontrado' });
    // O conteúdo de um id nunca muda: pode ficar em cache no aparelho.
    res.set({
      'Content-Type': arquivo.mime && MIMES_ARQUIVO.has(arquivo.mime) ? arquivo.mime : 'application/octet-stream',
      'Content-Disposition': 'inline',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    res.send(arquivo.data);
  } catch (err) {
    console.error('[api] media', err.message);
    res.status(500).json({ erro: 'Erro ao carregar o arquivo' });
  }
});

app.get('/api/armazenamento', auth.exigirLogin, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ usadoBytes: await db.tamanhoDoBanco(), limiteBytes: config.limiteArmazenamentoMb * 1024 * 1024 });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao consultar o espaço usado' });
  }
});

app.use('/api', (req, res) => res.status(404).json({ erro: 'Não encontrado' }));

// Erros (ex.: arquivo grande demais) sempre em JSON, sem detalhes internos.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('[erro]', err.message);
  const texto = status === 413 ? 'Arquivo grande demais.' : 'Requisição inválida.';
  res.status(status).json({ erro: status === 500 ? 'Erro no servidor' : texto });
});

// --- Início ------------------------------------------------------------------
const io = iniciarSocket(server);

(async () => {
  try {
    await db.iniciar();
  } catch (err) {
    console.error('\n[ERRO] Não foi possível conectar ao banco de dados:', err.message);
    console.error('Confira o DATABASE_URL no arquivo .env\n');
    process.exit(1);
  }
  db.limparMidiasOrfas().catch(() => {});
  setInterval(() => db.limparMidiasOrfas().catch(() => {}), 30 * 60 * 1000).unref();
  server.listen(config.port, () => {
    console.log(`Chat no ar: http://localhost:${config.port}`);
  });
})();

// Encerramento limpo (a hospedagem envia SIGTERM ao reiniciar)
for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, () => {
    // io.close() desconecta os sockets e fecha o servidor HTTP; os navegadores reconectam sozinhos.
    io.close(() => db.pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
