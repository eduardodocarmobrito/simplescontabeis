import "dotenv/config";
import path from "path";
import fs from "fs";
import readline from "readline";

/**
 * Login único no Onvio (Domínio Web) pra criar a sessão que o dominio-agent.ts reaproveita depois.
 *
 * Roda um navegador de verdade (não escondido) — você faz o login normalmente, incluindo a
 * verificação em duas etapas (SMS ou e-mail), e este script salva a sessão autenticada em
 * data/onvio-session.json. O agente usa esse arquivo pra falar com o Onvio sem precisar de você
 * de novo, até a sessão expirar (aí é só rodar isso outra vez).
 *
 * Uso: npm run onvio-login
 */

const ONVIO_SESSION_PATH = process.env.DOMINIO_ONVIO_SESSION_PATH || path.join(__dirname, "..", "data", "onvio-session.json");

function perguntar(pergunta: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(pergunta, (resposta) => { rl.close(); resolve(resposta); }));
}

async function main() {
  let chromium: any;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    console.error('Pacote "playwright" não instalado. Rode primeiro: npm install');
    process.exit(1);
  }

  console.log("Abrindo o navegador pra você fazer login no Onvio (Domínio Web)...");
  console.log("Faça o login normalmente, incluindo o código de verificação (SMS ou e-mail).");
  console.log("Quando terminar de logar e ver a tela inicial do Onvio, volte aqui e aperte ENTER.\n");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  await page.goto("https://onvio.com.br/login/#/");

  await perguntar("Pressione ENTER depois de concluir o login no navegador... ");

  fs.mkdirSync(path.dirname(ONVIO_SESSION_PATH), { recursive: true });
  await context.storageState({ path: ONVIO_SESSION_PATH });
  console.log(`\nSessão salva em: ${ONVIO_SESSION_PATH}`);
  console.log("Pronto — o dominio-agent.ts (e o botão \"Atualizar Empresas\" no site) já pode usar essa sessão.");

  await browser.close();
}

main().catch((e) => {
  console.error("Erro:", e.message);
  process.exit(1);
});
