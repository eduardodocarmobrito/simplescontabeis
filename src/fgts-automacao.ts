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

const PORTAL_URL = "https://fgtsdigital.sistema.gov.br/portal/servicos";
const EMISSAO_GUIA_RAPIDA_URL = "https://fgtsdigital.sistema.gov.br/cobranca/#/gestao-guias/emissao-guia-rapida";

function soDigitos(s: string): string {
  return String(s || "").replace(/\D/g, "");
}

// Confirmado num print real: no cabeçalho do portal, ao lado de "Empregador: <CNPJ> | <nome>",
// existe um botão "Trocar Perfil" que abre o mesmo modal "Definir Perfil" do fim do login — um
// combo "Perfil" (escolher "Procurador") e, ao escolher, aparece um campo de texto solto "Empregador
// a ser representado" pra digitar o CNPJ direto (não é uma lista pra clicar).
async function trocarEmpresa(page: any, cnpjDigits: string, nomeEmpresa: string) {
  // "Trocar Perfil" só existe no cabeçalho do portal principal (/portal/servicos) — depois de buscar
  // a guia de uma empresa, a página fica em /cobranca/#/... (outro sub-app), sem esse cabeçalho.
  // Achado ao vivo: a 2ª empresa de uma busca em lote falhava justamente por isso.
  if (!page.url().startsWith(PORTAL_URL)) {
    await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
  }
  const gatilho = page.getByRole("button", { name: "Trocar Perfil", exact: false }).first();
  const visivel = await gatilho.isVisible().catch(() => false);
  if (!visivel) {
    throw new Error(`Não encontrei o botão "Trocar Perfil" no cabeçalho do portal. O layout pode ter mudado.`);
  }
  await gatilho.click();
  await page.waitForTimeout(800);

  const comboPerfil = page.getByLabel("Perfil", { exact: false }).first();
  const perfilVisivel = await comboPerfil.isVisible({ timeout: 8000 }).catch(() => false);
  if (!perfilVisivel) {
    throw new Error(`Cliquei em "Trocar Perfil" mas não achei o modal "Definir Perfil" (campo "Perfil").`);
  }
  const valorAtual = await comboPerfil.inputValue().catch(() => "");
  if (!/procurador/i.test(valorAtual)) {
    await comboPerfil.click();
    await comboPerfil.fill("Procurador").catch(() => {});
    await page.waitForTimeout(500);
    const opcaoProcurador = page.getByText("Procurador", { exact: false }).last();
    if (await opcaoProcurador.isVisible({ timeout: 3000 }).catch(() => false)) await opcaoProcurador.click();
  }

  const campoEmpregador = page.getByLabel("Empregador a ser representado", { exact: false }).first();
  const campoVisivel = await campoEmpregador.isVisible({ timeout: 8000 }).catch(() => false);
  if (!campoVisivel) {
    throw new Error(`Escolhi "Procurador" mas não apareceu o campo "Empregador a ser representado" pra digitar o CNPJ.`);
  }
  await campoEmpregador.click();
  await campoEmpregador.fill("");
  await campoEmpregador.pressSequentially(cnpjDigits, { delay: 40 });
  await page.waitForTimeout(500);

  // O modal aberto via "Trocar Perfil" usa o botão "Selecionar" (confirmado num print real) —
  // diferente do "Definir" do primeiro login (aquele é feito manualmente, uma vez só).
  const btnConfirmar = page.getByRole("button", { name: "Selecionar", exact: false }).first();
  await btnConfirmar.click();
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const aindaComModal = await comboPerfil.isVisible({ timeout: 3000 }).catch(() => false);
  if (aindaComModal) {
    // Achado ao vivo: quando o Procurador não tem procuração ativa pro CNPJ digitado, o site mostra
    // um banner de erro DENTRO do mesmo modal ("Erro na operação — Não existe procuração para o
    // Número de Inscrição selecionado."), sem fechar nada sozinho — captura essa mensagem real pra
    // um erro mais claro, e sempre fecha o modal antes de sair, senão a próxima empresa da lista
    // esbarra nesse mesmo modal ainda aberto e nem acha o botão "Trocar Perfil".
    const bannerErro = await page.getByText("Erro na operação", { exact: false }).first().isVisible({ timeout: 1000 }).catch(() => false);
    let mensagemErro = `o modal continuou aberto — provavelmente o CNPJ não foi aceito (sem procuração ativa pra "${nomeEmpresa}" no FGTS Digital, ou formato errado).`;
    if (bannerErro) {
      const textoErro = await page
        .locator("text=Não existe procuração para o Número de Inscrição selecionado.")
        .first()
        .textContent()
        .catch(() => null);
      mensagemErro = textoErro
        ? `sem procuração ativa pra "${nomeEmpresa}" (${cnpjDigits}) no FGTS Digital — regularize a procuração no site antes de tentar de novo.`
        : mensagemErro;
    }
    const btnCancelar = page.getByRole("button", { name: "Cancelar", exact: false }).first();
    await btnCancelar.click({ timeout: 5000 }).catch(async () => {
      await page.getByRole("button", { name: "Fechar", exact: false }).first().click({ timeout: 5000 }).catch(() => {});
    });
    await page.waitForTimeout(800);
    throw new Error(`Preenchi o CNPJ ${cnpjDigits} e cliquei em "Selecionar", mas ${mensagemErro}`);
  }
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
