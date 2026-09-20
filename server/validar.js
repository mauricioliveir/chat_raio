// Validações simples e estritas para tudo que chega do navegador.
// O servidor nunca vê o conteúdo das mensagens (só dados cifrados), então
// aqui só conferimos o FORMATO e o TAMANHO.

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ehBase64 = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && BASE64.test(s);
const ehUuid = (s) => typeof s === 'string' && UUID.test(s);
const ehClientId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);

// IV do AES-GCM: 12 bytes = 16 caracteres em base64
const ehIv = (s) => typeof s === 'string' && s.length === 16 && BASE64.test(s);

const MAX_CT = 24_000; // texto cifrado de uma mensagem (inclui miniatura e resposta)

module.exports = { ehBase64, ehUuid, ehClientId, ehIv, MAX_CT };
