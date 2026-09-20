(() => {
  'use strict';

  const form = document.getElementById('form-login');
  const campoLogin = document.getElementById('login');
  const campoSenha = document.getElementById('senha');
  const botao = document.getElementById('entrar');
  const erro = document.getElementById('erro');

  function mostrarErro(texto) {
    erro.textContent = texto;
    erro.hidden = false;
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    erro.hidden = true;

    const login = campoLogin.value.trim();
    const senha = campoSenha.value;
    if (!login || !senha) {
      mostrarErro('Preencha o usuário e a senha.');
      (login ? campoSenha : campoLogin).focus();
      return;
    }

    botao.disabled = true;
    botao.textContent = 'Entrando…';

    try {
      const resp = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ login, senha }),
      });

      if (resp.ok) {
        window.location.replace('/');
        return;
      }

      const dados = await resp.json().catch(() => ({}));
      mostrarErro(dados.erro || 'Não foi possível entrar. Tente de novo.');
      campoSenha.select();
    } catch {
      mostrarErro('Sem conexão com o servidor. Verifique sua internet e tente de novo.');
    }

    botao.disabled = false;
    botao.textContent = 'Entrar';
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
