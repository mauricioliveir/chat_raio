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
        'img-src': ["'self'", 'data:'],
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

app.use('/api', (req, res) => res.status(404).json({ erro: 'Não encontrado' }));

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
