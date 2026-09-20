# Só nós — chat privado para duas pessoas

Um chat em tempo real, no navegador, só para vocês dois. Não existe cadastro: os dois usuários e
senhas são definidos no arquivo `.env`, e só quem tem essas senhas entra.

**Recursos**

- Mensagens em tempo real, com histórico
- Enviada / entregue / lida (✓ ✓✓), "digitando…", online e "visto por último"
- **Fotos** (com legenda) e **mensagens de voz** (com onda sonora e barra de progresso)
- **Responder** a uma mensagem específica
- **Editar** (só texto) e **apagar para todos**
- Links clicáveis · tema claro e escuro · avisos de nova mensagem
- Instalável na tela inicial do celular · reenvio automático se a internet cair
- **Tela de entrada romântica**: fundo em aurora, corações flutuando, logo animado e, se quiserem, um contador "Juntos há X anos, Y meses e Z dias"

---

## 1. Como funciona

```
Navegador (você / esposa)
   │  HTTPS + WebSocket (Socket.IO)
   ▼
Servidor Node.js (Express) ── valida a sessão, confere tudo que chega e entrega em tempo real
   │
   ▼
Banco Postgres (Neon, gratuito) ── guarda mensagens, fotos e áudios
```

```
chat-casal/
├── server/
│   ├── index.js     # rotas, segurança, envio e download de fotos/áudios
│   ├── auth.js      # login, senhas (hash) e sessão em cookie
│   ├── socket.js    # tempo real: enviar, editar, apagar, lido, digitando, online
│   ├── db.js        # tabelas e consultas do Postgres (com atualização automática)
│   ├── validar.js   # conferência de tudo que chega do navegador
│   └── config.js    # leitura e validação do .env
├── public/js/
│   ├── app.js       # a interface do chat
│   ├── midia.js     # fotos (redução), gravação de áudio, envio e download
│   └── login.js     # a tela de entrada (corações, saudação, contador)
├── scripts/limpar-mensagens-cifradas.js   # só para quem usou a versão com criptografia
├── views/           # login.html e chat.html
└── public/          # css, ícones, manifest e service worker
```

---

## 2. Usando

| Ação | Computador | Celular |
|---|---|---|
| **Responder** | seta ⌄ ao lado da mensagem → *Responder* | deslize a mensagem para a direita, ou toque nela → *Responder* |
| **Editar** / **Apagar** | seta ⌄ → *Editar* / *Apagar para todos* (só suas mensagens) | toque na mensagem |
| **Foto** | botão de imagem ao lado do campo de texto | idem (abre câmera ou galeria) |
| **Áudio** | botão do microfone → grave → botão de enviar (ou lixeira para descartar) | idem |
| **Ir para a mensagem original** | clique na citação | toque na citação |

- As fotos são **reduzidas para no máximo 1600 px e convertidas em JPEG** antes de enviar. Isso economiza espaço no banco
  gratuito e **remove os metadados da foto** (localização GPS, modelo do celular etc.).
- Áudios gravam até **5 minutos** (cerca de 4 KB por segundo).
- Só é possível editar mensagens de **texto**. Fotos e áudios podem ser apagados.
- **Apagar para todos** remove o conteúdo do banco de verdade (e o arquivo, se houver). Fica só o aviso "mensagem apagada".
  Se alguém já tinha respondido àquela mensagem, a citação dentro da resposta continua mostrando o trecho.

---

## 3. A tela de entrada

Ela muda de acordo com o horário ("Bom dia", "Boa tarde", "Boa noite"), respeita o tema claro/escuro do aparelho e
reduz as animações para quem pediu menos movimento no sistema.

**Contador "Juntos há…" (opcional).** Coloque no `.env` a data em que vocês começaram:

```
JUNTOS_DESDE=2019-06-15
```

A tela passa a mostrar, por exemplo, *Juntos há 7 anos, 3 meses e 5 dias* — e, no dia do aniversário, *Hoje é o aniversário de vocês!*
Sem essa linha no `.env`, o contador simplesmente não aparece.

> ⚠️ A tela de entrada é **pública** (é ela que pede a senha), então quem abrir o endereço do site verá essa data.
> Se preferir privacidade total, deixe `JUNTOS_DESDE` de fora.

Para trocar o nome ("Só nós") ou a frase manuscrita ("o nosso cantinho"), edite `views/login.html`.
As cores ficam no início de `public/css/login.css`.

---

## 4. Criar o banco gratuito (Neon)

1. Crie uma conta em <https://neon.com> e um novo projeto (escolha a região mais próxima de você).
2. Copie a **connection string** (começa com `postgresql://...`). Ela será o `DATABASE_URL`.

As tabelas são criadas sozinhas na primeira vez que o servidor inicia.

> O plano gratuito do Neon tem cerca de **0,5 GB** de armazenamento. Fotos reduzidas ficam em torno de 300 KB e áudios
> em ~4 KB por segundo, então cabem na casa de 1.500 fotos (menos, se houver muitos áudios). O **menu ⋮ mostra o espaço usado**.
> (Se o seu plano tiver outro limite, ajuste `STORAGE_LIMIT_MB` no `.env`; ele só afeta o texto exibido.)
> O plano suspende o banco após alguns minutos parado; a primeira mensagem depois disso pode demorar um instante.

---

## 5. Rodar no seu computador

Pré-requisito: [Node.js](https://nodejs.org) 18 ou mais novo.

```bash
npm install
cp .env.example .env      # no Windows: copy .env.example .env
```

Preencha o `.env`:

| Variável | O que colocar |
|---|---|
| `DATABASE_URL` | A connection string do Neon (ou use o Docker abaixo) |
| `JWT_SECRET` | Um texto longo e aleatório. Gere com `npm run gerar-segredo` |
| `USER1_LOGIN` / `USER1_NOME` / `USER1_SENHA` | Seu usuário, o nome que aparece para ela, e sua senha (mín. 8 caracteres) |
| `USER2_LOGIN` / `USER2_NOME` / `USER2_SENHA` | Os mesmos dados dela |
| `JUNTOS_DESDE` *(opcional)* | Data de vocês, no formato `AAAA-MM-DD` |

Depois:

```bash
npm start
```

Abra <http://localhost:3000>. Para testar, abra uma janela anônima com o outro usuário.

**Sem conta no Neon?** Para desenvolver, suba um Postgres local com Docker
(`docker compose up -d`) e mantenha o `DATABASE_URL` padrão do `.env.example`.

> O microfone só funciona em **HTTPS** ou em **localhost**. Pela rede local (`http://192.168.0.10:3000`) o navegador bloqueia a gravação.

---

## 6. Colocar no ar (para usarem de qualquer lugar)

O jeito mais simples e gratuito é a **Render** (servidor) + **Neon** (banco).

1. Crie um repositório **privado** no GitHub e envie esta pasta (o `.gitignore` já impede o envio do `.env`).
2. Na [Render](https://render.com): **New → Web Service** e conecte o repositório.
3. Configure **Build Command** `npm install`, **Start Command** `npm start` e **Instance type** Free.
4. Em **Environment**, adicione: `DATABASE_URL`, `JWT_SECRET`, `USER1_LOGIN`, `USER1_NOME`, `USER1_SENHA`,
   `USER2_LOGIN`, `USER2_NOME`, `USER2_SENHA`, `NODE_ENV=production` (e `JUNTOS_DESDE`, se quiserem).
5. Publique. A Render entrega um endereço `https://...onrender.com`, que é o que vocês dois vão abrir.

> **Sobre o plano gratuito da Render:** o serviço "dorme" depois de 15 minutos sem uso e leva cerca de um minuto para
> acordar no primeiro acesso. As regras mudam com o tempo, então confira o que vale hoje.

---

## 7. Instalar como app no celular

- **Android (Chrome):** menu ⋮ → *Instalar app* / *Adicionar à tela inicial*.
- **iPhone (Safari):** botão de compartilhar → *Adicionar à Tela de Início*.

Na primeira abertura, o chat oferece ativar os avisos de nova mensagem. Eles funcionam enquanto o app/aba está aberto em
segundo plano; para receber com o app totalmente fechado seria preciso Web Push (evolução possível).
O microfone e a câmera pedem permissão na primeira vez. Se você negar, libere nas configurações do navegador.

---

## 8. Privacidade e segurança

**O que está guardado, e como.** As mensagens, fotos e áudios ficam no banco de dados **sem criptografia própria**
(o Neon e a Render protegem a conexão e o disco, mas quem tiver acesso à conta de vocês no Neon ou ao banco consegue ler tudo).
Proteja essas contas com senha forte e verificação em duas etapas, e também a do GitHub.

O que já está incluído:

- Senhas só existem no `.env`; em memória viram hash (bcrypt). Sessão em cookie `HttpOnly` + `SameSite=Lax` (+ `Secure` em produção).
- Máximo de 8 tentativas de login erradas a cada 15 minutos por IP.
- A conexão em tempo real só é aceita com sessão válida e vinda do próprio site.
- Proteção contra requisições de outros sites (CSRF) e cabeçalhos de segurança (Helmet/CSP).
- Nada digitado vira HTML (mensagens sempre como texto). O servidor confere cada mensagem campo a campo e descarta o que não conhece.
- Fotos e áudios: o servidor só aceita JPEG, PNG, WebP, WebM, MP4 e OGG, **conferindo os primeiros bytes do arquivo** (não basta dizer que é uma foto), com limite de 6 MB.
- Limites: 30 ações a cada 10 segundos por conexão, 60 envios de arquivo a cada 10 minutos.
- Só as duas pessoas autenticadas acessam os arquivos; cada uma só pode **editar/apagar as próprias** mensagens.
- Uploads que nunca viraram mensagem (envio cancelado) são removidos automaticamente após 1 hora.

**Cuidados seus:** senhas longas e diferentes das de outros lugares; nunca envie o `.env` ao GitHub.

---

## 9. Vindo da versão com criptografia?

Se vocês chegaram a usar a versão anterior (com frase secreta), o chat atualiza o banco sozinho ao iniciar:

- Mensagens da **primeira versão** (texto puro) continuam normais.
- Mensagens **criptografadas** não podem mais ser abertas (a chave era só dos aparelhos). No chat elas aparecem como
  *"Esta mensagem é de uma versão antiga do chat e não pode mais ser aberta."*

Para apagar só esses restos (as demais mensagens não são tocadas):

```bash
npm run limpar-mensagens-cifradas
```

O comando conta quantas existem e só apaga depois que você digitar `APAGAR`. Rode no seu computador, com o `.env` apontando para o mesmo banco.

---

## 10. Problemas comuns

| Sintoma | Causa provável |
|---|---|
| `Variável de ambiente ausente` ao iniciar | Falta preencher algo no `.env` |
| `JUNTOS_DESDE inválido` | Use `AAAA-MM-DD`, uma data que já passou e que exista (não vale 31/02) |
| `Não foi possível conectar ao banco de dados` | `DATABASE_URL` errado, ou o banco ainda está acordando: tente de novo |
| "Muitas tentativas" no login | Aguarde 15 minutos ou reinicie o servidor |
| Microfone não funciona | Permissão negada no navegador, endereço sem HTTPS, ou navegador sem suporte a gravação |
| Volta para o login logo depois de entrar | Está acessando por `http://`. Em produção o cookie só vale em `https://` |
| Aviso `X-Forwarded-For` nos logs da Render | Falta a variável `NODE_ENV=production` |
| Primeiro acesso do dia demora | Plano gratuito acordando (Render e/ou Neon) |

---

## 11. Ideias para evoluir

Web Push (aviso com o app fechado), armazenamento de arquivos em serviço próprio (Cloudflare R2, Backblaze B2) para não gastar
o espaço do banco, reações com emoji, busca no histórico e criptografia de ponta a ponta (a versão anterior já fez isso e pode ser retomada).
