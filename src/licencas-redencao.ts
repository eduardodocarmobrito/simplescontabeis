// Consulta automática de Alvará de Funcionamento e Licença Sanitária na Prefeitura de Redenção-PA,
// via o portal "Empresa Digital" (mesmo fornecedor "Desenvolve Cidade" do cnd-redencao.ts, mas um
// app separado — login por CNPJ+senha PRÓPRIOS da empresa, não é consulta pública por CNPJ como a
// certidão). Também PrimeFaces/JSF com captcha ALTCHA (proof-of-work que o navegador resolve
// sozinho) — por isso Playwright, não requisição HTTP crua. Fluxo validado ao vivo (2026-11-26):
// aba "CNPJ" → preenche usuarioCnpj/senhaCnpj → marca o ALTCHA → "Entrar" → vai pra home.jsf →
// abre a página "Consultar Licenças e Documentos" → lista agrupada por órgão (SEFAZ: Alvará de
// Funcionamento + Laudo de Vistoria; SMS: Licença Sanitária), cada item com nome, tipo
// (Licença/Documento), nº do processo e status (Vigente/Vencida) — seletores confirmados:
// ".card-licenca" por item, ".font-weight-bold" nome, ".tipo-doc" tipo, ".card-text" (2º) processo,
// "[class*=badge-]" status ("badge-vigente"/"badge-vencida").
import fs from "fs";

const URL_LOGIN = "https://redencao-pa.desenvolvecidade.com.br/empresadigital/acessoSistema.jsf";
const URL_LICENCAS = "https://redencao-pa.desenvolvecidade.com.br/empresadigital/pages/consulta/licenca/consultarLicencas.jsf";

export type ItemLicencaRedencao = {
  grupo: string;
  nome: string;
  tipo: "licenca" | "documento";
  processo: string;
  status: "vigente" | "vencida" | string;
};

export class LoginRedencaoFalhouError extends Error {}

export async function abrirNavegadorRedencao(): Promise<any> {
  const { chromium } = require("playwright");
  return chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}

async function logar(page: any, cnpj: string, senha: string): Promise<void> {
  await page.goto(URL_LOGIN, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.click("text=CNPJ");
  await page.waitForTimeout(300);
  await page.fill("#usuarioCnpj", cnpj);
  await page.fill("#senhaCnpj", senha);
  // ALTCHA é proof-of-work resolvido pelo próprio JS da página ao marcar o checkbox — validado ao
  // vivo (2026-11-26) que ~3s de espera fixa é suficiente; o campo que de fato acusa "resolvido"
  // não é o #altchaPayloadInput (ele só é preenchido no submit), por isso espera fixa em vez de polling.
  await page.click("#altcha_checkbox_87539759").catch(() => {});
  await page.waitForTimeout(3000);
  await page.click("#botaoCapcthaCnpj");
  await page.waitForTimeout(3500);
  if (!/\/empresadigital\/(home\.jsf|pages\/)/.test(page.url())) {
    throw new LoginRedencaoFalhouError("Não consegui entrar no portal da prefeitura — confira o CNPJ e a senha.");
  }
}

// Consulta uma empresa: loga, abre "Consultar Licenças e Documentos" e lê a lista. `baixar(item)`
// decide, item a item, se vale a pena baixar o PDF agora (quem chama sabe se o processo já é
// conhecido ou é novo/renovado) — evita baixar tudo sempre à toa. Reaproveita um browser já aberto
// (bulk, ver licencaRedencaoConsultarTodas em server.ts) ou abre/fecha um só pra esta chamada.
export async function consultarLicencasRedencao(
  cnpj: string,
  senha: string,
  opts: { baixar?: (item: ItemLicencaRedencao) => boolean; browserExterno?: any } = {}
): Promise<{ itens: (ItemLicencaRedencao & { pdfBase64?: string })[] }> {
  const browser = opts.browserExterno || (await abrirNavegadorRedencao());
  const ctx = await browser.newContext({ acceptDownloads: true });
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    await logar(page, cnpj, senha);
    await page.goto(URL_LICENCAS, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(2000);
    const itensBase: ItemLicencaRedencao[] = await page.evaluate(() => {
      return Array.from(document.querySelectorAll(".card-licenca")).map((it) => {
        const badge = it.querySelector('[class*="badge-"]');
        const grupo = (it.closest(".card.new-box-outline")?.querySelector(".titulo-licenca")?.textContent || "").trim();
        const tipoClasse = it.querySelector(".tipo-doc")?.className || "";
        const statusClasse = badge?.className || "";
        return {
          grupo,
          nome: (it.querySelector(".font-weight-bold")?.textContent || "").trim(),
          tipo: /documento/.test(tipoClasse) ? "documento" : "licenca",
          processo: (it.querySelectorAll(".card-text")[1]?.textContent || "").replace("Processo:", "").trim(),
          status: /badge-vigente/.test(statusClasse) ? "vigente" : /badge-vencida/.test(statusClasse) ? "vencida" : (badge?.textContent || "").trim().toLowerCase() || "desconhecido",
        } as ItemLicencaRedencao;
      });
    });
    const itens: (ItemLicencaRedencao & { pdfBase64?: string })[] = [];
    for (const item of itensBase) {
      let pdfBase64: string | undefined;
      if (opts.baixar?.(item)) {
        try {
          const card = page.locator(".card-licenca").filter({ hasText: item.processo }).filter({ hasText: item.nome }).first();
          const [dl] = await Promise.all([
            page.waitForEvent("download", { timeout: 20000 }),
            card.locator('a[title="Download"]').click(),
          ]);
          const p = await dl.path();
          if (p) {
            const buf = fs.readFileSync(p);
            if (buf.slice(0, 4).toString() === "%PDF") pdfBase64 = buf.toString("base64");
          }
        } catch (e: any) {
          console.error(`[licencas-redencao] falha ao baixar PDF de "${item.nome}" (${item.processo}):`, e.message);
        }
      }
      itens.push({ ...item, pdfBase64 });
    }
    return { itens };
  } finally {
    await ctx.close().catch(() => {});
    if (!opts.browserExterno) await browser.close().catch(() => {});
  }
}
