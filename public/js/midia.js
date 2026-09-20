// Fotos e áudios: preparo no aparelho, envio e leitura com cache.

export const LIMITE_GRAVACAO_SEG = 5 * 60;
const LIMITE_BYTES = 4 * 1024 * 1024; // depois de comprimir
const BARRAS_ONDA = 44;

// ---------------------------------------------------------------------------
// Fotos
// ---------------------------------------------------------------------------

function paraBlob(canvas, tipo, qualidade) {
  return new Promise((resolve) => canvas.toBlob(resolve, tipo, qualidade));
}

/**
 * Reduz a foto (máx. 1600 px) e converte para JPEG. Isso economiza espaço no banco
 * gratuito e REMOVE os metadados da foto (localização GPS, modelo do celular etc.).
 */
export async function prepararFoto(arquivo) {
  let bmp;
  try {
    bmp = await createImageBitmap(arquivo, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('Não foi possível abrir esta imagem. Use uma foto JPG, PNG ou WebP.');
  }

  const desenhar = (maior) => {
    const escala = Math.min(1, maior / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * escala));
    c.height = Math.max(1, Math.round(bmp.height * escala));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; // PNG transparente vira fundo branco
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  };

  let canvas = desenhar(1600);
  let blob = await paraBlob(canvas, 'image/jpeg', 0.82);
  for (const [maior, q] of [[1600, 0.7], [1280, 0.65], [1024, 0.6]]) {
    if (blob && blob.size <= LIMITE_BYTES) break;
    canvas = desenhar(maior);
    blob = await paraBlob(canvas, 'image/jpeg', q);
  }
  if (!blob || blob.size > LIMITE_BYTES) throw new Error('A foto ficou grande demais. Tente outra.');

  // Miniatura minúscula (vai junto com a mensagem; aparece borrada enquanto a foto carrega)
  const escalaMini = 28 / Math.max(canvas.width, canvas.height);
  const mini = document.createElement('canvas');
  mini.width = Math.max(1, Math.round(canvas.width * escalaMini));
  mini.height = Math.max(1, Math.round(canvas.height * escalaMini));
  mini.getContext('2d').drawImage(canvas, 0, 0, mini.width, mini.height);

  const resultado = {
    blob,
    mime: 'image/jpeg',
    w: canvas.width,
    h: canvas.height,
    thumb: mini.toDataURL('image/jpeg', 0.5),
  };
  bmp.close();
  return resultado;
}

// ---------------------------------------------------------------------------
// Envio / download (com cache)
// ---------------------------------------------------------------------------

/** Envia a foto ou o áudio. O tipo vai no cabeçalho e o servidor confere se o arquivo é mesmo desse tipo. */
export async function subirArquivo(id, blob) {
  const resp = await fetch(`/api/media/${id}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': blob.type },
    body: blob,
  });
  if (resp.status === 401) {
    window.location.replace('/login');
    throw new Error('não autenticado');
  }
  if (!resp.ok) {
    const dados = await resp.json().catch(() => ({}));
    throw new Error(dados.erro || 'Falha ao enviar o arquivo');
  }
}

const cache = new Map(); // id -> Promise<URL de objeto>

export function registrarLocal(id, blob) {
  cache.set(id, Promise.resolve(URL.createObjectURL(blob)));
}

/** Baixa o arquivo e devolve uma URL local (blob:) que o navegador consegue exibir/tocar (funciona também no iPhone). */
export function obterUrl(id, mime) {
  if (!cache.has(id)) {
    const p = (async () => {
      const resp = await fetch(`/api/media/${id}`, { credentials: 'same-origin' });
      if (resp.status === 401) {
        window.location.replace('/login');
        throw new Error('não autenticado');
      }
      if (!resp.ok) throw new Error('Arquivo indisponível');
      return URL.createObjectURL(new Blob([await resp.arrayBuffer()], { type: mime }));
    })();
    p.catch(() => cache.delete(id)); // permite tentar de novo
    cache.set(id, p);
  }
  return cache.get(id);
}

export function esquecerArquivo(id) {
  const p = cache.get(id);
  if (p) p.then((url) => URL.revokeObjectURL(url)).catch(() => {});
  cache.delete(id);
}

// ---------------------------------------------------------------------------
// Gravação de áudio
// ---------------------------------------------------------------------------

function escolherFormato() {
  if (!window.MediaRecorder) return null;
  const opcoes = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
  return opcoes.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

export const gravacaoSuportada = () =>
  Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);

/** Reduz uma lista de amplitudes para `n` barras (0–100) normalizadas. */
function resumirOnda(amostras, n) {
  if (!amostras.length) return new Array(n).fill(8);
  const barras = [];
  for (let i = 0; i < n; i++) {
    const ini = Math.floor((i * amostras.length) / n);
    const fim = Math.max(ini + 1, Math.floor(((i + 1) * amostras.length) / n));
    let max = 0;
    for (let j = ini; j < fim && j < amostras.length; j++) max = Math.max(max, amostras[j]);
    barras.push(max);
  }
  const pico = Math.max(...barras, 0.02);
  return barras.map((v) => Math.max(6, Math.round((v / pico) * 100)));
}

/**
 * Começa a gravar. Devolve { parar(), cancelar(), segundos() }.
 * `aoLimite` é chamado quando chega no tempo máximo.
 */
export async function iniciarGravacao(aoLimite) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });

  const formato = escolherFormato();
  const gravador = new MediaRecorder(stream, {
    ...(formato ? { mimeType: formato } : {}),
    audioBitsPerSecond: 32000, // voz: ~4 KB por segundo
  });

  const pedacos = [];
  gravador.ondataavailable = (e) => e.data.size && pedacos.push(e.data);

  // Amplitude ao longo do tempo → desenho da "onda" no player
  const amostras = [];
  let ctxAudio = null;
  let timer = null;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    ctxAudio = new Ctx();
    const fonte = ctxAudio.createMediaStreamSource(stream);
    const analisador = ctxAudio.createAnalyser();
    analisador.fftSize = 1024;
    fonte.connect(analisador);
    const buf = new Uint8Array(analisador.fftSize);
    timer = setInterval(() => {
      analisador.getByteTimeDomainData(buf);
      let soma = 0;
      for (const v of buf) soma += ((v - 128) / 128) ** 2;
      amostras.push(Math.sqrt(soma / buf.length));
    }, 90);
  } catch {
    /* sem análise: o player mostra uma onda genérica */
  }

  const inicio = performance.now();
  const segundos = () => (performance.now() - inicio) / 1000;
  let terminou = false;
  let limite = null;

  const liberar = () => {
    clearInterval(timer);
    clearTimeout(limite);
    stream.getTracks().forEach((t) => t.stop());
    if (ctxAudio) ctxAudio.close().catch(() => {});
  };

  limite = setTimeout(() => aoLimite && aoLimite(), LIMITE_GRAVACAO_SEG * 1000);

  gravador.start(250);

  return {
    segundos,
    cancelar() {
      if (terminou) return;
      terminou = true;
      liberar();
      if (gravador.state !== 'inactive') gravador.stop();
    },
    parar() {
      return new Promise((resolve, reject) => {
        if (terminou) return reject(new Error('Gravação já encerrada'));
        terminou = true;
        const duracao = segundos();
        gravador.onstop = () => {
          liberar();
          const mime = (gravador.mimeType || formato || 'audio/webm').split(';')[0];
          const blob = new Blob(pedacos, { type: mime });
          if (!blob.size) return reject(new Error('Nada foi gravado'));
          resolve({ blob, mime, dur: Math.round(duracao * 10) / 10, wave: resumirOnda(amostras, BARRAS_ONDA) });
        };
        if (gravador.state !== 'inactive') gravador.stop();
        else gravador.onstop();
      });
    },
  };
}
