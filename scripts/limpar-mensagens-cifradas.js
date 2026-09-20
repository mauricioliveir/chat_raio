// Só é necessário se vocês usaram uma versão anterior do chat COM criptografia.
// Aquelas mensagens (e fotos/áudios) continuam guardadas embaralhadas e, sem a chave, não podem
// mais ser abertas: no chat aparecem como "mensagem de uma versão antiga". Este script apaga só elas.
// Mensagens normais NÃO são tocadas.
//
//   npm run limpar-mensagens-cifradas

const readline = require('readline');
const db = require('../server/db');

(async () => {
  try {
    await db.iniciar();
    const n = await db.contarRestosCriptografados();
    if (!n) {
      console.log('Nada para limpar: não há mensagens criptografadas antigas.');
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const resposta = await new Promise((r) =>
      rl.question(`Existem ${n} mensagem(ns) criptografada(s) antiga(s) que não podem mais ser abertas.\nApagar essas mensagens e seus arquivos? Digite APAGAR para confirmar: `, r)
    );
    rl.close();
    if (resposta.trim() !== 'APAGAR') return console.log('Cancelado. Nada foi apagado.');
    const r = await db.limparRestosCriptografados();
    console.log(`Pronto: ${r.mensagens} mensagem(ns) e ${r.arquivos} arquivo(s) removidos.`);
  } catch (err) {
    console.error('Falha:', err.message);
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
})();
