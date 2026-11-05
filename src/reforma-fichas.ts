// "Fichas de conferência" da auditoria da Reforma Tributária — o material que o escritório entrega pro
// cliente usar no dia a dia do setor de compras: Referências (normas, padrão ABNT) + Apêndice A (ficha
// de conferência de NF-e de compra, em branco, já personalizada com os dados do cliente) + uma ficha
// PRÉ-PREENCHIDA por fornecedor com pendência (o que a auditoria já verificou vem marcado; o resto o
// cliente completa à mão). Mesmo timbrado/receita de página do relatório e do contrato.
import { Achado } from "./reforma-auditoria";

const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const brl = (v: number) => (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dataBR = (iso: string) => (iso ? String(iso).slice(0, 10).split("-").reverse().join("/") : "");
const fmtDoc = (d: string) => {
  const x = String(d || "").replace(/\D/g, "");
  if (x.length === 14) return x.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  if (x.length === 11) return x.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  return d || "";
};
const MESES = ["jan.", "fev.", "mar.", "abr.", "maio", "jun.", "jul.", "ago.", "set.", "out.", "nov.", "dez."];

// Itens da ficha. "regras" = regras da auditoria que, se encontradas no fornecedor, marcam "Não"; se o
// item é verificável pelo XML e nada foi achado, marca "Sim". Os sem regra ficam pro cliente.
const ITENS: { texto: string; regras?: string[]; verificavel?: (ctx: Ctx) => boolean; na?: (ctx: Ctx) => boolean }[] = [
  { texto: "Dados do destinatário corretos: CNPJ, IE e endereço de {empresa}" },
  { texto: "Fornecedor com CNPJ/IE ativos (Receita/SINTEGRA) e regime tributário informado na nota (CRT)", verificavel: () => true, regras: [] },
  { texto: "NCM com 8 dígitos, vigente na data da emissão e compatível com o produto", regras: ["NCM_NAO_VIGENTE", "NCM_INVALIDO"], verificavel: () => true },
  { texto: "Grupo IBS/CBS preenchido em todos os itens (CST e cClassTrib)", regras: ["GRUPO_AUSENTE"], verificavel: (c) => c.regular, na: (c) => !c.regular },
  { texto: "CST/cClassTrib coerentes entre si e NCM autorizado para a classificação usada (validação na Calculadora oficial da RFB)", regras: ["CST_INEXISTENTE", "CCLASSTRIB_INEXISTENTE", "CST_X_CCLASSTRIB", "CCLASSTRIB_FORA_VIGENCIA", "CCLASSTRIB_MODELO", "NCM_FORA_ANEXO", "SEM_INCIDENCIA_EM_VENDA", "REDUCAO_ESQUECIDA", "CCLASSTRIB_FORA_LISTA"], verificavel: (c) => c.temGrupo, na: (c) => !c.regular && !c.temGrupo },
  { texto: "Alíquotas do ano (2026: CBS 0,9% e IBS 0,1%, com redução/diferimento quando houver); base de cálculo e valores conferem com o total", regras: ["ALIQUOTA_DIVERGENTE", "VALOR_DIVERGENTE", "BASE_DIVERGENTE", "REDUCAO_INCOERENTE", "REDUCAO_NAO_INFORMADA", "TOTAL_DIVERGENTE"], verificavel: (c) => c.temGrupo, na: (c) => !c.regular && !c.temGrupo },
  { texto: "Fornecedor do Simples Nacional: regime de IBS/CBS identificado na nota (tpRegimeIBSCBS ou grupo gTribSN — NT 2026.005)", regras: ["SN_SEM_REGIME", "SN_OPCAO_INCONSISTENTE"], verificavel: (c) => c.simples, na: (c) => !c.simples },
  { texto: "ICMS: CST/CSOSN e benefício fiscal citado (isenção, redução de base, cBenef) compatíveis com o produto" },
  { texto: "PIS/COFINS (até 2026): CST compatível e crédito identificado, quando o regime da empresa permitir" },
  { texto: "Quantidade, preço, frete e condições iguais ao pedido/cotação" },
  { texto: "Manifestação do destinatário registrada e XML arquivado e enviado ao escritório" },
];
interface Ctx { regular: boolean; simples: boolean; temGrupo: boolean; regras: Set<string> }

export interface FornecedorFicha {
  cnpj: string; nome: string; uf: string; regime: string; regimeLabel: string; recomendacao: string;
  nota: { numero: string; serie: string; dhEmi: string; valor: number | null } | null;
  temGrupo: boolean; achados: Achado[];
}

function caixa(marcado: boolean) { return marcado ? "☒" : "☐"; }

function fichaHtml(emp: { nome: string; cnpj: string; ie: string; regimeLabel: string }, f: FornecedorFicha | null, titulo: string) {
  const ctx: Ctx | null = f ? { regular: f.regime === "regular" || f.regime === "sn_regular", simples: f.regime.startsWith("sn_"), temGrupo: f.temGrupo, regras: new Set(f.achados.map((a) => a.regra)) } : null;
  const perfil = (rot: string, on: boolean) => `${caixa(on)} ${rot}`;
  const reg = f?.regime || "";
  const linhas = ITENS.map((it, i) => {
    let sim = false, nao = false, na = false;
    if (ctx) {
      if (it.na && it.na(ctx)) na = true;
      else if (it.regras && it.regras.some((r) => ctx.regras.has(r))) nao = true;
      else if (it.verificavel && it.verificavel(ctx)) sim = true;
    }
    return `<tr><td class="c">${i + 1}</td><td>${esc(it.texto.replace("{empresa}", emp.nome))}</td><td class="c">${caixa(sim)}</td><td class="c">${caixa(nao)}</td><td class="c">${caixa(na)}</td></tr>`;
  }).join("");
  const problemas = f ? [...new Set(f.achados.filter((a) => a.severidade === "alta" || a.severidade === "media").map((a) => a.titulo.replace(/ \((IBS UF|IBS Mun|CBS)\)$/, "")))] : [];
  const resultadoAuto = f ? (problemas.length ? "ressalva" : "aprovada") : "";
  const nota = f?.nota;
  const textoModelo = `“Prezado fornecedor${f ? ` ${esc(f.nome)}` : ""}, na NF-e nº ${nota ? `<b>${esc(nota.numero)}</b>` : "______"} de ${nota ? `<b>${dataBR(nota.dhEmi)}</b>` : "___/___/_____"} identificamos ${problemas.length ? `<b>${esc(problemas.slice(0, 3).join("; ").toLowerCase())}</b>` : "[ausência do grupo IBS/CBS | CST/cClassTrib incompatível | NCM divergente]"}, em desacordo com a LC nº 214/2025 e a NT 2025.002-RTC. Solicitamos a regularização (nota complementar ou substituta, ou ajuste nas próximas emissões). Informamos que a ${esc(emp.nome)} (CNPJ ${esc(fmtDoc(emp.cnpj))}), tributada pelo ${esc(emp.regimeLabel)}, ${/real|presumido/i.test(emp.regimeLabel) ? "é contribuinte do regime regular do IBS/CBS e depende do destaque correto para o crédito" : "precisa do preenchimento correto do IBS/CBS nos documentos recebidos"}. Atenciosamente, Setor de Compras.”`;
  return `<section class="ficha">
    <h2>${esc(titulo)}</h2>
    <p class="sub">${esc(emp.nome)} – CNPJ ${esc(fmtDoc(emp.cnpj))}${emp.ie ? ` – IE ${esc(emp.ie)}` : ""} – ${f ? "ficha pré-preenchida pela auditoria do escritório; complete os campos em branco" : "preencher uma ficha para cada NF-e recebida e arquivar com o XML"}</p>
    <table class="cab">
      <tr><td style="width:62%"><b>Fornecedor:</b> ${f ? esc(f.nome) : "_______________________________________"}</td><td><b>CNPJ/CPF:</b> ${f ? esc(fmtDoc(f.cnpj)) : "____________________"}</td></tr>
      <tr><td><b>NF-e nº:</b> ${nota ? esc(nota.numero) + (nota.serie ? "/" + esc(nota.serie) : "") : "__________"} &nbsp;&nbsp; <b>Emissão:</b> ${nota ? dataBR(nota.dhEmi) : "___/___/_____"}</td><td><b>Valor R$:</b> ${nota && nota.valor != null ? brl(nota.valor) : "____________________"}</td></tr>
      <tr><td><b>Recebida em:</b> ___/___/_____ &nbsp;&nbsp; <b>Pedido nº:</b> __________</td><td><b>Conferido por:</b> ____________________</td></tr>
    </table>
    <p class="perfil"><b>A) Perfil do fornecedor:</b> ${perfil("Regime regular", reg === "regular")} &nbsp; ${perfil("Simples Nacional (IBS/CBS no DAS)", reg === "sn_dentro" || reg === "sn_indefinido")} &nbsp; ${perfil("Simples com IBS/CBS no regime regular", reg === "sn_regular")} &nbsp; ${perfil("Produtor rural não contribuinte", false)} &nbsp; ${perfil("PF/MEI", reg === "mei")}</p>
    <table class="chk"><thead><tr><th class="c" style="width:5%">Nº</th><th>B) Verificar no XML/DANFE</th><th class="c" style="width:6%">Sim</th><th class="c" style="width:6%">Não</th><th class="c" style="width:6%">N/A</th></tr></thead><tbody>${linhas}</tbody></table>
    <p class="res"><b>C) Resultado:</b> ${caixa(resultadoAuto === "aprovada")} Aprovada &nbsp; ${caixa(resultadoAuto === "ressalva")} Aprovada com ressalva &nbsp; ${caixa(false)} Recusada/devolução</p>
    <p class="linha"><b>Providência/ocorrência:</b> ${f ? esc(f.recomendacao) : "_____________________________________________________________________________"}</p>
    <p class="linha"><b>Comunicado ao fornecedor em:</b> ___/___/_____ &nbsp;&nbsp; <b>Responsável:</b> ______________________________</p>
    <table class="modelo"><thead><tr><th>${f ? "Comunicação ao fornecedor" : "Texto-modelo para comunicar o fornecedor"}</th></tr></thead><tbody><tr><td>${textoModelo}</td></tr></tbody></table>
  </section>`;
}

export function htmlFichasReforma(emp: { nome: string; cnpj: string; ie: string; regimeLabel: string }, fornecedores: FornecedorFicha[], timbrado: string | null): string {
  const hoje = new Date();
  const acesso = `Acesso em: ${hoje.getDate()} ${MESES[hoje.getMonth()]} ${hoje.getFullYear()}.`;
  const refs = [
    `BRASIL. Constituição (1988). <b>Emenda Constitucional nº 132, de 20 de dezembro de 2023</b>. Altera o Sistema Tributário Nacional. Brasília, DF: Presidência da República, 2023. Disponível em: https://www.planalto.gov.br/ccivil_03/constituicao/emendas/emc/emc132.htm. ${acesso}`,
    `BRASIL. <b>Lei Complementar nº 123, de 14 de dezembro de 2006</b>. Institui o Estatuto Nacional da Microempresa e da Empresa de Pequeno Porte (Simples Nacional). Brasília, DF: Presidência da República, 2006. Disponível em: https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp123.htm. ${acesso}`,
    `BRASIL. <b>Lei Complementar nº 214, de 16 de janeiro de 2025</b>. Institui o Imposto sobre Bens e Serviços (IBS), a Contribuição Social sobre Bens e Serviços (CBS) e o Imposto Seletivo (IS). Brasília, DF: Presidência da República, 2025. Disponível em: https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp214.htm. ${acesso}`,
    `BRASIL. <b>Lei Complementar nº 224, de 26 de dezembro de 2025</b>. Brasília, DF: Presidência da República, 2025. ${acesso}`,
    `BRASIL. <b>Lei Complementar nº 227, de 2026</b>. Altera a Lei Complementar nº 214, de 16 de janeiro de 2025. Brasília, DF: Presidência da República, 2026. ${acesso}`,
    `BRASIL. Comitê Gestor do Simples Nacional. <b>Resolução CGSN nº 190, de 2026</b>. Dispõe sobre a apuração do IBS e da CBS pelo regime regular por optantes do Simples Nacional. Brasília, DF: CGSN, 2026. ${acesso}`,
    `PORTAL NACIONAL DA NOTA FISCAL ELETRÔNICA. <b>Nota Técnica 2025.002-RTC, versão 1.53</b>: Reforma Tributária do Consumo – adequações da NF-e e da NFC-e. Brasília, DF: ENCAT; RFB, 2026. Disponível em: https://www.nfe.fazenda.gov.br. ${acesso}`,
    `PORTAL NACIONAL DA NOTA FISCAL ELETRÔNICA. <b>Nota Técnica 2026.005, versão 1.00</b>: Simples Nacional na NF-e/NFC-e (IBS/CBS). Brasília, DF: ENCAT; RFB, 2026. Disponível em: https://www.nfe.fazenda.gov.br. ${acesso}`,
    `PORTAL NACIONAL DA NOTA FISCAL ELETRÔNICA. <b>Informe Técnico 2025.002, versão 1.71</b>: Tabelas de Classificação Tributária do IBS e da CBS (CST e cClassTrib). Brasília, DF: ENCAT; RFB, 2026. Disponível em: https://www.nfe.fazenda.gov.br. ${acesso}`,
    `RECEITA FEDERAL DO BRASIL; COMITÊ GESTOR DO IBS. <b>Calculadora de Tributos do Consumo (CBS/IBS)</b>: dados abertos — classificações tributárias, NCM vigentes e NCM aplicável. Brasília, DF: RFB, 2026. Disponível em: https://consumo.tributos.gov.br. ${acesso}`,
  ];
  const corpo = `
    <section><h2>REFERÊNCIAS</h2>${refs.map((r) => `<p class="ref">${r}</p>`).join("")}</section>
    ${fichaHtml(emp, null, "APÊNDICE A – FICHA DE CONFERÊNCIA DE NOTA FISCAL DE COMPRA")}
    ${fornecedores.map((f, i) => fichaHtml(emp, f, `APÊNDICE B.${i + 1} – FICHA PRÉ-PREENCHIDA: ${f.nome}`)).join("")}`;
  const bg = timbrado ? `<img class="bg" src="${timbrado}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fichas de conferência — Reforma Tributária</title><style>
  @page { size: A4; margin: ${timbrado ? "0" : "16mm 14mm"}; }
  html, body { margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; font-size: 10.5px; }
  .bg { position: fixed; top: 0; left: 0; width: 210mm; height: 297mm; z-index: -1; }
  table.layout { width: 210mm; border-collapse: collapse; } table.layout > thead td, table.layout > tfoot td, table.layout > tbody > tr > td.corpo { border: none; padding: 0; }
  .espaco-topo { height: ${timbrado ? "46mm" : "0"}; } .espaco-rodape { height: ${timbrado ? "38mm" : "0"}; }
  td.corpo { padding: 0 ${timbrado ? "22mm" : "0"} !important; vertical-align: top; }
  section { break-after: page; } section:last-child { break-after: auto; }
  h2 { font-size: 13px; text-align: center; margin: 0 0 4px; }
  .sub { text-align: center; font-size: 10px; margin: 0 0 8px; }
  .ref { font-size: 11px; line-height: 1.5; margin: 0 0 9px; text-align: left; }
  table.cab, table.chk, table.modelo { width: 100%; border-collapse: collapse; background: rgba(255,255,255,.9); }
  table.cab td { border: 1px solid #333; padding: 3px 5px; font-size: 10px; }
  table.chk th, table.chk td { border: 1px solid #333; padding: 3px 5px; font-size: 9.6px; vertical-align: middle; }
  table.chk th { background: #e8e8e8; } .c { text-align: center; } table.chk td.c { font-size: 12px; }
  tr { break-inside: avoid; }
  .perfil, .res, .linha { font-size: 10px; margin: 7px 0; line-height: 1.5; }
  table.modelo { margin-top: 8px; } table.modelo th { border: 1px solid #333; background: #e8e8e8; font-size: 10px; padding: 3px; }
  table.modelo td { border: 1px solid #333; font-size: 9.6px; padding: 5px 6px; line-height: 1.45; text-align: justify; }
  </style></head><body>${bg}<table class="layout"><thead><tr><td class="espaco-topo"></td></tr></thead><tfoot><tr><td class="espaco-rodape"></td></tr></tfoot><tbody><tr><td class="corpo">${corpo}</td></tr></tbody></table></body></html>`;
}

export async function gerarPdfFichasReforma(emp: { nome: string; cnpj: string; ie: string; regimeLabel: string }, fornecedores: FornecedorFicha[], timbrado: string | null): Promise<Buffer> {
  const html = htmlFichasReforma(emp, fornecedores, timbrado);
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ javaScriptEnabled: false });
    await page.route("**/*", (route: any) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url === "about:blank") return route.continue();
      return route.abort();
    });
    await page.setContent(html, { waitUntil: "networkidle" });
    return (await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true })) as Buffer;
  } finally {
    await browser.close();
  }
}
