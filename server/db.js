const { Pool } = require('pg');
const config = require('./config');
const { erroValidacao } = require('./validar');

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

// --- Estrutura (com atualização automática de versões anteriores) -----------
async function iniciar() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id           BIGSERIAL PRIMARY KEY,
      sender       TEXT        NOT NULL,
      recipient    TEXT        NOT NULL,
      content      JSONB,
      client_id    TEXT,
      media_id     TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      delivered_at TIMESTAMPTZ,
      read_at      TIMESTAMPTZ,
      edited_at    TIMESTAMPTZ,
      deleted_at   TIMESTAMPTZ
    );

    -- Bancos criados por versões anteriores
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS content    JSONB;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_id   TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at  TIMESTAMPTZ;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

    -- Versão 1 guardava o texto na coluna "body": passa para o formato novo.
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'body') THEN
        ALTER TABLE messages ALTER COLUMN body DROP NOT NULL;
        UPDATE messages
           SET content = jsonb_build_object('v', 1, 't', 'text', 'text', body), body = NULL
         WHERE content IS NULL AND body IS NOT NULL AND deleted_at IS NULL;
      END IF;
    END $$;

    CREATE UNIQUE INDEX IF NOT EXISTS messages_client_uq ON messages (sender, client_id);
    CREATE UNIQUE INDEX IF NOT EXISTS messages_media_uq  ON messages (media_id) WHERE media_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS messages_recipient_pending ON messages (recipient) WHERE read_at IS NULL;

    -- Fotos e áudios
    CREATE TABLE IF NOT EXISTS media (
      id         TEXT PRIMARY KEY,
      owner      TEXT        NOT NULL,
      mime       TEXT,
      data       BYTEA       NOT NULL,
      size       INTEGER     NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE media ADD COLUMN IF NOT EXISTS mime TEXT;

    CREATE TABLE IF NOT EXISTS presence (
      username  TEXT PRIMARY KEY,
      last_seen TIMESTAMPTZ NOT NULL
    );
  `);
}

// --- Conversões ----------------------------------------------------------
const iso = (d) => (d ? d.toISOString() : null);

/**
 * `dados` é o conteúdo ({ t: 'text'|'image'|'audio', text, reply, media }).
 * Fica vazio (null) em mensagens apagadas e em mensagens criptografadas de uma
 * versão anterior do chat, que não podem mais ser abertas.
 */
function paraMensagem(r) {
  return {
    id: Number(r.id),
    clientId: r.client_id,
    sender: r.sender,
    dados: r.content || null,
    createdAt: iso(r.created_at),
    deliveredAt: iso(r.delivered_at),
    readAt: iso(r.read_at),
    editedAt: iso(r.edited_at),
    deletedAt: iso(r.deleted_at),
  };
}

// --- Mensagens -----------------------------------------------------------

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
 * Salva uma mensagem (conteúdo já validado). `clientId` torna o envio idempotente:
 * se o celular reenviar a mesma mensagem por causa de instabilidade, ela não duplica.
 */
async function inserirMensagem({ sender, recipient, clientId, dados, entregue }) {
  const mediaId = dados.media ? dados.media.id : null;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    if (mediaId) {
      const m = await c.query('SELECT mime FROM media WHERE id = $1 AND owner = $2', [mediaId, sender]);
      if (!m.rowCount || m.rows[0].mime !== dados.media.mime) {
        throw erroValidacao('Arquivo não encontrado. Tente enviar de novo.');
      }
    }

    const ins = await c.query(
      `INSERT INTO messages (sender, recipient, client_id, content, media_id, delivered_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, CASE WHEN $6::boolean THEN now() END)
       ON CONFLICT (sender, client_id) DO NOTHING
       RETURNING *`,
      [sender, recipient, clientId, JSON.stringify(dados), mediaId, entregue]
    );

    if (ins.rowCount) {
      await c.query('COMMIT');
      return { mensagem: paraMensagem(ins.rows[0]), duplicada: false };
    }

    const existente = await c.query('SELECT * FROM messages WHERE sender = $1 AND client_id = $2', [sender, clientId]);
    await c.query('COMMIT');
    return { mensagem: paraMensagem(existente.rows[0]), duplicada: true };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') throw erroValidacao('Este arquivo já foi usado em outra mensagem.');
    throw err;
  } finally {
    c.release();
  }
}

/** Edita uma mensagem de TEXTO do próprio remetente. */
async function editarMensagem({ id, sender, dados }) {
  const { rows } = await pool.query(
    `UPDATE messages
        SET content = $3::jsonb, edited_at = now()
      WHERE id = $1 AND sender = $2 AND deleted_at IS NULL
        AND media_id IS NULL AND content->>'t' = 'text'
      RETURNING id, content, edited_at`,
    [id, sender, JSON.stringify(dados)]
  );
  if (!rows.length) return null;
  return { id: Number(rows[0].id), dados: rows[0].content, editedAt: iso(rows[0].edited_at) };
}

/** Apaga para todos: some o conteúdo e o arquivo; a linha vira uma "lápide". */
async function apagarMensagem({ id, sender }) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const atual = await c.query(
      'SELECT media_id FROM messages WHERE id = $1 AND sender = $2 AND deleted_at IS NULL FOR UPDATE',
      [id, sender]
    );
    if (!atual.rowCount) {
      await c.query('ROLLBACK');
      return null;
    }
    const upd = await c.query(
      `UPDATE messages
          SET content = NULL, media_id = NULL, deleted_at = now()
        WHERE id = $1
        RETURNING id, deleted_at`,
      [id]
    );
    if (atual.rows[0].media_id) await c.query('DELETE FROM media WHERE id = $1', [atual.rows[0].media_id]);
    await c.query('COMMIT');
    return { id: Number(upd.rows[0].id), deletedAt: iso(upd.rows[0].deleted_at) };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
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

// --- Presença ------------------------------------------------------------
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

// --- Arquivos (fotos e áudios) -----------------------------------------------

/** Guarda um arquivo. Retorna false se o id já pertence a outra pessoa. */
async function salvarMidia({ id, owner, mime, data }) {
  await pool.query(
    `INSERT INTO media (id, owner, mime, data, size) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [id, owner, mime, data, data.length]
  );
  const { rows } = await pool.query('SELECT owner FROM media WHERE id = $1', [id]);
  return rows[0].owner === owner;
}

async function lerMidia(id) {
  const { rows } = await pool.query('SELECT data, mime FROM media WHERE id = $1', [id]);
  return rows.length ? { data: rows[0].data, mime: rows[0].mime } : null;
}

/** Remove uploads que nunca viraram mensagem (ex.: envio cancelado). */
async function limparMidiasOrfas() {
  const r = await pool.query(
    `DELETE FROM media m
      WHERE m.created_at < now() - interval '1 hour'
        AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.media_id = m.id)`
  );
  return r.rowCount;
}

async function tamanhoDoBanco() {
  const { rows } = await pool.query('SELECT pg_database_size(current_database()) AS bytes');
  return Number(rows[0].bytes);
}

/**
 * Apaga mensagens e arquivos que ficaram criptografados por uma versão anterior do chat
 * (sem a chave, não há como abri-los). Usado só pelo script de limpeza.
 */
async function limparRestosCriptografados() {
  const msgs = await pool.query('DELETE FROM messages WHERE content IS NULL AND deleted_at IS NULL');
  const arqs = await pool.query('DELETE FROM media WHERE mime IS NULL');
  return { mensagens: msgs.rowCount, arquivos: arqs.rowCount };
}

async function contarRestosCriptografados() {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM messages WHERE content IS NULL AND deleted_at IS NULL');
  return rows[0].n;
}

module.exports = {
  pool,
  iniciar,
  listarMensagens,
  inserirMensagem,
  editarMensagem,
  apagarMensagem,
  marcarEntregues,
  marcarLidas,
  salvarVisto,
  lerVisto,
  salvarMidia,
  lerMidia,
  limparMidiasOrfas,
  tamanhoDoBanco,
  limparRestosCriptografados,
  contarRestosCriptografados,
};
