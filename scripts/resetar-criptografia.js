// Use SOMENTE se vocês esqueceram a frase secreta.
// Como a chave nunca sai dos aparelhos, ela não pode ser recuperada:
// o único caminho é apagar as mensagens e criar uma frase nova.
//
//   npm run resetar-criptografia

const readline = require('readline');
const db = require('../server/db');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log('\n⚠️  ATENÇÃO: isto apaga TODAS as mensagens, fotos e áudios e remove a frase secreta.');
console.log('   Na próxima vez que abrirem o chat, será pedido para criar uma frase nova.\n');

rl.question('Para confirmar, digite APAGAR e pressione Enter: ', async (resposta) => {
  rl.close();
  if (resposta.trim() !== 'APAGAR') {
    console.log('Cancelado. Nada foi apagado.');
    return db.pool.end();
  }
  try {
    await db.iniciar();
    await db.apagarTudoCifrado();
    console.log('Pronto. Tudo foi apagado. Abra o chat para criar uma nova frase secreta.');
  } catch (err) {
    console.error('Falha:', err.message);
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
});
