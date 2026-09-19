/**
 * Busca da Guia FGTS Digital (GFD) — confirmado em teste real que a sessão autenticada do FGTS
 * Digital NÃO sobrevive fora do navegador/conexão que fez o login (mesmo reapresentando o mesmo
 * certificado depois, o próprio app detecta "Erro de Login" e volta pra tela pública) — é uma
 * proteção de segurança do próprio gov.br, amarrando a sessão à conexão original, não um bug daqui.
 * Por isso, diferente do padrão da Onvio, NÃO dá pra salvar uma sessão e reaproveitar depois num
 * processo headless separado: a busca inteira (login manual + guia de cada empresa) precisa
 * acontecer numa tacada só, no mesmo navegador, dentro de `fgts-login-setup.ts`.
 *
 * Este arquivo só expõe a lógica por-empresa (trocar empresa + buscar/baixar a guia), reaproveitada
 * pelo fgts-login-setup.ts logo depois do login manual, com o navegador ainda aberto e autenticado.
 *
 * Fluxo mapeado com prints reais do usuário: portal/servicos > "GESTÃO DE GUIAS" >
 * "EMISSÃO DE GUIA RÁPIDA" > preencher Competência de Apuração > "Pesquisar" > card "Mensal" >
 * "Emitir guia" > (se já existir guia não paga) confirmar no modal "Gerar guia" > PDF baixa
 * automaticamente pelo navegador.
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

const EMISSAO_GUIA_RAPIDA_URL = "https://fgtsdigital.sistema.gov.br/cobranca/#/gestao-guias/emissao-guia-rapida";

function soDigitos(s: string): string {
  return String(s || "").replace(/\D/g, "");
}

// O seletor de troca de empresa (visível no cabeçalho "Empregador: <CNPJ> | <nome>", confirmado
// pelo usuário que existe um menu pra trocar sem logar de novo) ainda não foi visto num print real
// — tenta um caminho razoável a partir do texto "Empregador" e lança um erro claro e específico se
// não achar, pra ajustar depois de ver esse erro numa busca real (não adivinha o DOM às cegas).
async function trocarEmpresa(page: any, cnpjDigits: string, nomeEmpresa: string) {
  const gatilho = page.getByText("Empregador:", { exact: false }).first();
  const visivel = await gatilho.isVisible().catch(() => false);
  if (!visivel) {
    throw new Error(
      `Não encontrei o seletor de troca de empresa (texto "Empregador:") na tela do portal. ` +
        `O layout pode ter mudado ou não é isso que abre o menu de troca.`
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
    throw new Error('Cliquei em "Emitir guia" mas o download do PDF não começou — pode ter aparecido um aviso/erro diferente do esperado na tela.');
  }
  const nomeArquivo = download.suggestedFilename() || `guia-fgts-${competenciaTexto.replace("/", "-")}.pdf`;
  const caminho = await download.path();
  if (!caminho) throw new Error("O download do PDF da guia FGTS falhou (arquivo não ficou disponível).");
  const fs = require("fs");
  const pdfBuffer: Buffer = fs.readFileSync(caminho);
  return { guiaGerada: true, pdfBuffer, nomeArquivo };
}

// Busca a guia de UMA empresa, dentro de uma página/sessão já autenticada e ainda viva (chamado em
// loop por fgts-login-setup.ts, logo após o login manual, no mesmo navegador) — nunca abre nem
// fecha navegador/contexto, e nunca deixa uma exceção escapar (vira {ok:false, erro} pro chamador
// seguir pra próxima empresa mesmo se uma falhar).
export async function buscarGuiaFgtsEmpresa(
  page: any,
  empresa: EmpresaParaBuscaFgts,
  competencia: { ano: number; mes: number }
): Promise<ResultadoFgtsEmpresa> {
  try {
    await trocarEmpresa(page, soDigitos(empresa.cnpj), empresa.nome);
    const r = await buscarGuiaDaEmpresaAtual(page, competencia.ano, competencia.mes);
    if (!r.guiaGerada) {
      return { empresaId: empresa.empresaId, nome: empresa.nome, ok: true, guiaGerada: false };
    }
    return {
      empresaId: empresa.empresaId,
      nome: empresa.nome,
      ok: true,
      guiaGerada: true,
      pdfBase64: r.pdfBuffer!.toString("base64"),
      nomeArquivo: r.nomeArquivo,
    };
  } catch (e: any) {
    return { empresaId: empresa.empresaId, nome: empresa.nome, ok: false, guiaGerada: false, erro: e.message };
  }
}
