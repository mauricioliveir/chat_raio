(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const cartao = $('cartao');
  const form = $('form-login');
  const campoLogin = $('login');
  const campoSenha = $('senha');
  const botao = $('entrar');
  const textoBotao = botao.querySelector('.entrar-texto');
  const erro = $('erro');
  const semMovimento = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------------------
  // Saudação de acordo com a hora
  // ---------------------------------------------------------------------------
  const hora = new Date().getHours();
  $('saudacao').textContent = hora >= 5 && hora < 12 ? 'Bom dia' : hora >= 12 && hora < 18 ? 'Boa tarde' : 'Boa noite';

  // ---------------------------------------------------------------------------
  // Corações que sobem (decoração)
  // ---------------------------------------------------------------------------
  if (!semMovimento) {
    const MOLDE =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
    const total = window.innerWidth < 520 ? 10 : 16;
    const aleatorio = (min, max) => min + Math.random() * (max - min);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < total; i++) {
      const c = document.createElement('span');
      c.className = 'coracao';
      c.innerHTML = MOLDE; // string fixa definida acima
      const dur = aleatorio(16, 30);
      c.style.setProperty('--x', `${aleatorio(2, 96).toFixed(1)}%`);
      c.style.setProperty('--tam', `${aleatorio(12, 34).toFixed(0)}px`);
      c.style.setProperty('--dur', `${dur.toFixed(1)}s`);
      c.style.setProperty('--atraso', `${(-Math.random() * dur).toFixed(1)}s`); // já começam espalhados
      c.style.setProperty('--op', aleatorio(0.14, 0.4).toFixed(2));
      c.style.setProperty('--vai', `${aleatorio(-46, 46).toFixed(0)}px`);
      frag.append(c);
    }
    $('coracoes').append(frag);
  }

 
  // ---------------------------------------------------------------------------
  // Campos
  // ---------------------------------------------------------------------------
  const verSenha = $('ver-senha');
  verSenha.addEventListener('click', () => {
    const mostrar = campoSenha.type === 'password';
    campoSenha.type = mostrar ? 'text' : 'password';
    verSenha.setAttribute('aria-pressed', String(mostrar));
    verSenha.setAttribute('aria-label', mostrar ? 'Esconder senha' : 'Mostrar senha');
    campoSenha.focus();
  });

  const dicaCaps = $('dica-caps');
  const checarCaps = (ev) => {
    if (ev.getModifierState) dicaCaps.hidden = !ev.getModifierState('CapsLock');
  };
  campoSenha.addEventListener('keydown', checarCaps);
  campoSenha.addEventListener('keyup', checarCaps);
  campoSenha.addEventListener('blur', () => (dicaCaps.hidden = true));

  // No celular não abrimos o teclado sozinhos.
  if (window.matchMedia('(pointer: fine)').matches) campoLogin.focus();

  function mostrarErro(texto) {
    erro.textContent = texto;
    erro.hidden = false;
    if (!semMovimento) {
      cartao.classList.remove('tremer');
      void cartao.offsetWidth; // reinicia a animação
      cartao.classList.add('tremer');
    }
  }

  // ---------------------------------------------------------------------------
  // Entrar
  // ---------------------------------------------------------------------------
  function carregando(sim, texto) {
    botao.disabled = sim;
    botao.classList.toggle('carregando', sim);
    textoBotao.textContent = texto;
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    erro.hidden = true;

    const login = campoLogin.value.trim();
    const senha = campoSenha.value;
    if (!login || !senha) {
      mostrarErro(!login ? 'Diga quem é você: falta o usuário.' : 'Falta a senha.');
      (login ? campoSenha : campoLogin).focus();
      return;
    }

    carregando(true, 'Entrando');

    try {
      const resp = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ login, senha }),
      });

      if (resp.ok) {
        carregando(true, 'Bem-vindo(a)');
        botao.classList.remove('carregando');
        if (!semMovimento) cartao.classList.add('saindo');
        setTimeout(() => window.location.replace('/'), semMovimento ? 0 : 380);
        return;
      }

      const dados = await resp.json().catch(() => ({}));
      mostrarErro(
        resp.status === 401
          ? 'Ops, o usuário ou a senha não conferem. Tenta de novo?'
          : dados.erro || 'Não foi possível entrar agora. Tente de novo.'
      );
      campoSenha.select();
    } catch {
      mostrarErro('Sem conexão com o servidor. Verifique a internet e tente de novo.');
    }

    carregando(false, 'Entrar');
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
