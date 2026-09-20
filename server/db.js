const { Pool } = require('pg');
const config = require('./config');

// --- Conexão -------------------------------------------------------------
// Removemos "sslmode" da URL e controlamos o SSL manualmente, porque as
// versões novas do driver tratam "require" como verificação estrita de
// certificado, o que falha em alguns provedores gratuitos.
const url = new URL(config.databaseUrl);
url.searchParams.delete('sslmode');

const ehLocal = ['localhost', '127.0.0.1', '::1', 'db'].includes(url.hostname);
const usarSsl =
  config.databaseSsl === 'true' ? true : config.databaseSsl === 'false' ? false : !ehLocal;

const pool = new Pool({
  connectionString: url.toString(),
  ssl: usarSsl ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 20_000, // bancos gratuitos "dormem" e demoram para acordar
});

// Bancos serverless derrubam conexões ociosas; sem este handler o Node cairia.
pool.on('error', (err) => console.error('[db] erro em conexão ociosa:', err.message));

// --- Estrutura -----------------------------------------------------------
async function iniciar() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id           BIGSERIAL PRIMARY KEY,
      sender       TEXT        NOT NULL,
      recipient    TEXT        NOT NULL,
      body         TEXT        NOT NULL,
      client_id    TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      delivered_at TIMESTAMPTZ,
      read_at      TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS messages_client_uq ON messages (sender, client_id);
    CREATE INDEX IF NOT EXISTS messages_recipient_pending ON messages (recipient)
      WHERE read_at IS NULL;

    CREATE TABLE IF NOT EXISTS presence (
      username  TEXT PRIMARY KEY,
      last_seen TIMESTAMPTZ NOT NULL
    );
  `);
}

// --- Conversões ----------------------------------------------------------
function paraMensagem(r) {
  return {
    id: Number(r.id),
    clientId: r.client_id,
    sender: r.sender,
    body: r.body,
    createdAt: r.created_at.toISOString(),
    deliveredAt: r.delivered_at ? r.delivered_at.toISOString() : null,
    readAt: r.read_at ? r.read_at.toISOString() : null,
  };
}

// --- Consultas -----------------------------------------------------------

/** Últimas mensagens (ou as anteriores a `antesDoId`), em ordem cronológica. */
async function listarMensagens({ antesDoId, limite }) {
  const { rows } = await pool.query(
    `SELECT * FROM messages
      WHERE ($1::bigint IS NULL OR id < $1::bigint)
      ORDER BY id DESC
      LIMIT $2`,
    [antesDoId ?? null, limite]
  );
  return rows.reverse().map(paraMensagem);
}

/**
 * Salva uma mensagem. `clientId` torna o envio idempotente: se o celular
 * reenviar a mesma mensagem por causa de instabilidade, ela não duplica.
 * Retorna { mensagem, duplicada }.
 */
async function inserirMensagem({ sender, recipient, body, clientId, entregue }) {
  const ins = await pool.query(
    `INSERT INTO messages (sender, recipient, body, client_id, delivered_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN now() END)
     ON CONFLICT (sender, client_id) DO NOTHING
     RETURNING *`,
    [sender, recipient, body, clientId, entregue]
  );
  if (ins.rows.length) return { mensagem: paraMensagem(ins.rows[0]), duplicada: false };

  const existente = await pool.query(
    'SELECT * FROM messages WHERE sender = $1 AND client_id = $2',
    [sender, clientId]
  );
  return { mensagem: paraMensagem(existente.rows[0]), duplicada: true };
}

/** Marca como entregues as mensagens pendentes destinadas a `destinatario`. */
async function marcarEntregues(destinatario) {
  const { rows } = await pool.query(
    `UPDATE messages SET delivered_at = now()
      WHERE recipient = $1 AND delivered_at IS NULL
      RETURNING id`,
    [destinatario]
  );
  return rows.map((r) => Number(r.id));
}

/** Marca como lidas as mensagens destinadas a `destinatario`. */
async function marcarLidas(destinatario) {
  const { rows } = await pool.query(
    `UPDATE messages
        SET read_at = now(), delivered_at = COALESCE(delivered_at, now())
      WHERE recipient = $1 AND read_at IS NULL
      RETURNING id`,
    [destinatario]
  );
  return rows.map((r) => Number(r.id));
}

async function salvarVisto(usuario) {
  const { rows } = await pool.query(
    `INSERT INTO presence (username, last_seen) VALUES ($1, now())
     ON CONFLICT (username) DO UPDATE SET last_seen = now()
     RETURNING last_seen`,
    [usuario]
  );
  return rows[0].last_seen.toISOString();
}

async function lerVisto(usuario) {
  const { rows } = await pool.query('SELECT last_seen FROM presence WHERE username = $1', [usuario]);
  return rows.length ? rows[0].last_seen.toISOString() : null;
}

module.exports = {
  pool,
  iniciar,
  listarMensagens,
  inserirMensagem,
  marcarEntregues,
  marcarLidas,
  salvarVisto,
  lerVisto,
};
