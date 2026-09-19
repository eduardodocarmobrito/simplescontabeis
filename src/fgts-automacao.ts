/**
 * Busca automática da Guia FGTS Digital (GFD) — reaproveita uma sessão de navegador já autenticada
 * (ver `npm run fgts-login`), porque o login do gov.br é protegido por hCaptcha e não dá pra
 * automatizar (confirmado em teste real contra o site de produção).
 *
 * Fluxo mapeado com prints reais do usuário: portal/servicos > "GESTÃO DE GUIAS" >
 * "EMISSÃO DE GUIA RÁPIDA" > preencher Competência de Apuração > "Pesquisar" > card "Mensal" >
 * "Emitir guia" > (se já existir guia não paga) confirmar no modal "Gerar guia" > PDF baixa
 * automaticamente pelo navegador.
 *
 * O seletor de troca de empresa (visível no cabeçalho "Empregador: <CNPJ> | <nome>", confirmado
 * pelo usuário que existe um menu pra trocar sem logar de novo) ainda não foi visto num print real
 * — a implementação abaixo tenta um caminho razoável a partir do texto "Empregador" e lança um erro
 * claro e específico se não achar, pra facilitar confirmar/ajustar rodando ao vivo contra a sessão
 * real assim que o primeiro login for feito (ver plano — "não adivinhar o DOM" é a mesma disciplina
 * usada no resto do projeto).
 */

export interface EmpresaParaBuscaFgts {
  empresaId: number;
  cnpj: string;
  nome: string;
}
export interface ResultadoFgtsEmpresa {
  empresaId: number;
  nome: string;
  ok: boolean;
  guiaGerada: boolean; // true = PDF baixado; false = sem débito pra competência (não é erro)
  pdfBase64?: string;
  nomeArquivo?: string;
  erro?: string;
}

const PORTAL_URL = "https://fgtsdigital.sistema.gov.br/portal/servicos";
const EMISSAO_GUIA_RAPIDA_URL = "https://fgtsdigital.sistema.gov.br/cobranca/#/gestao-guias/emissao-guia-rapida";

function soDigitos(s: string): string {
  return String(s || "").replace(/\D/g, "");
}

async function trocarEmpresa(page: any, cnpjDigits: string, nomeEmpresa: string) {
  const gatilho = page.getByText("Empregador:", { exact: false }).first();
  const visivel = await gatilho.isVisible().catch(() => false);
  if (!visivel) {
    throw new Error(
      `Não encontrei o seletor de troca de empresa (texto "Empregador:") na tela do portal. ` +
        `O layout pode ter mudado ou não é isso que abre o menu de troca — precisa confirmar rodando o diagnóstico ao vivo contra a sessão real.`
    );
  }
  await gatilho.click();
  await page.waitForTimeout(800);

  // Tenta achar a empresa pelo CNPJ (com e sem formatação) e, se não achar, pelo nome.
  const porCnpjFormatado = cnpjDigits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  let opcao = page.getByText(porCnpjFormatado, { exact: false }).first();
  if (!(await opcao.isVisible().catch(() => false))) {
    opcao = page.getByText(cnpjDigits, { exact: false }).first();
  }
  if (!(await opcao.isVisible().catch(() => false))) {
    opcao = page.getByText(nomeEmpresa, { exact: false }).first();
  }
  if (!(await opcao.isVisible().catch(() => false))) {
    throw new Error(
      `Abri o menu de troca de empresa, mas não achei a opção pro CNPJ ${porCnpjFormatado} (nem pelo nome "${nomeEmpresa}") ` +
        `— confirme se o Procurador tem procuração ativa pra essa empresa no FGTS Digital.`
    );
  }
  await opcao.click();
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1000);
}

async function buscarGuiaDaEmpresaAtual(page: any, ano: number, mes: number): Promise<{ guiaGerada: boolean; pdfBuffer?: Buffer; nomeArquivo?: string }> {
  await page.goto(EMISSAO_GUIA_RAPIDA_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  const competenciaTexto = `${String(mes).padStart(2, "0")}/${ano}`;
  const campoCompetencia = page.getByLabel("Competência de Apuração", { exact: false }).first();
  await campoCompetencia.click({ timeout: 15000 });
  await campoCompetencia.fill(competenciaTexto).catch(async () => {
    await page.keyboard.type(competenciaTexto);
  });
  await page.keyboard.press("Escape").catch(() => {});

  const btnPesquisar = page.getByRole("button", { name: "Pesquisar", exact: false }).first();
  await btnPesquisar.click({ timeout: 15000 });
  await page.waitForTimeout(3000);

  const btnEmitirGuia = page.getByRole("button", { name: "Emitir guia", exact: false }).first();
  const temGuiaParaEmitir = await btnEmitirGuia.isVisible({ timeout: 10000 }).catch(() => false);
  if (!temGuiaParaEmitir) {
    return { guiaGerada: false };
  }

  const downloadPromise = page.waitForEvent("download", { timeout: 30000 }).catch(() => null);
  await btnEmitirGuia.click();
  await page.waitForTimeout(1500);

  const btnConfirmar = page.getByRole("button", { name: "Confirmar", exact: false }).first();
  if (await btnConfirmar.isVisible({ timeout: 5000 }).catch(() => false)) {
    await btnConfirmar.click();
  }

  const download = await downloadPromise;
  if (!download) {
    throw new Error("Cliquei em \"Emitir guia\" mas o download do PDF não começou — pode ter aparecido um aviso/erro diferente do esperado na tela.");
  }
  const nomeArquivo = download.suggestedFilename() || `guia-fgts-${competenciaTexto.replace("/", "-")}.pdf`;
  const caminho = await download.path();
  if (!caminho) throw new Error("O download do PDF da guia FGTS falhou (arquivo não ficou disponível).");
  const fs = require("fs");
  const pdfBuffer: Buffer = fs.readFileSync(caminho);
  return { guiaGerada: true, pdfBuffer, nomeArquivo };
}

export async function buscarGuiasFgts(
  sessionPath: string,
  empresas: EmpresaParaBuscaFgts[],
  competencia: { ano: number; mes: number }
): Promise<ResultadoFgtsEmpresa[]> {
  const fs = require("fs");
  if (!fs.existsSync(sessionPath)) {
    throw new Error(`Sessão do FGTS Digital não encontrada em "${sessionPath}". Faça o login (npm run fgts-login) e envie o arquivo em Configurações › FGTS Digital.`);
  }
  const { chromium } = require("playwright");

  const browser = await chromium.launch();
  const resultados: ResultadoFgtsEmpresa[] = [];
  try {
    const context = await browser.newContext({ storageState: sessionPath, acceptDownloads: true });
    const page = await context.newPage();

    await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
    if (/sso\.acesso\.gov\.br\/login|certificado\.sso\.acesso\.gov\.br/.test(page.url())) {
      throw new Error('A sessão do FGTS Digital expirou ou foi desconectada. Faça o login de novo (npm run fgts-login) e envie o novo arquivo em Configurações › FGTS Digital.');
    }

    for (const empresa of empresas) {
      try {
        await trocarEmpresa(page, soDigitos(empresa.cnpj), empresa.nome);
        const r = await buscarGuiaDaEmpresaAtual(page, competencia.ano, competencia.mes);
        if (!r.guiaGerada) {
          resultados.push({ empresaId: empresa.empresaId, nome: empresa.nome, ok: true, guiaGerada: false });
        } else {
          resultados.push({
            empresaId: empresa.empresaId,
            nome: empresa.nome,
            ok: true,
            guiaGerada: true,
            pdfBase64: r.pdfBuffer!.toString("base64"),
            nomeArquivo: r.nomeArquivo,
          });
        }
      } catch (e: any) {
        resultados.push({ empresaId: empresa.empresaId, nome: empresa.nome, ok: false, guiaGerada: false, erro: e.message });
      }
    }
    return resultados;
  } finally {
    await browser.close();
  }
}
