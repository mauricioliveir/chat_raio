import {
  prepararFoto,
  subirArquivo,
  registrarLocal,
  obterUrl,
  esquecerArquivo,
  iniciarGravacao,
  gravacaoSuportada,
  LIMITE_GRAVACAO_SEG,
} from './midia.js';

const NOME_APP = 'Só nós';

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'),
  lista: $('mensagens'),
  topo: $('topo'),
  vazio: $('vazio'),
  digitando: $('digitando'),
  form: $('composer'),
  campo: $('campo'),
  enviar: $('enviar'),
  mic: $('mic'),
  anexar: $('anexar'),
  arquivoFoto: $('arquivo-foto'),
  nome: $('nome-parceiro'),
  inicial: $('inicial'),
  avatar: $('avatar'),
  status: $('status'),
  irFim: $('ir-fim'),
  irFimTexto: $('ir-fim-texto'),
  faixa: $('faixa'),
  avisoNotif: $('aviso-notif'),
  contexto: $('contexto'),
  contextoTitulo: $('contexto-titulo'),
  contextoPrevia: $('contexto-previa'),
  gravacao: $('gravacao'),
  gravTempo: $('grav-tempo'),
  menuMsg: $('menu-msg'),
  toast: $('toast'),
  menuBtn: $('menu-btn'),
  menuConta: $('menu-conta'),
  menuEspaco: $('menu-espaco'),
};

const estado = {
  eu: null,
  parceiro: null,
  mensagens: [], // sempre em ordem cronológica
  temMais: true,
  carregandoAntigas: false,
  socket: null,
  jaConectou: false,
  presenca: { online: false, lastSeen: null },
  parceiroDigitando: false,
  respondendo: null,
  editando: null,
  gravador: null,
};

const reduzMovimento = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ehToque = () => window.matchMedia('(pointer: coarse)').matches;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function gerarId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

const chave = (m) => m.clientId || 'id-' + m.id;
const ehMinha = (m) => m.sender === estado.eu.login;
const nomeDe = (login) => (login === estado.eu.login ? 'Você' : estado.parceiro.nome);

const fmtHora = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fmtDia = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
const fmtDiaCurto = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });

const hora = (iso) => fmtHora.format(new Date(iso));
const inicioDoDia = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const mesmoDia = (a, b) => inicioDoDia(new Date(a)) === inicioDoDia(new Date(b));
const diasDeDiferenca = (iso) => Math.round((inicioDoDia(new Date()) - inicioDoDia(new Date(iso))) / 86_400_000);

function rotuloDia(iso) {
  const dif = diasDeDiferenca(iso);
  if (dif === 0) return 'Hoje';
  if (dif === 1) return 'Ontem';
  return fmtDia.format(new Date(iso));
}

function quando(iso) {
  const dif = diasDeDiferenca(iso);
  if (dif === 0) return `hoje às ${hora(iso)}`;
  if (dif === 1) return `ontem às ${hora(iso)}`;
  return `${fmtDiaCurto.format(new Date(iso))} às ${hora(iso)}`;
}

function fmtDuracao(seg) {
  const s = Math.max(0, Math.round(Number(seg) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtBytes(b) {
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

const naFrente = () => document.visibilityState === 'visible' && document.hasFocus();

async function api(caminho, opcoes = {}) {
  const resp = await fetch(caminho, {
    credentials: 'same-origin',
    ...opcoes,
    headers: { Accept: 'application/json', ...(opcoes.headers || {}) },
  });
  if (resp.status === 401) {
    window.location.replace('/login');
    throw new Error('não autenticado');
  }
  if (!resp.ok && !opcoes.aceitarErro) {
    const dados = await resp.json().catch(() => ({}));
    throw new Error(dados.erro || 'Erro ' + resp.status);
  }
  return opcoes.aceitarErro ? resp : resp.json();
}

let temporizadorToast = null;
function toast(texto, ms = 3800) {
  el.toast.textContent = texto;
  el.toast.hidden = false;
  clearTimeout(temporizadorToast);
  temporizadorToast = setTimeout(() => (el.toast.hidden = true), ms);
}

/** Envia um evento e espera a resposta do servidor (com tempo limite). */
function emitirComAck(evento, payload, ms = 20_000) {
  return new Promise((resolve) => {
    if (!estado.socket) return resolve({ ok: false, erro: 'Sem conexão' });
    estado.socket.timeout(ms).emit(evento, payload, (err, resp) => {
      resolve(err || !resp ? { ok: false, erro: 'Sem resposta do servidor. Tente de novo.' } : resp);
    });
  });
}

/** Diálogo de confirmação. Devolve true/false. */
function confirmar(texto, rotulo = 'Apagar') {
  const dlg = $('dlg-confirmar');
  $('confirmar-texto').textContent = texto;
  $('confirmar-ok').textContent = rotulo;
  dlg.returnValue = '';
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
  });
}

// ---------------------------------------------------------------------------
// Conteúdo das mensagens
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const THUMB_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
const MIME_IMAGEM = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MIME_AUDIO = new Set(['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/aac', 'audio/x-m4a']);

/** Confere o formato do conteúdo (nunca confiamos cegamente no que chega). */
function conteudoValido(d) {
  if (!d || d.v !== 1 || typeof d.t !== 'string') return false;
  if (d.text != null && typeof d.text !== 'string') return false;
  if (d.t === 'text') return typeof d.text === 'string';
  const md = d.media;
  if (!md || !UUID_RE.test(md.id)) return false;
  if (d.t === 'image') return MIME_IMAGEM.has(md.mime);
  if (d.t === 'audio') return MIME_AUDIO.has(md.mime);
  return false;
}

/**
 * Prepara a mensagem que veio do servidor. Se o conteúdo não existir (mensagem criptografada por
 * uma versão antiga do chat) ou não tiver o formato esperado, ela aparece como "não pode ser aberta".
 */
function decodificar(m) {
  m.apagada = Boolean(m.deletedAt);
  m.ilegivel = false;
  if (m.apagada) {
    m.dados = null;
    return m;
  }
  if (!conteudoValido(m.dados)) {
    m.dados = null;
    m.ilegivel = true;
  }
  return m;
}

/** Resumo curto de uma mensagem (usado nas respostas e nos avisos). */
function resumo(d) {
  if (!d) return '';
  if (d.t === 'image') return d.text ? `Foto: ${d.text.slice(0, 100)}` : 'Foto';
  if (d.t === 'audio') return `Áudio (${fmtDuracao(d.media.dur)})`;
  return (d.text || '').slice(0, 140);
}

// ---------------------------------------------------------------------------
// Ícones (SVG estático, sem dados do usuário)
// ---------------------------------------------------------------------------

const ICONES = {
  enviando:
    '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.6V8l2.3 1.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  enviada:
    '<svg viewBox="0 0 17 16" width="16" height="15"><path d="M3 8.5l3.5 3.5L13 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  entregue:
    '<svg viewBox="0 0 17 16" width="16" height="15"><path d="M1.5 8.5L5 12l6.5-7M8.5 11.6l.6.4L15.5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  falhou:
    '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.8v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.1" r="0.9" fill="currentColor"/></svg>',
  apagada:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.8 12.2l8.4-8.4" stroke="currentColor" stroke-width="1.5"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
  pause:
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M7 5.5h3.5v13H7zM13.5 5.5H17v13h-3.5z" fill="currentColor"/></svg>',
  chevron:
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  responder:
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M10 6L4 12l6 6M4 12h10a6 6 0 0 1 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
ICONES.lida = ICONES.entregue;

const ROTULOS = { enviando: 'Enviando', enviada: 'Enviada', entregue: 'Entregue', lida: 'Lida', falhou: 'Não enviada' };

function statusDe(m) {
  if (m.falhou) return 'falhou';
  if (m.pendente) return 'enviando';
  if (m.readAt) return 'lida';
  if (m.deliveredAt) return 'entregue';
  return 'enviada';
}

// ---------------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

/** Texto da mensagem. Só usa textContent: nada do usuário vira HTML. */
function criarTexto(corpo) {
  const span = document.createElement('span');
  span.className = 'texto';
  let ultimo = 0;

  for (const achado of corpo.matchAll(URL_RE)) {
    let url = achado[0];
    const pontuacao = url.match(/[.,;:!?)\]]+$/);
    if (pontuacao) url = url.slice(0, -pontuacao[0].length);
    if (!url) continue;

    span.append(corpo.slice(ultimo, achado.index));
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    span.append(a);
    ultimo = achado.index + url.length;
  }
  span.append(corpo.slice(ultimo));
  return span;
}

function criarMeta(m) {
  const meta = document.createElement('span');
  meta.className = 'meta';

  if (m.falhou) {
    meta.append('Não enviada. Toque para reenviar');
  } else {
    if (m.editedAt && !m.apagada) {
      const ed = document.createElement('span');
      ed.className = 'editada';
      ed.textContent = 'editada';
      meta.append(ed);
    }
    const t = document.createElement('time');
    t.dateTime = m.createdAt;
    t.textContent = hora(m.createdAt);
    meta.append(t);
  }

  if (ehMinha(m) && !m.apagada) {
    const st = statusDe(m);
    const ticks = document.createElement('span');
    ticks.className = 'ticks' + (st === 'lida' ? ' lida' : '');
    ticks.setAttribute('role', 'img');
    ticks.setAttribute('aria-label', ROTULOS[st]);
    ticks.innerHTML = ICONES[st]; // string fixa definida acima
    meta.append(ticks);
  }
  return meta;
}

function criarCitacao(r) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'citacao';
  b.dataset.ref = String(r.ref || '');
  const nome = document.createElement('b');
  nome.textContent = nomeDe(r.de);
  const txt = document.createElement('span');
  txt.textContent = String(r.snip || '');
  b.append(nome, txt);
  return b;
}

// --- Foto ---
const observadorFotos = new IntersectionObserver(
  (entradas) => {
    for (const e of entradas) {
      if (e.isIntersecting) {
        observadorFotos.unobserve(e.target);
        e.target.__carregar?.();
      }
    }
  },
  { root: el.lista, rootMargin: '400px 0px' }
);

function criarImagem(m) {
  const md = m.dados.media;
  const w = Math.min(Math.max(Number(md.w) || 1, 1), 20000);
  const h = Math.min(Math.max(Number(md.h) || 1, 1), 20000);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'img-wrap';
  btn.setAttribute('aria-label', 'Abrir foto');
  btn.style.setProperty('--ar', String(w / h));
  if (typeof md.thumb === 'string' && THUMB_RE.test(md.thumb)) btn.style.backgroundImage = `url("${md.thumb}")`;

  const img = document.createElement('img');
  img.alt = m.dados.text || 'Foto';
  btn.append(img);

  btn.__carregar = () => {
    obterUrl(md.id, md.mime)
      .then((url) => {
        img.onload = () => img.classList.add('pronta');
        img.src = url;
      })
      .catch(() => btn.classList.add('falha'));
  };
  observadorFotos.observe(btn);

  btn.addEventListener('click', () => {
    if (btn.classList.contains('falha')) {
      btn.classList.remove('falha');
      btn.__carregar();
    } else {
      abrirLightbox(md);
    }
  });
  return btn;
}

async function abrirLightbox(md) {
  try {
    const url = await obterUrl(md.id, md.mime);
    $('lightbox-img').src = url;
    const salvar = $('lightbox-salvar');
    salvar.href = url;
    salvar.download = `foto-${new Date().toISOString().slice(0, 10)}.jpg`;
    $('dlg-lightbox').showModal();
  } catch {
    toast('Não foi possível abrir a foto.');
  }
}

// --- Áudio ---
let audioTocando = null; // { pausar() }

function criarPlayer(m) {
  const md = m.dados.media;
  const bruto = Array.isArray(md.wave) ? md.wave.slice(0, 80) : [];
  const alturas = bruto.length ? bruto.map((v) => Math.min(100, Math.max(6, Number(v) || 6))) : new Array(40).fill(30);

  const wrap = document.createElement('div');
  wrap.className = 'player';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'player-btn';
  btn.innerHTML = ICONES.play;
  btn.setAttribute('aria-label', 'Tocar áudio');

  const onda = document.createElement('div');
  onda.className = 'onda';
  const barras = alturas.map((v) => {
    const i = document.createElement('i');
    i.style.height = `${v}%`;
    onda.append(i);
    return i;
  });

  const tempo = document.createElement('span');
  tempo.className = 'player-tempo';
  tempo.textContent = fmtDuracao(md.dur);

  wrap.append(btn, onda, tempo);

  let audio = null;
  const pintar = (fracao) => barras.forEach((b, i) => b.classList.toggle('tocada', (i + 0.5) / barras.length <= fracao));
  const controle = { pausar: () => audio && audio.pause() };
  m.pararAudio = controle.pausar;

  async function alternar() {
    if (audio && !audio.paused) return audio.pause();
    if (audioTocando && audioTocando !== controle) audioTocando.pausar();

    if (!audio) {
      btn.disabled = true;
      try {
        const url = await obterUrl(md.id, md.mime);
        audio = new Audio(url);
      } catch {
        btn.disabled = false;
        return toast('Não foi possível carregar o áudio.');
      }
      btn.disabled = false;

      audio.addEventListener('play', () => {
        btn.innerHTML = ICONES.pause;
        btn.setAttribute('aria-label', 'Pausar áudio');
        audioTocando = controle;
      });
      audio.addEventListener('pause', () => {
        btn.innerHTML = ICONES.play;
        btn.setAttribute('aria-label', 'Tocar áudio');
        if (audioTocando === controle) audioTocando = null;
      });
      audio.addEventListener('timeupdate', () => {
        // Gravações do navegador não trazem a duração no arquivo: usamos a que foi salva junto.
        const total = Number(md.dur) || (isFinite(audio.duration) ? audio.duration : 0);
        pintar(total ? Math.min(1, audio.currentTime / total) : 0);
        tempo.textContent = fmtDuracao(audio.currentTime);
      });
      audio.addEventListener('ended', () => {
        audio.currentTime = 0;
        pintar(0);
        tempo.textContent = fmtDuracao(md.dur);
      });
    }
    audio.play().catch(() => toast('Não foi possível tocar o áudio.'));
  }

  btn.addEventListener('click', alternar);
  onda.addEventListener('click', (ev) => {
    if (!audio || !isFinite(audio.duration) || !audio.duration) return;
    const r = onda.getBoundingClientRect();
    audio.currentTime = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * audio.duration;
  });
  return wrap;
}

// --- Bolha ---
function preencherBolha(bolha, m) {
  bolha.replaceChildren();
  bolha.className = 'bolha';

  if (m.apagada) {
    const s = document.createElement('span');
    s.className = 'apagada';
    s.innerHTML = ICONES.apagada;
    s.append(ehMinha(m) ? 'Você apagou esta mensagem' : 'Mensagem apagada');
    bolha.append(s, criarMeta(m));
    return;
  }

  if (m.ilegivel || !m.dados) {
    const s = document.createElement('span');
    s.className = 'ilegivel';
    s.textContent = 'Esta mensagem é de uma versão antiga do chat e não pode mais ser aberta.';
    bolha.append(s, criarMeta(m));
    return;
  }

  const d = m.dados;
  if (d.reply && typeof d.reply === 'object') bolha.append(criarCitacao(d.reply));

  if (d.t === 'image') {
    bolha.classList.add('so-imagem');
    if (!d.text) bolha.classList.add('sem-legenda');
    bolha.append(criarImagem(m));
  } else if (d.t === 'audio') {
    bolha.classList.add('so-audio');
    bolha.append(criarPlayer(m));
  }

  if (d.text) bolha.append(criarTexto(d.text));
  bolha.append(criarMeta(m));
}

const temAcoes = (m) => Boolean(m.id && !m.apagada && !m.ilegivel && !m.pendente && !m.falhou);

function criarBotaoAcoes() {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'acoes-btn';
  b.setAttribute('aria-label', 'Opções da mensagem');
  b.setAttribute('aria-haspopup', 'menu');
  b.innerHTML = ICONES.chevron;
  return b;
}

function comecaSequencia(m, anterior) {
  return (
    !anterior ||
    anterior.sender !== m.sender ||
    !mesmoDia(anterior.createdAt, m.createdAt) ||
    new Date(m.createdAt) - new Date(anterior.createdAt) > 5 * 60 * 1000
  );
}

function criarElemento(m, anterior) {
  const linha = document.createElement('div');
  linha.className = 'msg ' + (ehMinha(m) ? 'minha' : 'dela');
  if (comecaSequencia(m, anterior)) linha.classList.add('inicio');
  if (m.falhou) linha.classList.add('falhou');
  linha.dataset.chave = chave(m);

  const bolha = document.createElement('div');
  preencherBolha(bolha, m);

  const acoes = criarBotaoAcoes();
  acoes.hidden = !temAcoes(m);
  if (ehMinha(m)) linha.append(acoes, bolha);
  else linha.append(bolha, acoes);
  return linha;
}

function criarSeparadorDia(iso) {
  const d = document.createElement('div');
  d.className = 'dia';
  d.textContent = rotuloDia(iso);
  return d;
}

const estaNoFim = () => el.lista.scrollHeight - el.lista.scrollTop - el.lista.clientHeight < 80;

function rolarParaFim(suave) {
  el.lista.scrollTo({ top: el.lista.scrollHeight, behavior: suave && !reduzMovimento ? 'smooth' : 'auto' });
}

const FIXOS = new Set([el.topo, el.vazio, el.digitando]);

/** Refaz a lista inteira mantendo a posição de rolagem em relação ao final. */
function renderizarTudo() {
  const distanciaDoFim = el.lista.scrollHeight - el.lista.scrollTop;
  if (audioTocando) audioTocando.pausar();

  for (const filho of [...el.lista.children]) if (!FIXOS.has(filho)) filho.remove();

  const frag = document.createDocumentFragment();
  let anterior = null;
  for (const m of estado.mensagens) {
    if (!anterior || !mesmoDia(anterior.createdAt, m.createdAt)) frag.append(criarSeparadorDia(m.createdAt));
    frag.append(criarElemento(m, anterior));
    anterior = m;
  }
  el.lista.insertBefore(frag, el.digitando);
  el.vazio.hidden = estado.mensagens.length > 0;

  el.lista.scrollTop = el.lista.scrollHeight - distanciaDoFim;
}

/** Acrescenta uma mensagem no final, sem refazer a lista. */
function anexar(m) {
  const anterior = estado.mensagens[estado.mensagens.length - 1];
  estado.mensagens.push(m);

  const frag = document.createDocumentFragment();
  if (!anterior || !mesmoDia(anterior.createdAt, m.createdAt)) frag.append(criarSeparadorDia(m.createdAt));
  frag.append(criarElemento(m, anterior));
  el.lista.insertBefore(frag, el.digitando);
  el.vazio.hidden = true;
}

const linhaDe = (m) => el.lista.querySelector(`.msg[data-chave="${CSS.escape(chave(m))}"]`);

/** Atualiza só o rodapé da bolha (horário, ✓, "editada") sem mexer em fotos e áudios. */
function atualizarMeta(m) {
  const linha = linhaDe(m);
  if (!linha) return;
  const noFim = estaNoFim(); // a bolha pode mudar de altura (ex.: "Não enviada…" quebra a linha)
  linha.classList.toggle('falhou', Boolean(m.falhou));
  const antigo = linha.querySelector('.bolha > .meta');
  if (antigo) antigo.replaceWith(criarMeta(m));
  const acoes = linha.querySelector('.acoes-btn');
  if (acoes) acoes.hidden = !temAcoes(m);
  if (noFim) rolarParaFim();
}

/** Refaz o conteúdo da bolha (edição, exclusão). */
function atualizarConteudo(m) {
  const linha = linhaDe(m);
  if (!linha) return;
  const noFim = estaNoFim();
  preencherBolha(linha.querySelector('.bolha'), m);
  atualizarMeta(m);
  if (noFim) rolarParaFim();
}

function porChave(k) {
  return estado.mensagens.find((m) => chave(m) === k);
}

/** Junta listas de mensagens sem duplicar, mantendo a ordem. */
function mesclar(atuais, novas) {
  const mapa = new Map(atuais.map((m) => [chave(m), m]));
  for (const m of novas) {
    const existente = mapa.get(chave(m));
    if (existente) Object.assign(existente, m, m.id ? { pendente: false, falhou: false } : {});
    else mapa.set(chave(m), m);
  }
  return [...mapa.values()].sort((a, b) => (a.id ?? Infinity) - (b.id ?? Infinity));
}

// ---------------------------------------------------------------------------
// Cabeçalho, título e avisos
// ---------------------------------------------------------------------------

function renderizarStatus() {
  const { online, lastSeen } = estado.presenca;
  const conectado = estado.socket && estado.socket.connected;

  let texto;
  if (!conectado) texto = 'conectando…';
  else if (estado.parceiroDigitando) texto = 'digitando…';
  else if (online) texto = 'online';
  else if (lastSeen) texto = 'visto por último ' + quando(lastSeen);
  else texto = 'offline';

  el.status.textContent = texto;
  el.avatar.classList.toggle('online', Boolean(conectado && online));
  el.faixa.hidden = conectado || !estado.jaConectou;
}

const contarNaoLidas = () => estado.mensagens.filter((m) => !ehMinha(m) && !m.readAt && !m.apagada).length;

function atualizarTitulo() {
  const n = contarNaoLidas();
  document.title = n > 0 ? `(${n}) ${NOME_APP}` : NOME_APP;
  try {
    if (navigator.setAppBadge) (n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  } catch {
    /* recurso opcional */
  }
}

function atualizarBotaoFim() {
  const n = contarNaoLidas();
  el.irFim.hidden = estaNoFim();
  el.irFimTexto.textContent = n > 0 ? (n === 1 ? '1 nova mensagem' : `${n} novas mensagens`) : 'Ir para o fim';
}

/** Avisa que li as mensagens (só se a página está à frente e a conversa está no fim). */
function confirmarLeitura() {
  if (!naFrente() || !estaNoFim() || contarNaoLidas() === 0) return;
  const agora = new Date().toISOString();
  for (const m of estado.mensagens) if (!ehMinha(m) && !m.readAt) m.readAt = agora;
  if (estado.socket) estado.socket.emit('messages:read');
  atualizarTitulo();
  atualizarBotaoFim();
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

async function transmitir(m) {
  m.pendente = true;
  m.falhou = false;
  atualizarMeta(m);

  const marcarFalha = (texto) => {
    const atual = porChave(m.clientId) || m;
    if (atual.id) return; // já foi confirmada por outro caminho
    atual.pendente = false;
    atual.falhou = true;
    atualizarMeta(atual);
    if (texto) toast(texto);
  };

  try {
    if (m.midiaPendente) await subirArquivo(m.mediaId, m.midiaPendente);
  } catch (e) {
    if (e.message !== 'não autenticado') marcarFalha(e.message);
    return;
  }

  const resp = await emitirComAck('message:send', { clientId: m.clientId, dados: m.dados });
  if (!resp.ok) return marcarFalha(resp.erro && resp.erro !== 'Sem resposta do servidor. Tente de novo.' ? resp.erro : '');

  const atual = porChave(m.clientId) || m;
  Object.assign(atual, resp.mensagem, { pendente: false, falhou: false });
  delete atual.midiaPendente;
  atualizarMeta(atual);
}

/** Mostra a bolha na hora e envia. `extra.midiaPendente` é a foto/áudio (Blob) que ainda precisa subir. */
function criarEEnviar(dados, extra = {}) {
  const m = {
    id: null,
    clientId: gerarId(),
    sender: estado.eu.login,
    dados,
    mediaId: extra.mediaId || null,
    midiaPendente: extra.midiaPendente || null,
    createdAt: new Date().toISOString(),
    deliveredAt: null,
    readAt: null,
    editedAt: null,
    deletedAt: null,
    pendente: true,
    falhou: false,
    apagada: false,
    ilegivel: false,
  };
  anexar(m);
  rolarParaFim(true);
  transmitir(m);
}

function instantaneoResposta(m) {
  return { ref: m.clientId, de: m.sender, snip: resumo(m.dados) };
}

function anexarResposta(dados) {
  if (estado.respondendo && temAcoes(estado.respondendo)) dados.reply = instantaneoResposta(estado.respondendo);
  return dados;
}

async function enviarTexto() {
  const texto = el.campo.value.trim();
  if (!texto || !estado.eu || !estado.socket) return;
  if (estado.editando) return salvarEdicao(texto);

  const dados = anexarResposta({ v: 1, t: 'text', text: texto });
  limparContexto();
  el.campo.value = '';
  ajustarAlturaCampo();
  pararDeDigitar();
  atualizarBotoesComposer();
  el.campo.focus();
  criarEEnviar(dados);
}

// ---------------------------------------------------------------------------
// Responder, editar e apagar
// ---------------------------------------------------------------------------

function mostrarContexto(titulo, previa) {
  el.contextoTitulo.textContent = titulo;
  el.contextoPrevia.textContent = previa;
  el.contexto.hidden = false;
}

function limparContexto() {
  estado.respondendo = null;
  estado.editando = null;
  el.contexto.hidden = true;
  atualizarBotoesComposer();
}

function iniciarResposta(m) {
  if (estado.editando) {
    estado.editando = null;
    el.campo.value = '';
    ajustarAlturaCampo();
  }
  estado.respondendo = m;
  mostrarContexto(`Respondendo a ${nomeDe(m.sender)}`, resumo(m.dados));
  atualizarBotoesComposer();
  el.campo.focus();
}

function iniciarEdicao(m) {
  estado.respondendo = null;
  estado.editando = m;
  mostrarContexto('Editando mensagem', m.dados.text);
  el.campo.value = m.dados.text;
  ajustarAlturaCampo();
  atualizarBotoesComposer();
  el.campo.focus();
  el.campo.setSelectionRange(el.campo.value.length, el.campo.value.length);
}

async function salvarEdicao(texto) {
  const m = estado.editando;
  if (!m || !m.id || m.apagada) return limparContexto();
  if (texto === m.dados.text) {
    limparContexto();
    el.campo.value = '';
    ajustarAlturaCampo();
    return atualizarBotoesComposer();
  }

  el.enviar.disabled = true;
  try {
    const novos = { ...m.dados, text: texto };
    const resp = await emitirComAck('message:edit', { id: m.id, dados: novos });
    if (!resp.ok) return toast(resp.erro || 'Não foi possível editar.');

    Object.assign(m, { dados: resp.dados, editedAt: resp.editedAt });
    atualizarConteudo(m);
    limparContexto();
    el.campo.value = '';
    ajustarAlturaCampo();
  } catch (e) {
    console.error(e);
    toast('Não foi possível editar.');
  } finally {
    atualizarBotoesComposer();
  }
}

function aplicarExclusao(m, quandoIso) {
  if (m.pararAudio) m.pararAudio();
  const arquivo = m.dados && m.dados.media && m.dados.media.id;
  if (arquivo) esquecerArquivo(arquivo);
  Object.assign(m, { deletedAt: quandoIso, apagada: true, dados: null, mediaId: null, midiaPendente: null });
  if (estado.respondendo === m || estado.editando === m) {
    const editando = estado.editando === m;
    limparContexto();
    if (editando) {
      el.campo.value = '';
      ajustarAlturaCampo();
      atualizarBotoesComposer();
    }
  }
  atualizarConteudo(m);
  atualizarTitulo();
  atualizarBotaoFim();
}

async function confirmarApagar(m) {
  const ok = await confirmar('Apagar esta mensagem para todos? Isso não pode ser desfeito.');
  if (!ok || m.apagada) return;
  const resp = await emitirComAck('message:delete', { id: m.id });
  if (!resp.ok) return toast(resp.erro || 'Não foi possível apagar.');
  aplicarExclusao(m, resp.deletedAt);
}

async function copiar(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    toast('Copiado');
  } catch {
    toast('Não foi possível copiar.');
  }
}

function irParaMensagem(ref) {
  const alvo = el.lista.querySelector(`.msg[data-chave="${CSS.escape(ref)}"]`);
  if (!alvo) return toast('Essa mensagem é mais antiga. Role para cima para carregá-la.');
  alvo.scrollIntoView({ block: 'center', behavior: reduzMovimento ? 'auto' : 'smooth' });
  alvo.classList.remove('destacada');
  void alvo.offsetWidth; // reinicia a animação
  alvo.classList.add('destacada');
  setTimeout(() => alvo.classList.remove('destacada'), 1600);
}

// --- Menu de ações da mensagem ---
function fecharMenuMsg() {
  el.menuMsg.hidden = true;
  el.menuMsg.replaceChildren();
}

function abrirMenuMsg(m, ancora) {
  if (!temAcoes(m)) return;
  const itens = [['Responder', () => iniciarResposta(m)]];
  if (m.dados.t === 'text') itens.push(['Copiar texto', () => copiar(m.dados.text)]);
  if (ehMinha(m) && m.dados.t === 'text') itens.push(['Editar', () => iniciarEdicao(m)]);
  if (ehMinha(m)) itens.push(['Apagar para todos', () => confirmarApagar(m), 'perigo']);

  el.menuMsg.replaceChildren();
  for (const [rotulo, fn, classe] of itens) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = rotulo;
    if (classe) b.className = classe;
    b.addEventListener('click', () => {
      fecharMenuMsg();
      fn();
    });
    el.menuMsg.append(b);
  }
  el.menuMsg.hidden = false;

  if (!ehToque()) {
    const r = ancora.getBoundingClientRect();
    const mw = el.menuMsg.offsetWidth;
    const mh = el.menuMsg.offsetHeight;
    let left = ehMinha(m) ? r.right - mw : r.left;
    let top = r.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
    left = Math.min(Math.max(8, left), window.innerWidth - mw - 8);
    el.menuMsg.style.left = `${left}px`;
    el.menuMsg.style.top = `${top}px`;
  }
  el.menuMsg.querySelector('button')?.focus({ preventScroll: true });
}

document.addEventListener('click', (ev) => {
  if (!el.menuMsg.hidden && !el.menuMsg.contains(ev.target)) fecharMenuMsg();
  if (!el.menuConta.hidden && !ev.target.closest('.menu-conta')) fecharMenuConta();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (!el.menuMsg.hidden) fecharMenuMsg();
  else if (!el.menuConta.hidden) fecharMenuConta();
  else if (estado.editando || estado.respondendo) cancelarContexto();
});
el.lista.addEventListener('scroll', fecharMenuMsg, { passive: true });

function cancelarContexto() {
  const editando = Boolean(estado.editando);
  limparContexto();
  if (editando) {
    el.campo.value = '';
    ajustarAlturaCampo();
  }
  atualizarBotoesComposer();
}
$('contexto-fechar').addEventListener('click', cancelarContexto);

// Cliques dentro da lista: ações, citações e (no celular) toque na bolha
el.lista.addEventListener('click', (ev) => {
  const linha = ev.target.closest && ev.target.closest('.msg[data-chave]');
  if (!linha) return;
  const m = porChave(linha.dataset.chave);
  if (!m) return;

  if (m.falhou) return void transmitir(m);

  const cit = ev.target.closest('.citacao');
  if (cit) return irParaMensagem(cit.dataset.ref);

  const acoes = ev.target.closest('.acoes-btn');
  if (acoes) {
    ev.stopPropagation();
    return abrirMenuMsg(m, acoes);
  }

  // No celular, tocar na bolha abre o menu (menos em links, fotos e áudios)
  if (ehToque() && ev.target.closest('.bolha') && !ev.target.closest('a, button, .onda')) {
    ev.stopPropagation();
    abrirMenuMsg(m, linha.querySelector('.bolha'));
  }
});

// --- Deslizar para responder (celular) ---
let deslize = null;

el.lista.addEventListener(
  'touchstart',
  (ev) => {
    if (ev.touches.length !== 1) return;
    const linha = ev.target.closest('.msg[data-chave]');
    const m = linha && porChave(linha.dataset.chave);
    if (!m || !temAcoes(m)) return;
    const t = ev.touches[0];
    deslize = { linha, m, x: t.clientX, y: t.clientY, dx: 0, ativo: false, bolha: linha.querySelector('.bolha'), dica: null };
  },
  { passive: true }
);

el.lista.addEventListener(
  'touchmove',
  (ev) => {
    if (!deslize) return;
    const t = ev.touches[0];
    const dx = t.clientX - deslize.x;
    const dy = t.clientY - deslize.y;

    if (!deslize.ativo) {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) return void (deslize = null); // é rolagem
      if (dx > 14 && dx > Math.abs(dy) * 1.5) {
        deslize.ativo = true;
        deslize.bolha.classList.remove('solta');
        const dica = document.createElement('span');
        dica.className = 'dica-responder';
        dica.innerHTML = ICONES.responder;
        deslize.linha.append(dica);
        deslize.dica = dica;
        fecharMenuMsg();
      } else {
        return;
      }
    }
    deslize.dx = Math.max(0, Math.min(dx, 90));
    deslize.bolha.style.transform = `translateX(${deslize.dx}px)`;
    deslize.dica.style.opacity = String(Math.min(1, deslize.dx / 60));
  },
  { passive: true }
);

function terminarDeslize() {
  if (deslize && deslize.ativo) {
    const { m, bolha, dica, dx } = deslize;
    bolha.classList.add('solta');
    bolha.style.transform = '';
    dica.remove();
    if (dx >= 60) {
      if (navigator.vibrate) navigator.vibrate(12);
      iniciarResposta(m);
    }
  }
  deslize = null;
}
el.lista.addEventListener('touchend', terminarDeslize, { passive: true });
el.lista.addEventListener('touchcancel', terminarDeslize, { passive: true });

// ---------------------------------------------------------------------------
// Campo de texto e botões do compositor
// ---------------------------------------------------------------------------

function atualizarBotoesComposer() {
  const vazio = el.campo.value.trim() === '';
  const editando = Boolean(estado.editando);
  el.enviar.hidden = vazio && !editando;
  el.enviar.disabled = vazio;
  el.mic.hidden = !vazio || editando;
  el.enviar.setAttribute('aria-label', editando ? 'Salvar edição' : 'Enviar mensagem');
  el.anexar.hidden = editando;
}

function ajustarAlturaCampo() {
  const noFim = estaNoFim();
  el.campo.style.height = 'auto';
  el.campo.style.height = Math.min(el.campo.scrollHeight + 2, 140) + 'px';
  if (noFim) rolarParaFim();
}

let temporizadorDigitando = null;
let souDigitando = false;
let ultimoAvisoDigitando = 0;

function aoDigitar() {
  atualizarBotoesComposer();
  ajustarAlturaCampo();

  if (!el.campo.value) return pararDeDigitar();
  const agora = Date.now();
  if (!souDigitando || agora - ultimoAvisoDigitando > 2000) {
    souDigitando = true;
    ultimoAvisoDigitando = agora;
    if (estado.socket) estado.socket.emit('typing', true);
  }
  clearTimeout(temporizadorDigitando);
  temporizadorDigitando = setTimeout(pararDeDigitar, 2500);
}

function pararDeDigitar() {
  clearTimeout(temporizadorDigitando);
  if (souDigitando) {
    souDigitando = false;
    if (estado.socket) estado.socket.emit('typing', false);
  }
}

el.campo.addEventListener('input', aoDigitar);
el.campo.addEventListener('keydown', (ev) => {
  // Computador: Enter envia, Shift+Enter quebra linha. Celular: Enter quebra linha.
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && !ehToque()) {
    ev.preventDefault();
    enviarTexto();
  }
});
el.form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  enviarTexto();
});

// ---------------------------------------------------------------------------
// Fotos
// ---------------------------------------------------------------------------

el.anexar.addEventListener('click', () => el.arquivoFoto.click());

el.arquivoFoto.addEventListener('change', async () => {
  const arquivo = el.arquivoFoto.files && el.arquivoFoto.files[0];
  el.arquivoFoto.value = '';
  if (!arquivo) return;
  if (!estado.socket) return toast('Aguarde a conexão.');

  let foto;
  try {
    foto = await prepararFoto(arquivo);
  } catch (e) {
    return toast(e.message);
  }

  const dlg = $('dlg-foto');
  const previa = URL.createObjectURL(foto.blob);
  $('foto-previa').src = previa;
  $('foto-legenda').value = '';
  dlg.returnValue = '';
  dlg.addEventListener(
    'close',
    () => {
      URL.revokeObjectURL(previa);
      $('foto-previa').removeAttribute('src');
      if (dlg.returnValue === 'enviar') enviarFoto(foto, $('foto-legenda').value.trim());
    },
    { once: true }
  );
  dlg.showModal();
  $('foto-legenda').focus();
});

async function enviarFoto(foto, legenda) {
  try {
    const mediaId = crypto.randomUUID();
    registrarLocal(mediaId, foto.blob); // a foto aparece na hora, sem baixar de novo

    const dados = { v: 1, t: 'image', media: { id: mediaId, mime: foto.mime, w: foto.w, h: foto.h, size: foto.blob.size, thumb: foto.thumb } };
    if (legenda) dados.text = legenda;
    anexarResposta(dados);
    limparContexto();
    criarEEnviar(dados, { mediaId, midiaPendente: foto.blob });
  } catch (e) {
    console.error(e);
    toast('Não foi possível enviar a foto.');
  }
}

$('form-foto').addEventListener('submit', () => {}); // o <dialog> cuida do resto
$('lightbox-fechar').addEventListener('click', () => $('dlg-lightbox').close());
$('dlg-lightbox').addEventListener('click', (ev) => {
  if (ev.target.id === 'dlg-lightbox' || ev.target.id === 'lightbox-img') $('dlg-lightbox').close();
});
$('dlg-lightbox').addEventListener('close', () => $('lightbox-img').removeAttribute('src'));

// ---------------------------------------------------------------------------
// Áudio
// ---------------------------------------------------------------------------

let temporizadorGravacao = null;

function mostrarGravacao(sim) {
  el.gravacao.hidden = !sim;
  el.form.hidden = sim;
}

async function comecarGravacao() {
  if (!gravacaoSuportada()) return toast('Este navegador não permite gravar áudio.');
  if (!estado.socket) return toast('Aguarde a conexão.');
  try {
    estado.gravador = await iniciarGravacao(() => {
      toast(`Limite de ${Math.floor(LIMITE_GRAVACAO_SEG / 60)} minutos atingido. Enviando…`);
      terminarGravacao(true);
    });
  } catch (e) {
    return toast(
      e && e.name === 'NotAllowedError'
        ? 'Permita o uso do microfone nas configurações do navegador.'
        : 'Não foi possível acessar o microfone.'
    );
  }
  mostrarGravacao(true);
  el.gravTempo.textContent = '0:00';
  temporizadorGravacao = setInterval(() => {
    if (estado.gravador) el.gravTempo.textContent = fmtDuracao(estado.gravador.segundos());
  }, 250);
}

async function terminarGravacao(enviar) {
  const g = estado.gravador;
  if (!g) return;
  estado.gravador = null;
  clearInterval(temporizadorGravacao);
  mostrarGravacao(false);

  if (!enviar) return g.cancelar();

  try {
    const r = await g.parar();
    if (r.dur < 0.7) return toast('Gravação muito curta.');

    const mediaId = crypto.randomUUID();
    registrarLocal(mediaId, r.blob);

    const dados = { v: 1, t: 'audio', media: { id: mediaId, mime: r.mime, size: r.blob.size, dur: r.dur, wave: r.wave } };
    anexarResposta(dados);
    limparContexto();
    criarEEnviar(dados, { mediaId, midiaPendente: r.blob });
  } catch (e) {
    console.error(e);
    toast('Não foi possível enviar o áudio.');
  }
}

el.mic.addEventListener('click', comecarGravacao);
$('grav-cancelar').addEventListener('click', () => terminarGravacao(false));
$('grav-enviar').addEventListener('click', () => terminarGravacao(true));

// ---------------------------------------------------------------------------
// Rolagem, histórico e sincronização
// ---------------------------------------------------------------------------

let noFimAntes = true;
let agendado = false;

el.lista.addEventListener(
  'scroll',
  () => {
    if (agendado) return;
    agendado = true;
    requestAnimationFrame(() => {
      agendado = false;
      noFimAntes = estaNoFim();
      atualizarBotaoFim();
      if (noFimAntes) confirmarLeitura();
      if (el.lista.scrollTop < 120 && estado.temMais && !estado.carregandoAntigas) carregarAntigas();
    });
  },
  { passive: true }
);

el.irFim.addEventListener('click', () => {
  rolarParaFim(true);
  setTimeout(confirmarLeitura, reduzMovimento ? 0 : 350);
});

/** Mostra/esconde o aviso do topo sem "empurrar" o que está na tela. */
function alternarTopo(mostrar) {
  const distanciaDoFim = el.lista.scrollHeight - el.lista.scrollTop;
  el.topo.hidden = !mostrar;
  el.lista.scrollTop = el.lista.scrollHeight - distanciaDoFim;
}

async function carregarAntigas() {
  const primeira = estado.mensagens.find((m) => m.id);
  if (!primeira) return;
  estado.carregandoAntigas = true;
  alternarTopo(true);
  try {
    const r = await api(`/api/messages?before=${primeira.id}&limit=50`);
    r.mensagens.forEach(decodificar);
    estado.temMais = r.temMais;
    estado.mensagens = mesclar(estado.mensagens, r.mensagens);
    el.topo.hidden = true; // antes de refazer a lista, para a posição ser calculada já sem o aviso
    renderizarTudo();
  } catch (e) {
    console.warn('Falha ao carregar mensagens antigas', e);
    alternarTopo(false);
  } finally {
    estado.carregandoAntigas = false;
  }
}

/** Depois de uma reconexão: busca as últimas mensagens e junta com o que já temos. */
async function sincronizar() {
  try {
    const r = await api('/api/messages?limit=100');
    r.mensagens.forEach(decodificar);
    const noFim = estaNoFim();
    estado.mensagens = mesclar(estado.mensagens, r.mensagens);
    renderizarTudo();
    if (noFim) rolarParaFim();
    confirmarLeitura();
    atualizarTitulo();
    atualizarBotaoFim();
  } catch (e) {
    console.warn('Falha ao sincronizar', e);
  }
}

// Teclado virtual no iPhone: ajusta a altura do app à área realmente visível.
if (window.visualViewport) {
  const ajustar = () => {
    el.app.style.setProperty('--vh', window.visualViewport.height + 'px');
    window.scrollTo(0, 0);
    if (noFimAntes) rolarParaFim();
  };
  window.visualViewport.addEventListener('resize', ajustar);
  window.visualViewport.addEventListener('scroll', () => window.scrollTo(0, 0));
  ajustar();
}

// ---------------------------------------------------------------------------
// Notificações
// ---------------------------------------------------------------------------

const podeNotificar = 'Notification' in window;

function lerPreferencia() {
  try {
    return localStorage.getItem('aviso-notif');
  } catch {
    return null;
  }
}
function gravarPreferencia(v) {
  try {
    localStorage.setItem('aviso-notif', v);
  } catch {
    /* sem armazenamento */
  }
}

function mostrarConviteNotificacao() {
  if (podeNotificar && Notification.permission === 'default' && lerPreferencia() !== 'nao') el.avisoNotif.hidden = false;
}

$('notif-sim').addEventListener('click', async () => {
  el.avisoNotif.hidden = true;
  try {
    await Notification.requestPermission();
  } catch {
    /* ignorado */
  }
});
$('notif-nao').addEventListener('click', () => {
  gravarPreferencia('nao');
  el.avisoNotif.hidden = true;
});

function notificar(m) {
  if (!podeNotificar || Notification.permission !== 'granted' || naFrente() || !m.dados) return;
  const d = m.dados;
  const texto = d.t === 'image' ? d.text || 'Enviou uma foto' : d.t === 'audio' ? 'Enviou uma mensagem de voz' : d.text;
  const corpo = texto.length > 120 ? texto.slice(0, 117) + '…' : texto;
  const opcoes = { body: corpo, tag: 'nova-mensagem', renotify: true, icon: '/icons/icon-192.png' };

  // No Android, notificações precisam passar pelo service worker.
  const viaSw = navigator.serviceWorker
    ? navigator.serviceWorker.ready.then((reg) => reg.showNotification(estado.parceiro.nome, opcoes))
    : Promise.reject();
  viaSw.catch(() => {
    try {
      new Notification(estado.parceiro.nome, opcoes);
    } catch {
      /* ignorado */
    }
  });
}

// ---------------------------------------------------------------------------
// Conexão em tempo real
// ---------------------------------------------------------------------------

let temporizadorParceiroDigitando = null;

function definirParceiroDigitando(valor) {
  estado.parceiroDigitando = valor;
  clearTimeout(temporizadorParceiroDigitando);
  if (valor) temporizadorParceiroDigitando = setTimeout(() => definirParceiroDigitando(false), 5000);

  const noFim = estaNoFim();
  el.digitando.hidden = !valor;
  if (valor && noFim) rolarParaFim(true);
  renderizarStatus();
}

function conectar() {
  const socket = io({ transports: ['websocket', 'polling'] });
  estado.socket = socket;

  socket.on('connect', () => {
    const reconexao = estado.jaConectou;
    estado.jaConectou = true;
    renderizarStatus();
    if (reconexao) {
      sincronizar();
      // Mensagens que falharam durante a queda são reenviadas sozinhas (o envio é idempotente).
      for (const m of estado.mensagens) if (m.falhou) transmitir(m);
    } else {
      confirmarLeitura();
    }
  });

  socket.on('disconnect', () => {
    definirParceiroDigitando(false);
    renderizarStatus();
  });

  socket.on('connect_error', (err) => {
    if (err && /autenticado/.test(err.message)) {
      window.location.replace('/login'); // sessão expirou
      return;
    }
    renderizarStatus();
  });

  socket.on('presence', (p) => {
    estado.presenca = p;
    renderizarStatus();
  });

  socket.on('typing', definirParceiroDigitando);

  socket.on('message:new', (m) => {
    if (porChave(chave(m))) return; // já temos
    decodificar(m);

    const noFim = estaNoFim();
    definirParceiroDigitando(false);
    anexar(m);

    if (!ehMinha(m)) {
      if (naFrente() && noFim) {
        rolarParaFim(true);
        confirmarLeitura();
      } else {
        notificar(m);
        if (noFim) rolarParaFim(true);
      }
    } else if (noFim) {
      rolarParaFim(true);
    }
    atualizarTitulo();
    atualizarBotaoFim();
  });

  socket.on('message:edited', (d) => {
    const m = estado.mensagens.find((x) => x.id === d.id);
    if (!m || m.apagada) return;
    Object.assign(m, { dados: d.dados, editedAt: d.editedAt });
    decodificar(m);
    atualizarConteudo(m);
  });

  socket.on('message:deleted', (d) => {
    const m = estado.mensagens.find((x) => x.id === d.id);
    if (m && !m.apagada) aplicarExclusao(m, d.deletedAt);
  });

  socket.on('messages:delivered', ({ ids, at }) => {
    const conjunto = new Set(ids);
    for (const m of estado.mensagens) {
      if (m.id && conjunto.has(m.id) && !m.deliveredAt) {
        m.deliveredAt = at;
        atualizarMeta(m);
      }
    }
  });

  socket.on('messages:read', ({ ids, at }) => {
    const conjunto = new Set(ids);
    for (const m of estado.mensagens) {
      if (m.id && conjunto.has(m.id) && !m.readAt) {
        m.readAt = at;
        m.deliveredAt = m.deliveredAt || at;
        atualizarMeta(m);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Menu da conta e eventos da página
// ---------------------------------------------------------------------------

function fecharMenuConta() {
  el.menuConta.hidden = true;
  el.menuBtn.setAttribute('aria-expanded', 'false');
}

el.menuBtn.addEventListener('click', async (ev) => {
  ev.stopPropagation();
  const abrir = el.menuConta.hidden;
  el.menuConta.hidden = !abrir;
  el.menuBtn.setAttribute('aria-expanded', String(abrir));
  if (!abrir) return;
  try {
    const { usadoBytes, limiteBytes } = await api('/api/armazenamento');
    el.menuEspaco.textContent = `Espaço usado no banco: ${fmtBytes(usadoBytes)} de ${fmtBytes(limiteBytes)}`;
  } catch {
    el.menuEspaco.textContent = 'Espaço usado indisponível.';
  }
});

$('sair').addEventListener('click', async () => {
  $('sair').disabled = true;
  try {
    if (estado.socket) estado.socket.disconnect();
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  } finally {
    window.location.replace('/login');
  }
});

function aoVoltarParaPagina() {
  if (document.visibilityState !== 'visible') return;
  if (estado.socket && !estado.socket.connected) estado.socket.connect();
  confirmarLeitura();
  atualizarTitulo();
}
document.addEventListener('visibilitychange', aoVoltarParaPagina);
window.addEventListener('focus', aoVoltarParaPagina);

// ---------------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------------

async function iniciar() {
  try {
    const eu = await api('/api/me');
    estado.eu = eu.eu;
    estado.parceiro = eu.parceiro;
    el.nome.textContent = eu.parceiro.nome;
    el.inicial.textContent = Array.from(eu.parceiro.nome.trim())[0]?.toUpperCase() || '?';

    const r = await api('/api/messages?limit=50');
    r.mensagens.forEach(decodificar);
    estado.mensagens = r.mensagens;
    estado.temMais = r.temMais;
    renderizarTudo();
    rolarParaFim();
    atualizarTitulo();
    atualizarBotoesComposer();

    conectar();
    mostrarConviteNotificacao();
    // No celular, não abre o teclado sozinho.
    if (!ehToque()) el.campo.focus({ preventScroll: true });
  } catch (e) {
    if (e.message !== 'não autenticado') {
      el.status.textContent = 'não foi possível carregar. Recarregue a página.';
      console.error(e);
    }
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
iniciar();
