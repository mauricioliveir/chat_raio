# Só nós — chat privado para duas pessoas

Um chat em tempo real, no navegador, só para vocês dois. Não existe cadastro:
os dois usuários e senhas são definidos no arquivo `.env`, e só quem tem essas
senhas entra.

**Recursos:** mensagens em tempo real · histórico salvo no banco · enviada / entregue / lida (✓ ✓✓) ·
"digitando…" · online e "visto por último" · links clicáveis · tema claro e escuro ·
avisos de nova mensagem · instalável na tela inicial do celular · reenvio automático se a internet cair.

---

## 1. Como funciona

```
Navegador (você / esposa)
   │  HTTPS + WebSocket (Socket.IO)
   ▼
Servidor Node.js (Express)  ── valida a sessão, entrega mensagens em tempo real
   │
   ▼
Banco Postgres (Neon, gratuito) ── guarda as mensagens
```

```
chat-casal/
├── server/
│   ├── index.js    # rotas, segurança, páginas e API
│   ├── auth.js     # login, senhas (hash) e sessão em cookie
│   ├── socket.js   # tempo real: mensagens, lido, digitando, online
│   ├── db.js       # tabelas e consultas do Postgres
│   └── config.js   # leitura e validação do .env
├── views/          # login.html e chat.html
├── public/         # css, js, ícones, manifest e service worker
├── .env.example    # modelo de configuração
└── docker-compose.yml  # Postgres local (opcional, para desenvolvimento)
```

---

## 2. Criar o banco gratuito (Neon)

1. Crie uma conta em <https://neon.com> e um novo projeto (escolha a região mais próxima de você).
2. Na tela do projeto, copie a **connection string** (começa com `postgresql://...`).
3. Guarde-a: ela será o `DATABASE_URL`.

As tabelas são criadas sozinhas na primeira vez que o servidor inicia.

> O plano gratuito do Neon suspende o banco após alguns minutos parado e acorda na
> próxima conexão. Por isso a primeira mensagem depois de um tempo pode demorar um instante.

---

## 3. Rodar no seu computador

Pré-requisito: [Node.js](https://nodejs.org) 18 ou mais novo.

```bash
npm install
cp .env.example .env      # no Windows: copy .env.example .env
```

Abra o `.env` e preencha:

| Variável | O que colocar |
|---|---|
| `DATABASE_URL` | A connection string do Neon (ou use o Docker abaixo) |
| `JWT_SECRET` | Um texto longo e aleatório. Gere com `npm run gerar-segredo` |
| `USER1_LOGIN` / `USER1_NOME` / `USER1_SENHA` | Seu usuário, o nome que aparece para ela, e sua senha (mín. 8 caracteres) |
| `USER2_LOGIN` / `USER2_NOME` / `USER2_SENHA` | Os mesmos dados dela |

Depois:

```bash
npm start
```

Abra <http://localhost:3000>. Para testar, abra uma janela anônima com o outro usuário.

**Sem conta no Neon?** Para desenvolver, suba um Postgres local com Docker
(`docker compose up -d`) e mantenha o `DATABASE_URL` padrão do `.env.example`.

---

## 4. Colocar no ar (para usarem de qualquer lugar)

O jeito mais simples e gratuito é a **Render** (servidor) + **Neon** (banco).

1. Crie um repositório privado no GitHub e envie esta pasta.
   O `.gitignore` já impede o envio do `.env` e do `node_modules`.
2. Na [Render](https://render.com): **New → Web Service** e conecte o repositório.
3. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Free
4. Em **Environment**, adicione as variáveis: `DATABASE_URL`, `JWT_SECRET`,
   `USER1_LOGIN`, `USER1_NOME`, `USER1_SENHA`, `USER2_LOGIN`, `USER2_NOME`, `USER2_SENHA`
   e também `NODE_ENV=production`.
5. Publique. A Render entrega um endereço `https://...onrender.com` — é ele que vocês dois vão abrir.

> **Sobre o plano gratuito da Render:** o serviço "dorme" depois de 15 minutos sem uso
> e leva cerca de um minuto para acordar no primeiro acesso. As regras dos planos gratuitos
> mudam com o tempo, então confira o que vale hoje. Se isso incomodar, dá para usar um
> plano pago barato ou rodar em um servidor próprio (por exemplo, um mini PC em casa com
> Cloudflare Tunnel).

---

## 5. Instalar como app no celular

- **Android (Chrome):** menu ⋮ → *Instalar app* / *Adicionar à tela inicial*.
- **iPhone (Safari):** botão de compartilhar → *Adicionar à Tela de Início*.

Dentro do app instalado, o chat abre em tela cheia, como um aplicativo.
Na primeira abertura, o chat oferece ativar os avisos de nova mensagem.

> **Limite dos avisos:** eles funcionam enquanto o app/aba está aberto em segundo plano.
> Para receber aviso com o app totalmente fechado seria preciso adicionar *Web Push*
> (uma evolução possível deste projeto).

---

## 6. Personalizar

- **Nome do app ("Só nós"):** procure por `Só nós` em `views/`, `public/manifest.webmanifest`
  e no topo de `public/js/app.js` (`NOME_APP`).
- **Cores:** ficam no início de `public/css/style.css` (`:root`).
- **Duração do login:** `sessaoDias` em `server/config.js` (padrão: 30 dias).
- **Trocar uma senha:** altere no `.env` (ou nas variáveis da Render) e reinicie o servidor.

---

## 7. Segurança — o que já está incluído

- Senhas só existem no `.env`; em memória viram hash (bcrypt).
- Sessão em cookie `HttpOnly` + `SameSite=Lax` (+ `Secure` em produção), válida por 30 dias.
- Máximo de 8 tentativas de login erradas a cada 15 minutos por IP.
- Conexão em tempo real só é aceita com sessão válida e vinda do próprio site.
- Proteção contra requisições de outros sites (CSRF) e cabeçalhos de segurança (Helmet/CSP).
- Mensagens são exibidas como texto puro (nada digitado vira HTML).
- Limite de mensagens por segundo e de tamanho (4000 caracteres).

**Cuidados seus:**
- Use senhas longas e diferentes das que usa em outros lugares.
- Nunca envie o `.env` para o GitHub.
- As mensagens ficam **legíveis no banco** (não são criptografadas de ponta a ponta).
  Quem tiver acesso à sua conta do Neon consegue lê-las. Proteja essa conta com verificação em duas etapas.

---

## 8. Problemas comuns

| Sintoma | Causa provável |
|---|---|
| `Variável de ambiente ausente` ao iniciar | Falta preencher algo no `.env` |
| `Não foi possível conectar ao banco` | `DATABASE_URL` errado, ou o banco ainda está acordando: tente de novo |
| "Muitas tentativas" no login | Aguarde 15 minutos ou reinicie o servidor |
| Primeiro acesso do dia demora | Plano gratuito acordando (Render e/ou Neon) |
| Volta para a tela de login logo depois de entrar | Está acessando por `http://`. Em produção o cookie só vale em `https://` |
| Aviso `X-Forwarded-For` nos logs da Render | Falta a variável `NODE_ENV=production` |

---

## 9. Ideias para evoluir

Envio de fotos, responder a uma mensagem específica, apagar/editar mensagem,
Web Push (aviso com o app fechado) e criptografia de ponta a ponta.
