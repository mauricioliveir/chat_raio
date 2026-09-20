// Validações simples e estritas para tudo que chega do navegador.
// O conteúdo é conferido campo a campo e só o que é conhecido é guardado (lista de permissões).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOGIN = /^[a-z0-9._-]{1,30}$/;
const THUMB = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]{20,6000}$/;

const MIME_IMAGEM = ['image/jpeg', 'image/png', 'image/webp'];
const MIME_AUDIO = ['audio/webm', 'audio/mp4', 'audio/ogg'];
const MIMES_ARQUIVO = new Set([...MIME_IMAGEM, ...MIME_AUDIO]);

const MAX_TEXTO = 4000;
const MAX_LEGENDA = 500;
const MAX_TRECHO = 200;

const ehUuid = (s) => typeof s === 'string' && UUID.test(s);
const ehClientId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);

/** Erro cuja mensagem pode ser mostrada ao usuário. */
function erroValidacao(texto) {
  const e = new Error(texto);
  e.validacao = true;
  return e;
}

const inteiro = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
const numero = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;

/**
 * Confere o conteúdo de uma mensagem e devolve uma cópia "limpa".
 * Formato: { v: 1, t: 'text'|'image'|'audio', text?, reply?, media? }
 */
function validarConteudo(d, { soTexto = false } = {}) {
  if (!d || typeof d !== 'object' || Array.isArray(d) || d.v !== 1) throw erroValidacao('Mensagem inválida.');
  if (!['text', 'image', 'audio'].includes(d.t)) throw erroValidacao('Tipo de mensagem inválido.');
  if (soTexto && d.t !== 'text') throw erroValidacao('Só é possível editar mensagens de texto.');

  const saida = { v: 1, t: d.t };

  if (d.t === 'text') {
    if (typeof d.text !== 'string' || !d.text.trim()) throw erroValidacao('A mensagem está vazia.');
    if (d.text.length > MAX_TEXTO) throw erroValidacao('Mensagem muito longa.');
    saida.text = d.text.trim();
  } else {
    if (d.text != null) {
      if (typeof d.text !== 'string' || d.text.length > MAX_LEGENDA) throw erroValidacao('Legenda muito longa.');
      if (d.text.trim()) saida.text = d.text.trim();
    }
    const md = d.media;
    if (!md || typeof md !== 'object' || !ehUuid(md.id)) throw erroValidacao('Arquivo inválido.');
    const mimes = d.t === 'image' ? MIME_IMAGEM : MIME_AUDIO;
    if (!mimes.includes(md.mime)) throw erroValidacao('Tipo de arquivo não permitido.');

    const media = { id: md.id, mime: md.mime };
    if (md.size != null) {
      if (!inteiro(md.size, 0, 10 * 1024 * 1024)) throw erroValidacao('Arquivo inválido.');
      media.size = md.size;
    }
    if (d.t === 'image') {
      if (!inteiro(md.w, 1, 20000) || !inteiro(md.h, 1, 20000)) throw erroValidacao('Dimensões da foto inválidas.');
      media.w = md.w;
      media.h = md.h;
      if (md.thumb != null) {
        if (typeof md.thumb !== 'string' || !THUMB.test(md.thumb)) throw erroValidacao('Miniatura inválida.');
        media.thumb = md.thumb;
      }
    } else {
      if (!numero(md.dur, 0, 600)) throw erroValidacao('Duração do áudio inválida.');
      media.dur = md.dur;
      if (md.wave != null) {
        if (!Array.isArray(md.wave) || md.wave.length > 80 || !md.wave.every((v) => numero(v, 0, 100))) {
          throw erroValidacao('Onda do áudio inválida.');
        }
        media.wave = md.wave.map((v) => Math.round(v));
      }
    }
    saida.media = media;
  }

  if (d.reply != null) {
    const r = d.reply;
    if (!r || typeof r !== 'object' || !ehClientId(r.ref) || typeof r.de !== 'string' || !LOGIN.test(r.de)) {
      throw erroValidacao('Resposta inválida.');
    }
    if (typeof r.snip !== 'string' || r.snip.length > MAX_TRECHO) throw erroValidacao('Resposta inválida.');
    saida.reply = { ref: r.ref, de: r.de, snip: r.snip };
  }

  return saida;
}

/**
 * Confere se os primeiros bytes do arquivo batem com o tipo informado
 * (impede que um arquivo de outro tipo seja guardado como foto ou áudio).
 */
function assinaturaConfere(mime, b) {
  const bytes = (ini, ...v) => v.every((x, i) => b[ini + i] === x);
  const texto = (ini, fim) => b.toString('latin1', ini, fim);
  switch (mime) {
    case 'image/jpeg':
      return bytes(0, 0xff, 0xd8, 0xff);
    case 'image/png':
      return bytes(0, 0x89, 0x50, 0x4e, 0x47);
    case 'image/webp':
      return texto(0, 4) === 'RIFF' && texto(8, 12) === 'WEBP';
    case 'audio/webm':
      return bytes(0, 0x1a, 0x45, 0xdf, 0xa3);
    case 'audio/mp4':
      return texto(4, 8) === 'ftyp';
    case 'audio/ogg':
      return texto(0, 4) === 'OggS';
    default:
      return false;
  }
}

module.exports = { ehUuid, ehClientId, erroValidacao, validarConteudo, assinaturaConfere, MIMES_ARQUIVO };
