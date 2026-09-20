// Criptografia de ponta a ponta — tudo acontece AQUI, no navegador.
//
//  • A "frase secreta" do casal nunca sai do aparelho.
//  • Dela derivamos uma chave AES-256 (PBKDF2-SHA256, 600 mil iterações + sal).
//  • Cada mensagem/arquivo é cifrado com AES-GCM e um IV aleatório novo.
//  • O AAD (dado autenticado) amarra cada texto cifrado ao seu remetente e ao seu id,
//    então o servidor não consegue trocar conteúdos de lugar sem que a verificação falhe.
//  • A chave fica no IndexedDB como CryptoKey NÃO EXTRAÍVEL: nem o JavaScript da
//    página consegue ler os bytes dela.

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- base64 ----------
export function paraB64(bytes) {
  let s = '';
  const passo = 0x8000;
  for (let i = 0; i < bytes.length; i += passo) s += String.fromCharCode(...bytes.subarray(i, i + passo));
  return btoa(s);
}

export function deB64(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function suportado() {
  return Boolean(window.isSecureContext && window.crypto && crypto.subtle && window.indexedDB);
}

// ---------- AAD (amarra o conteúdo ao contexto) ----------
export const aadMensagem = (remetente, clientId) => `so-nos:v1:msg:${remetente}:${clientId}`;
export const aadMidia = (id) => `so-nos:v1:midia:${id}`;
const AAD_VERIFICADOR = 'so-nos:v1:verificador';
const TEXTO_VERIFICADOR = 'so-nos-ok';

// ---------- frase → chave ----------

/** Ignora maiúsculas, acentos "soltos" do teclado e espaços repetidos (o celular costuma "corrigir" a frase). */
export function normalizarFrase(frase) {
  return frase.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export async function derivarChave(frase, salB64, iteracoes) {
  const material = await crypto.subtle.importKey('raw', enc.encode(normalizarFrase(frase)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: deB64(salB64), iterations: iteracoes, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false, // não extraível
    ['encrypt', 'decrypt']
  );
}

/** Código aleatório forte (120 bits) para quem não quer inventar uma frase. Ex.: 7K2M-XQ9D-... */
export function gerarCodigo() {
  const alfabeto = '0123456789abcdefghjkmnpqrstvwxyz'; // base32 (Crockford), sem i/l/o/u
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let s = '';
  for (const b of bytes) s += alfabeto[b & 31];
  return s.match(/.{4}/g).join('-');
}

// ---------- cifrar / decifrar ----------
export async function cifrarBytes(chave, bytes, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, chave, bytes);
  return { iv, ct: new Uint8Array(ct) };
}

export async function decifrarBytes(chave, iv, ct, aad) {
  const claro = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, chave, ct);
  return new Uint8Array(claro);
}

export async function cifrarJson(chave, objeto, aad) {
  const { iv, ct } = await cifrarBytes(chave, enc.encode(JSON.stringify(objeto)), aad);
  return { ct: paraB64(ct), iv: paraB64(iv) };
}

export async function decifrarJson(chave, ctB64, ivB64, aad) {
  const claro = await decifrarBytes(chave, deB64(ivB64), deB64(ctB64), aad);
  return JSON.parse(dec.decode(claro));
}

/** Arquivos: IV (12 bytes) + texto cifrado, num único bloco. */
export async function cifrarArquivo(chave, bytes, aad) {
  const { iv, ct } = await cifrarBytes(chave, bytes, aad);
  const saida = new Uint8Array(iv.length + ct.length);
  saida.set(iv, 0);
  saida.set(ct, iv.length);
  return saida;
}

export async function decifrarArquivo(chave, bloco, aad) {
  return decifrarBytes(chave, bloco.subarray(0, 12), bloco.subarray(12), aad);
}

// ---------- verificador (confere se a frase está certa) ----------
export function criarVerificador(chave) {
  return cifrarJson(chave, TEXTO_VERIFICADOR, AAD_VERIFICADOR);
}

export async function conferirVerificador(chave, verificador) {
  try {
    return (await decifrarJson(chave, verificador.ct, verificador.iv, AAD_VERIFICADOR)) === TEXTO_VERIFICADOR;
  } catch {
    return false; // falha na autenticação do GCM = chave errada
  }
}

// ---------- guarda da chave neste aparelho (IndexedDB) ----------
function abrirBanco() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('so-nos', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('chaves');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function transacao(modo, fn) {
  const db = await abrirBanco();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('chaves', modo);
      const req = fn(tx.objectStore('chaves'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const guardarChave = (chave) => transacao('readwrite', (s) => s.put(chave, 'principal'));
export const apagarChave = () => transacao('readwrite', (s) => s.delete('principal'));
export async function lerChave() {
  try {
    return (await transacao('readonly', (s) => s.get('principal'))) || null;
  } catch {
    return null;
  }
}
