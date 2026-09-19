import "dotenv/config";
import path from "path";
import fs from "fs";
import readline from "readline";

/**
 * Login único no FGTS Digital pra criar a sessão que fgts-automacao.ts reaproveita depois.
 *
 * O login do gov.br é protegido por hCaptcha (confirmado em teste real — não dá pra automatizar
 * esse passo). Por isso, igual o onvio-login-setup.ts, este script roda um navegador de verdade
 * (não escondido) — você faz o login manualmente (gov.br, capitcha, certificado digital escolhido
 * no seletor nativo do navegador, perfil "Procurador") e o script salva a sessão autenticada em
 * data/fgts-session.json. A busca de guias depois usa esse arquivo sem precisar de você de novo,
 * até a sessão expirar (aí é só rodar isso outra vez).
 *
 * Uso: npm run fgts-login
 */

const FGTS_SESSION_PATH = process.env.FGTS_SESSION_PATH || path.join(__dirname, "..", "data", "fgts-session.json");

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

  console.log("Abrindo o navegador pra você fazer login no FGTS Digital...");
  console.log("Faça o login normalmente: Entrar com GOV.BR > Outras opções de identificação >");
  console.log('Seu certificado digital (escolha o certificado no seletor do navegador) > perfil "Procurador".');
  console.log("Quando terminar de logar e ver a tela do portal (Gestão de Guias etc.), volte aqui e aperte ENTER.\n");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  await page.goto("https://fgtsdigital.sistema.gov.br/");

  await perguntar("Pressione ENTER depois de concluir o login no navegador... ");

  fs.mkdirSync(path.dirname(FGTS_SESSION_PATH), { recursive: true });
  await context.storageState({ path: FGTS_SESSION_PATH });
  console.log(`\nSessão salva em: ${FGTS_SESSION_PATH}`);
  console.log('Pronto — envie esse arquivo em Configurações › FGTS Digital pra ativar a busca de guias.');

  await browser.close();
}

main().catch((e) => {
  console.error("Erro:", e.message);
  process.exit(1);
});
