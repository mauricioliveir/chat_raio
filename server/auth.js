const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const config = require('./config');

const COOKIE = 'sessao';

// As senhas vêm do .env e são convertidas em hash na memória ao iniciar.
// Depois disso, o texto original não é mais usado.
const usuarios = config.usuarios.map((u) => ({
  login: u.login,
  nome: u.nome,
  hash: bcrypt.hashSync(u.senha, 10),
}));

// Hash falso: comparamos contra ele quando o login não existe, para que o tempo
// de resposta não revele se o usuário existe ou não.
const HASH_FALSO = bcrypt.hashSync('senha-falsa-para-igualar-tempo', 10);

function buscarUsuario(login) {
  return usuarios.find((u) => u.login === String(login || '').trim().toLowerCase());
}

function parceiroDe(login) {
  return usuarios.find((u) => u.login !== login);
}

function publico(u) {
  return { login: u.login, nome: u.nome };
}

async function verificarCredenciais(login, senha) {
  const u = buscarUsuario(login);
  const ok = await bcrypt.compare(String(senha || ''), u ? u.hash : HASH_FALSO);
  return u && ok ? u : null;
}

function assinar(login) {
  return jwt.sign({ sub: login }, config.jwtSecret, {
    expiresIn: `${config.sessaoDias}d`,
    algorithm: 'HS256',
  });
}

/** Lê e valida o token; devolve o usuário ou null. */
function usuarioDoToken(token) {
  if (!token) return null;
  try {
    const dados = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    return buscarUsuario(dados.sub) || null;
  } catch {
    return null;
  }
}

function usuarioDaRequisicao(req) {
  return usuarioDoToken(req.cookies?.[COOKIE]);
}

function usuarioDoCookieHeader(header) {
  if (!header) return null;
  return usuarioDoToken(cookie.parse(header)[COOKIE]);
}

function definirCookie(res, login) {
  res.cookie(COOKIE, assinar(login), {
    httpOnly: true, // JavaScript da página não consegue ler
    secure: config.isProd, // só via HTTPS em produção
    sameSite: 'lax',
    maxAge: config.sessaoDias * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function limparCookie(res) {
  res.clearCookie(COOKIE, { httpOnly: true, secure: config.isProd, sameSite: 'lax', path: '/' });
}

/** Middleware para rotas da API. */
function exigirLogin(req, res, next) {
  const u = usuarioDaRequisicao(req);
  if (!u) return res.status(401).json({ erro: 'Não autenticado' });
  req.usuario = u;
  next();
}

module.exports = {
  parceiroDe,
  publico,
  verificarCredenciais,
  usuarioDaRequisicao,
  usuarioDoCookieHeader,
  definirCookie,
  limparCookie,
  exigirLogin,
};
