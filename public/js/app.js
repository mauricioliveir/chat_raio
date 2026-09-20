(() => {
  'use strict';

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
    nome: $('nome-parceiro'),
    inicial: $('inicial'),
    avatar: $('avatar'),
    status: $('status'),
    sair: $('sair'),
    irFim: $('ir-fim'),
    irFimTexto: $('ir-fim-texto'),
    faixa: $('faixa'),
    avisoNotif: $('aviso-notif'),
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
  };

  const reduzMovimento = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------------------
  // Utilidades
  // ------------------------------------------------------------------------

  function gerarId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    // Fallback para páginas em http (ex.: teste pela rede local), onde randomUUID não existe.
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  const chave = (m) => m.clientId || 'id-' + m.id;
  const ehMinha = (m) => m.sender === estado.eu.login;

  const fmtHora = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const fmtDia = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
  const fmtDiaCurto = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });

  const hora = (iso) => fmtHora.format(new Date(iso));

  function inicioDoDia(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  const mesmoDia = (a, b) => inicioDoDia(new Date(a)) === inicioDoDia(new Date(b));

  function diasDeDiferenca(iso) {
    return Math.round((inicioDoDia(new Date()) - inicioDoDia(new Date(iso))) / 86_400_000);
  }

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

  const naFrente = () => document.visibilityState === 'visible' && document.hasFocus();

  async function api(caminho) {
    const resp = await fetch(caminho, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (resp.status === 401) {
      window.location.replace('/login');
      throw new Error('não autenticado');
    }
    if (!resp.ok) throw new Error('Erro ' + resp.status);
    return resp.json();
  }

  // ------------------------------------------------------------------------
  // Ícones de status (SVG estático, sem dados do usuário)
  // ------------------------------------------------------------------------

  const ICONES = {
    enviando:
      '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.6V8l2.3 1.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    enviada:
      '<svg viewBox="0 0 17 16" width="16" height="15"><path d="M3 8.5l3.5 3.5L13 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    entregue:
      '<svg viewBox="0 0 17 16" width="16" height="15"><path d="M1.5 8.5L5 12l6.5-7M8.5 11.6l.6.4L15.5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    falhou:
      '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.8v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.1" r="0.9" fill="currentColor"/></svg>',
  };
  ICONES.lida = ICONES.entregue;

  const ROTULOS = {
    enviando: 'Enviando',
    enviada: 'Enviada',
    entregue: 'Entregue',
    lida: 'Lida',
    falhou: 'Não enviada',
  };

  function statusDe(m) {
    if (m.falhou) return 'falhou';
    if (m.pendente) return 'enviando';
    if (m.readAt) return 'lida';
    if (m.deliveredAt) return 'entregue';
    return 'enviada';
  }

  // ------------------------------------------------------------------------
  // Renderização
  // ------------------------------------------------------------------------

  const URL_RE = /https?:\/\/[^\s<>"']+/gi;

  /** Monta o texto da mensagem. Só usa textContent: nada do usuário vira HTML. */
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
      const t = document.createElement('time');
      t.dateTime = m.createdAt;
      t.textContent = hora(m.createdAt);
      meta.append(t);
    }

    if (ehMinha(m)) {
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
    bolha.className = 'bolha';
    bolha.append(criarTexto(m.body), criarMeta(m));
    linha.append(bolha);
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

  /** Refaz a lista inteira mantendo a posição de rolagem em relação ao final. */
  function renderizarTudo() {
    const distanciaDoFim = el.lista.scrollHeight - el.lista.scrollTop;

    for (const filho of [...el.lista.children]) {
      if (filho !== el.topo && filho !== el.vazio && filho !== el.digitando) filho.remove();
    }

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

  /** Atualiza a bolha de uma mensagem (horário, ✓ e estado de falha). */
  function atualizarBolha(m) {
    const linha = el.lista.querySelector(`.msg[data-chave="${CSS.escape(chave(m))}"]`);
    if (!linha) return;
    linha.classList.toggle('falhou', Boolean(m.falhou));
    const bolha = linha.querySelector('.bolha');
    bolha.querySelector('.meta').replaceWith(criarMeta(m));
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

  // ------------------------------------------------------------------------
  // Cabeçalho, título e avisos
  // ------------------------------------------------------------------------

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
    el.faixa.hidden = conectado || !estado.jaConectou; // só mostra a faixa se já estava conectado antes
  }

  function contarNaoLidas() {
    return estado.mensagens.filter((m) => !ehMinha(m) && !m.readAt).length;
  }

  function atualizarTitulo() {
    const n = contarNaoLidas();
    document.title = n > 0 ? `(${n}) ${NOME_APP}` : NOME_APP;
    try {
      if (navigator.setAppBadge) (n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
    } catch { /* recurso opcional */ }
  }

  function atualizarBotaoFim() {
    const n = contarNaoLidas();
    const mostrar = !estaNoFim();
    el.irFim.hidden = !mostrar;
    el.irFimTexto.textContent = n > 0 ? (n === 1 ? '1 nova mensagem' : `${n} novas mensagens`) : 'Ir para o fim';
  }

  // ------------------------------------------------------------------------
  // Leitura
  // ------------------------------------------------------------------------

  /** Avisa que li as mensagens (só se a página está à frente e a conversa está no fim). */
  function confirmarLeitura() {
    if (!naFrente() || !estaNoFim() || contarNaoLidas() === 0) return;
    const agora = new Date().toISOString();
    for (const m of estado.mensagens) if (!ehMinha(m) && !m.readAt) m.readAt = agora;
    if (estado.socket) estado.socket.emit('messages:read');
    atualizarTitulo();
    atualizarBotaoFim();
  }

  // ------------------------------------------------------------------------
  // Envio
  // ------------------------------------------------------------------------

  function transmitir(m) {
    m.pendente = true;
    m.falhou = false;
    atualizarBolha(m);

    estado.socket.timeout(20_000).emit('message:send', { body: m.body, clientId: m.clientId }, (err, resp) => {
      const atual = porChave(m.clientId) || m;
      if (err || !resp || !resp.ok) {
        // Só marca falha se a mensagem ainda não tiver sido confirmada por outro caminho.
        if (!atual.id) {
          atual.pendente = false;
          atual.falhou = true;
          atualizarBolha(atual);
        }
        return;
      }
      Object.assign(atual, resp.mensagem, { pendente: false, falhou: false });
      atualizarBolha(atual);
    });
  }

  function enviarMensagem() {
    const corpo = el.campo.value.trim();
    if (!corpo || !estado.eu || !estado.socket) return;

    const m = {
      id: null,
      clientId: gerarId(),
      sender: estado.eu.login,
      body: corpo,
      createdAt: new Date().toISOString(),
      deliveredAt: null,
      readAt: null,
      pendente: true,
      falhou: false,
    };

    anexar(m);
    rolarParaFim(true);

    el.campo.value = '';
    ajustarAlturaCampo();
    pararDeDigitar();
    el.enviar.disabled = true;
    el.campo.focus();

    transmitir(m);
  }

  // Toque numa mensagem que falhou = tentar de novo
  el.lista.addEventListener('click', (ev) => {
    const linha = ev.target.closest && ev.target.closest('.msg.falhou');
    if (!linha) return;
    const m = porChave(linha.dataset.chave);
    if (m && m.falhou) transmitir(m);
  });

  // ------------------------------------------------------------------------
  // Campo de texto
  // ------------------------------------------------------------------------

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
    el.enviar.disabled = el.campo.value.trim() === '';
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
    const ehToque = window.matchMedia('(pointer: coarse)').matches;
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && !ehToque) {
      ev.preventDefault();
      enviarMensagem();
    }
  });
  el.form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    enviarMensagem();
  });

  // ------------------------------------------------------------------------
  // Rolagem
  // ------------------------------------------------------------------------

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

  // ------------------------------------------------------------------------
  // Notificações
  // ------------------------------------------------------------------------

  const podeNotificar = 'Notification' in window;

  function lerPreferencia() {
    try { return localStorage.getItem('aviso-notif'); } catch { return null; }
  }
  function gravarPreferencia(v) {
    try { localStorage.setItem('aviso-notif', v); } catch { /* sem armazenamento */ }
  }

  function mostrarConviteNotificacao() {
    if (podeNotificar && Notification.permission === 'default' && lerPreferencia() !== 'nao') {
      el.avisoNotif.hidden = false;
    }
  }

  $('notif-sim').addEventListener('click', async () => {
    el.avisoNotif.hidden = true;
    try { await Notification.requestPermission(); } catch { /* ignorado */ }
  });
  $('notif-nao').addEventListener('click', () => {
    gravarPreferencia('nao');
    el.avisoNotif.hidden = true;
  });

  function notificar(m) {
    if (!podeNotificar || Notification.permission !== 'granted' || naFrente()) return;
    const corpo = m.body.length > 120 ? m.body.slice(0, 117) + '…' : m.body;
    const opcoes = { body: corpo, tag: 'nova-mensagem', renotify: true, icon: '/icons/icon-192.png' };

    // No Android, notificações precisam passar pelo service worker.
    const viaSw = navigator.serviceWorker
      ? navigator.serviceWorker.ready.then((reg) => reg.showNotification(estado.parceiro.nome, opcoes))
      : Promise.reject();
    viaSw.catch(() => {
      try { new Notification(estado.parceiro.nome, opcoes); } catch { /* ignorado */ }
    });
  }

  // ------------------------------------------------------------------------
  // Conexão em tempo real
  // ------------------------------------------------------------------------

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

    socket.on('messages:delivered', ({ ids, at }) => {
      const conjunto = new Set(ids);
      for (const m of estado.mensagens) {
        if (m.id && conjunto.has(m.id) && !m.deliveredAt) {
          m.deliveredAt = at;
          atualizarBolha(m);
        }
      }
    });

    socket.on('messages:read', ({ ids, at }) => {
      const conjunto = new Set(ids);
      for (const m of estado.mensagens) {
        if (m.id && conjunto.has(m.id) && !m.readAt) {
          m.readAt = at;
          m.deliveredAt = m.deliveredAt || at;
          atualizarBolha(m);
        }
      }
    });
  }

  // ------------------------------------------------------------------------
  // Eventos da página
  // ------------------------------------------------------------------------

  function aoVoltarParaPagina() {
    if (document.visibilityState !== 'visible') return;
    if (estado.socket && !estado.socket.connected) estado.socket.connect();
    confirmarLeitura();
    atualizarTitulo();
  }
  document.addEventListener('visibilitychange', aoVoltarParaPagina);
  window.addEventListener('focus', aoVoltarParaPagina);

  el.sair.addEventListener('click', async () => {
    el.sair.disabled = true;
    try {
      if (estado.socket) estado.socket.disconnect();
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      window.location.replace('/login');
    }
  });

  // ------------------------------------------------------------------------
  // Início
  // ------------------------------------------------------------------------

  async function iniciar() {
    try {
      const eu = await api('/api/me');
      estado.eu = eu.eu;
      estado.parceiro = eu.parceiro;
      el.nome.textContent = eu.parceiro.nome;
      el.inicial.textContent = Array.from(eu.parceiro.nome.trim())[0]?.toUpperCase() || '?';

      const r = await api('/api/messages?limit=50');
      estado.mensagens = r.mensagens;
      estado.temMais = r.temMais;
      renderizarTudo();
      rolarParaFim();
      atualizarTitulo();

      conectar();
      mostrarConviteNotificacao();
      // No celular, não abre o teclado sozinho.
      if (!window.matchMedia('(pointer: coarse)').matches) el.campo.focus({ preventScroll: true });
    } catch (e) {
      if (e.message !== 'não autenticado') {
        el.status.textContent = 'não foi possível carregar. Recarregue a página.';
        console.error(e);
      }
    }
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  iniciar();
})();
