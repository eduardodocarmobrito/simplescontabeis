// Consulta/emissão automática da Certidão de Débitos MUNICIPAL da Prefeitura de Redenção-PA (plataforma
// "Desenvolve Cidade / ISS Digital"). O portal é uma app PrimeFaces/JSF com captcha ALTCHA (proof-of-work
// que o próprio navegador resolve) — por isso dirigimos com Playwright (navegador real) em vez de HTTP cru.
// Fluxo validado ao vivo (2026-10-26): abre a página → clica "CERTIDÃO DE DÉBITOS" → Tipo Pessoa JURÍDICA
// → preenche CNPJ → Finalidade "Cadastro" → marca o ALTCHA (auto-resolve) → "Pesquisar" → se houver
// "certidão vigente", escolhe "Nova Certidão" → tela de confirmação (Tipo/Validade/Protocolo) → "Download".
import fs from "fs";

const URL_REDENCAO = "https://redencao-pa.desenvolvecidade.com.br/nfsd/pages/consulta/certidaoDebito/solicitacaoCertidaoDebito.jsf";

export type CertidaoMunicipal = {
  tipo: "negativa" | "positiva_efeito" | "positiva";
  validadeIso: string | null;
  emissaoIso: string | null;
  numero: string | null;
  pdfBase64: string;
};

export async function abrirNavegadorRedencao(): Promise<any> {
  const { chromium } = require("playwright");
  return chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}

// Consulta uma empresa. Reaproveita um browser já aberto (bulk) ou abre/fecha um só pra esta chamada.
export async function consultarCertidaoRedencao(cnpj: string, browserExterno?: any): Promise<CertidaoMunicipal> {
  const digits = String(cnpj || "").replace(/\D/g, "");
  if (digits.length !== 14) throw new Error("CNPJ inválido para a consulta municipal.");
  const browser = browserExterno || (await abrirNavegadorRedencao());
  const ctx = await browser.newContext({ acceptDownloads: true });
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    await page.goto(URL_REDENCAO, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(2500);
    await page.click("a:has-text('CERTIDÃO DE DÉBITOS')");
    await page.waitForTimeout(3000);
    await page.selectOption("#tipoPessoa_input", { label: "JURÍDICA" });
    await page.waitForTimeout(2500);
    await page.fill("#documentoFiscalCNPJ", digits);
    await page.waitForTimeout(500);
    await page.selectOption("#certidaoFinalidade_input", { label: "Cadastro" });
    await page.waitForTimeout(1200);
    // ALTCHA: marca o checkbox e espera o widget resolver o PoW (hidden "altcha" preenchido).
    await page.click("#altcha input[type=checkbox]");
    let altchaOk = false;
    for (let i = 0; i < 30; i++) {
      const len = await page.evaluate(() => ((document.querySelector("#altcha input[name=altcha]") as any)?.value || "").length);
      if (len > 50) { altchaOk = true; break; }
      await page.waitForTimeout(700);
    }
    if (!altchaOk) throw new Error("ALTCHA não resolveu a tempo.");
    await page.click("#botaoAcaoSolicitarCertidao");
    await page.waitForTimeout(5000);
    // Diálogo "Existe uma certidão vigente..." → emite uma nova (status atual, fresco).
    const temVigente = await page.evaluate(() => /certid[aã]o vigente/i.test(document.body.innerText));
    if (temVigente) {
      await page.click("button:has-text('Nova Certidão'), a:has-text('Nova Certidão')").catch(() => {});
      await page.waitForTimeout(6500);
    }
    const body: string = await page.evaluate(() => document.body.innerText);
    if (!/Sucesso|Protocolo|Confirma[çc][ãa]o/i.test(body)) {
      const err = body.match(/(n[ãa]o\s+(?:foi\s+)?(?:encontrad|possui|existe)[\s\S]{0,90}|inv[áa]lid[\s\S]{0,90}|erro[\s\S]{0,90})/i)?.[0] || "o portal não retornou a confirmação.";
      throw new Error("Redenção: " + err.replace(/\s+/g, " ").trim().slice(0, 140));
    }
    const tipoTxt = (body.match(/Tipo de Certid[ãa]o:?\s*([^\n]+)/i)?.[1] || "").toUpperCase();
    const tipo: CertidaoMunicipal["tipo"] = /POSITIVA\s+COM\s+EFEITOS?/.test(tipoTxt) ? "positiva_efeito" : /POSITIVA/.test(tipoTxt) ? "positiva" : "negativa";
    const mVal = /(?:Data de Validade|Validade):?\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(body);
    const validadeIso = mVal ? `${mVal[3]}-${mVal[2]}-${mVal[1]}` : null;
    const mEmi = /(?:Data de Solicita[çc][ãa]o|Emitida em|Emiss[ãa]o):?\s*(\d{2})\/(\d{2})\/(\d{2,4})/i.exec(body);
    const emissaoIso = mEmi ? `${mEmi[3].length === 2 ? "20" + mEmi[3] : mEmi[3]}-${mEmi[2]}-${mEmi[1]}` : null;
    const numero = body.match(/Protocolo:?\s*([A-Za-z0-9]+)/i)?.[1] || null;
    // Download do PDF da certidão.
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }),
      page.click("#botaoAcaoDownload, button:has-text('Download'), a:has-text('Download')"),
    ]);
    const p = await dl.path();
    const pdf = fs.readFileSync(p);
    if (pdf.slice(0, 4).toString() !== "%PDF") throw new Error("O download não veio em PDF.");
    return { tipo, validadeIso, emissaoIso, numero, pdfBase64: pdf.toString("base64") };
  } finally {
    await ctx.close().catch(() => {});
    if (!browserExterno) await browser.close().catch(() => {});
  }
}
