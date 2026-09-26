import "dotenv/config";
import readline from "readline";
import { buscarGuiaFgtsEmpresa, PORTAL_URL } from "./fgts-automacao";

/**
 * Login + busca da Guia FGTS Digital, tudo numa rodada só.
 *
 * Confirmado em teste real: a sessão do FGTS Digital NÃO sobrevive fora do navegador/conexão que fez
 * o login (mesmo reapresentando o mesmo certificado depois, o próprio site detecta "Erro de Login" e
 * devolve a tela pública) — é uma proteção do próprio gov.br contra sessão "vazada" pra outro
 * processo, não um bug daqui. Por isso, diferente da Onvio, não dá pra salvar uma sessão e reusar
 * depois num job separado: você loga manualmente aqui (resolve o captcha, escolhe o certificado,
 * perfil "Procurador") e, no mesmo navegador ainda aberto, o script já busca a guia de todas as
 * empresas marcadas (checkbox "Buscar Guia FGTS Digital" no cadastro de cada empresa) e envia os
 * PDFs pro sistema sozinho.
 *
 * Uso: npm run fgts-login
 */

const APP_BASE_URL = (process.env.FGTS_APP_URL || "https://simplescontabeis-production.up.railway.app").replace(/\/$/, "");

function perguntar(pergunta: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(pergunta, (resposta) => { rl.close(); resolve(resposta); }));
}

async function main() {
  let chromium: any;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    try {
      // Pacote portátil pra Windows (ver Configurações › FGTS Digital): só vem o playwright-core e o navegador é o Edge/Chrome do PC.
      ({ chromium } = require("playwright-core"));
    } catch {
      console.error('Pacote "playwright" não instalado. Rode primeiro: npm install');
      process.exit(1);
    }
  }

  console.log("Abrindo o navegador pra você fazer login no FGTS Digital...");
  console.log("Faça o login normalmente: Entrar com GOV.BR > Outras opções de identificação >");
  console.log('Seu certificado digital (escolha o certificado no seletor do navegador) > perfil "Procurador"');
  console.log('> digite o CNPJ de QUALQUER uma das empresas marcadas > clique em "Definir".');
  console.log('IMPORTANTE: só aperte ENTER depois de ver de verdade a tela com os quadradinhos');
  console.log('"GESTÃO DE GUIAS", "CALAMIDADE RS" etc. — se apertar antes, com algum modal ainda');
  console.log("aberto na tela, a busca das empresas trava.\n");

  // O gov.br usa hCaptcha com detecção de automação — mesmo com você mesmo resolvendo o login,
  // um Chromium recém-aberto pelo Playwright tem "sinais" de robô (navigator.webdriver, ausência de
  // histórico/plugins etc.) que fazem o captcha falhar sozinho antes de você conseguir fazer nada.
  // Estes ajustes (confirmados reduzindo o bloqueio em teste real) deixam o navegador mais parecido
  // com um uso normal, pra você conseguir passar pelo captcha manualmente.
  // FGTS_BROWSER_CHANNEL=msedge|chrome usa o navegador já instalado no PC (o certificado digital do Windows aparece no
  // seletor normalmente). Sem essa variável, usa o Chromium do próprio Playwright (uso de desenvolvimento).
  const canais: (string | undefined)[] = process.env.FGTS_BROWSER_CHANNEL ? [process.env.FGTS_BROWSER_CHANNEL, ...["msedge", "chrome"].filter((c) => c !== process.env.FGTS_BROWSER_CHANNEL)] : [undefined];
  let browser: any;
  let ultimoErro: any;
  for (const canal of canais) {
    try {
      browser = await chromium.launch({ headless: false, ...(canal ? { channel: canal } : {}), args: ["--disable-blink-features=AutomationControlled"] });
      break;
    } catch (e) {
      ultimoErro = e;
    }
  }
  if (!browser) {
    console.error("Não consegui abrir o Microsoft Edge nem o Google Chrome neste computador:", ultimoErro?.message || ultimoErro);
    process.exit(1);
  }
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    acceptDownloads: true,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    (window as any).chrome = { runtime: {} };
    Object.defineProperty(navigator, "languages", { get: () => ["pt-BR", "pt"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
  });
  const page = await context.newPage();
  await page.goto("https://fgtsdigital.sistema.gov.br/");

  // Confere de verdade se o login terminou (chegou no portal, sem nenhum modal de perfil ainda
  // aberto) antes de seguir — evita repetir o problema real já visto: apertar ENTER cedo demais
  // deixa um modal "Definir Perfil" pela metade, que trava todo mundo depois.
  for (;;) {
    await perguntar("Pressione ENTER depois de concluir o login no navegador... ");
    const urlAtual = page.url();
    const modalAberto = await page.getByLabel("Perfil", { exact: false }).first().isVisible({ timeout: 2000 }).catch(() => false);
    if (urlAtual.startsWith(PORTAL_URL) && !modalAberto) break;
    console.log(`\nAinda não parece que o login terminou (url atual: ${urlAtual}${modalAberto ? ", com o modal \"Definir Perfil\" aberto" : ""}).`);
    console.log('Termine de escolher o perfil "Procurador" + o CNPJ + "Definir" até ver a tela com os quadradinhos, depois aperte ENTER de novo.\n');
  }

  // Pacote Windows: vem com FGTS_TOKEN (chave que só serve pro agente) — nada de digitar e-mail/senha.
  // Sem ela, pede o login do sistema (ou usa FGTS_LOGIN_EMAIL/FGTS_LOGIN_SENHA do .env).
  let autenticacao: Record<string, string>;
  if (process.env.FGTS_TOKEN) {
    console.log("\nUsando a chave de acesso deste pacote (não precisa digitar login).");
    autenticacao = { Authorization: `Bearer ${process.env.FGTS_TOKEN}` };
  } else {
    let email = process.env.FGTS_LOGIN_EMAIL || "";
    let senha = process.env.FGTS_LOGIN_SENHA || "";
    if (!email || !senha) {
      console.log("\nAgora entre com seu login do Simples Contábeis (pra eu saber quais empresas buscar e onde enviar as guias).");
      email = await perguntar("E-mail: ");
      senha = await perguntar("Senha: ");
    } else {
      console.log("\nUsando o login salvo no .env (FGTS_LOGIN_EMAIL/FGTS_LOGIN_SENHA).");
    }
    console.log("\nEntrando no sistema...");
    try {
      const resp = await fetch(`${APP_BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: senha }),
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}) as any);
        throw new Error(j.error || `HTTP ${resp.status}`);
      }
      const setCookie = resp.headers.get("set-cookie") || "";
      const sid = (setCookie.match(/sid=([^;]+)/) || [])[1];
      if (!sid) throw new Error("não recebi o cookie de sessão do sistema.");
      autenticacao = { Cookie: `sid=${sid}` };
    } catch (e: any) {
      console.error("Falha ao entrar no sistema:", e.message);
      await browser.close();
      process.exit(1);
    }
  }

  console.log("Buscando a lista de empresas marcadas para busca do FGTS Digital...");
  const listaResp = await fetch(`${APP_BASE_URL}/api/fgts/empresas-marcadas`, { headers: autenticacao });
  if (!listaResp.ok) {
    const j = await listaResp.json().catch(() => ({}) as any);
    console.error("Não consegui a lista de empresas:", j.error || `HTTP ${listaResp.status}`);
    await browser.close();
    process.exit(1);
  }
  const { items: empresas } = (await listaResp.json()) as { items: { empresaId: number; cnpj: string; nome: string }[] };

  if (!empresas || !empresas.length) {
    console.log('Nenhuma empresa marcada com "Buscar Guia FGTS Digital" (marque no cadastro de cada empresa, aba Configurações).');
  } else {
    const hoje = new Date();
    const mesAnterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
    const competencia = { ano: mesAnterior.getFullYear(), mes: mesAnterior.getMonth() + 1 };
    console.log(`${empresas.length} empresa(s) marcada(s) — competência ${String(competencia.mes).padStart(2, "0")}/${competencia.ano}.\n`);

    for (const empresa of empresas) {
      process.stdout.write(`  ${empresa.nome}... `);
      const resultado = await buscarGuiaFgtsEmpresa(page, empresa, competencia);
      console.log(!resultado.ok ? `ERRO: ${resultado.erro}` : resultado.guiaGerada ? "guia gerada." : "sem débito nessa competência.");
      try {
        await fetch(`${APP_BASE_URL}/api/fgts/guia`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...autenticacao },
          body: JSON.stringify({ ano: competencia.ano, mes: competencia.mes, ...resultado }),
        });
      } catch (e: any) {
        console.error(`    (não consegui avisar o sistema sobre essa empresa: ${e.message})`);
      }
    }
  }

  await browser.close();
  console.log("\nConcluído.");
}

main().catch((e) => {
  console.error("Erro:", e.message);
  process.exit(1);
});
