require('dotenv').config();

function exigir(nome) {
  const valor = process.env[nome];
  if (!valor || !valor.trim()) {
    console.error(`\n[ERRO] Variável de ambiente ausente: ${nome}`);
    console.error('Copie .env.example para .env e preencha todos os campos.\n');
    process.exit(1);
  }
  return valor.trim();
}

const jwtSecret = exigir('JWT_SECRET');
if (jwtSecret.length < 32) {
  console.error('\n[ERRO] JWT_SECRET precisa ter pelo menos 32 caracteres. Use: npm run gerar-segredo\n');
  process.exit(1);
}

function lerUsuario(n) {
  const login = exigir(`USER${n}_LOGIN`).toLowerCase();
  if (!/^[a-z0-9._-]{2,30}$/.test(login)) {
    console.error(`\n[ERRO] USER${n}_LOGIN inválido. Use 2 a 30 caracteres: letras, números, ponto, hífen ou _.\n`);
    process.exit(1);
  }
  // A senha NÃO passa por trim: espaços fazem parte dela.
  const senha = process.env[`USER${n}_SENHA`];
  if (!senha || senha.length < 8) {
    console.error(`\n[ERRO] USER${n}_SENHA precisa ter pelo menos 8 caracteres.\n`);
    process.exit(1);
  }
  return { login, nome: exigir(`USER${n}_NOME`), senha };
}

const usuarios = [lerUsuario(1), lerUsuario(2)];
if (usuarios[0].login === usuarios[1].login) {
  console.error('\n[ERRO] USER1_LOGIN e USER2_LOGIN precisam ser diferentes.\n');
  process.exit(1);
}

// Data opcional (AAAA-MM-DD) para mostrar "Juntos há X anos…" na tela de login.
function lerDataJuntos() {
  const bruto = (process.env.JUNTOS_DESDE || '').trim();
  if (!bruto) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bruto);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3] || d > new Date()) {
    console.error('\n[ERRO] JUNTOS_DESDE inválido. Use o formato AAAA-MM-DD (ex.: 2019-06-15), com uma data que já passou.\n');
    process.exit(1);
  }
  return bruto;
}

module.exports = {
  port: Number(process.env.PORT) || 3000,
  isProd: process.env.NODE_ENV === 'production',
  databaseUrl: exigir('DATABASE_URL'),
  databaseSsl: process.env.DATABASE_SSL, // 'true' | 'false' | undefined (automático)
  jwtSecret,
  usuarios,
  sessaoDias: 30,
  juntosDesde: lerDataJuntos(),
  // Limite (em MB) só para EXIBIR o espaço usado. O plano gratuito do Neon tem ~500 MB.
  limiteArmazenamentoMb: Number(process.env.STORAGE_LIMIT_MB) || 500,
};
