import QRCode from "qrcode";
import { DOMParser } from "@xmldom/xmldom";

/**
 * DANFSe 2.0 — Documento Auxiliar da NFS-e, gerado localmente a partir do XML da NFS-e emitida.
 *
 * A API do governo que gerava esse PDF (https://adn.nfse.gov.br/danfse) foi suspensa em 03/08/2026
 * — a partir dessa data, cada sistema emissor passou a ser responsável por montar o próprio DANFSe,
 * seguindo à risca o leiaute oficial: Nota Técnica SE/CGNFS-e nº 008, versão 1.02, de 14/07/2026
 * ("Especificações Técnicas do DANFSe"). Todas as posições/tamanhos de campo abaixo (em centímetros,
 * página A4 retrato) vêm da tabela do item 2.4.5 dessa nota técnica — não são um layout inventado.
 *
 * Só usa dados que já estão no próprio XML armazenado (nfse_emissoes.xml_nfse) — nenhuma informação
 * é inventada; campo sem dado no XML sai como "-" (regra da nota técnica, item 2.4.5, nota 12).
 */

// ---------------- Navegação no XML (sem namespace prefixado — NFSe usa xmlns default) ----------------
function firstChildByTag(el: any, tag: string): any {
  if (!el) return null;
  const children = el.childNodes ? Array.from(el.childNodes as any[]) : [];
  for (const c of children as any[]) {
    if (c.nodeType === 1 && c.nodeName === tag) return c;
  }
  return null;
}
function path(el: any, ...tags: string[]): any {
  let cur = el;
  for (const t of tags) cur = firstChildByTag(cur, t);
  return cur;
}
function text(el: any, ...tags: string[]): string | null {
  const node = path(el, ...tags);
  const t = node?.textContent?.trim();
  return t ? t : null;
}
function allChildrenByTag(el: any, tag: string): any[] {
  if (!el) return [];
  return (Array.from(el.childNodes as any[]) || []).filter((c: any) => c.nodeType === 1 && c.nodeName === tag);
}

// ---------------- Formatação ----------------
function fmtDoc(doc: string | null): string {
  if (!doc) return "-";
  const d = doc.replace(/\D/g, "");
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  return doc;
}
function fmtDinheiro(v: string | null): string {
  const n = v != null ? Number(v) : NaN;
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(v: string | null): string {
  const n = v != null ? Number(v) : NaN;
  if (!Number.isFinite(n)) return "-";
  return `${n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}
function fmtDataBr(iso: string | null): string {
  if (!iso) return "-";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}
function fmtDataHoraBr(iso: string | null): string {
  if (!iso) return "-";
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}:${m[6]}` : iso;
}
function reticencias(s: string | null, max: number): string {
  if (!s) return "-";
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function concatEndereco(end: any): string | null {
  if (!end) return null;
  const partes = [text(end, "xLgr"), text(end, "nro"), text(end, "xCpl"), text(end, "xBairro")].filter(Boolean);
  return partes.length ? partes.join(", ") : null;
}
function concatMunicipioUf(nomeMun: string | null, uf: string | null): string | null {
  if (!nomeMun && !uf) return null;
  return [nomeMun, uf].filter(Boolean).join(" / ");
}

// ---------------- Tabelas de domínio (só os códigos que este sistema realmente produz — ver
// src/nfse.ts montarXmlDps; valor fora da tabela cai no fallback "cód. N", nunca inventa descrição) ----------------
const LABEL_TP_AMB: Record<string, string> = { "1": "Produção", "2": "Homologação" };
const LABEL_AMB_GER: Record<string, string> = { "1": "Sistema do Município", "2": "Sistema Nacional" };
const LABEL_TP_EMIT: Record<string, string> = { "1": "Prestador", "2": "Tomador", "3": "Intermediário" };
const LABEL_FIN_NFSE: Record<string, string> = { "0": "NFS-e Normal", "1": "NFS-e Complementar", "2": "NFS-e de Ajuste", "3": "NFS-e Substituta" };
const LABEL_CSTAT: Record<string, string> = { "100": "NFS-e Regularmente Emitida" };
const LABEL_OP_SIMP_NAC: Record<string, string> = { "1": "Não Optante", "2": "Optante MEI", "3": "Optante ME/EPP" };
const LABEL_REG_AP_TRIB_SN: Record<string, string> = {
  "1": "Regime de apuração dos tributos federais e municipal pelo Simples Nacional",
  "2": "Regime de apuração dos tributos federais pelo Simples Nacional e municipal por fora",
  "3": "Isento de ISSQN",
};
const LABEL_REG_ESP_TRIB: Record<string, string> = {
  "0": "Nenhum",
  "1": "Estimativa",
  "2": "Sociedade de Profissionais",
  "3": "Cooperativa",
  "4": "Microempresário Individual (MEI)",
  "5": "Microempresário e Empresa de Pequeno Porte (ME/EPP)",
  "6": "Notário/Registral",
  "9": "Outros",
};
const LABEL_TRIB_ISSQN: Record<string, string> = { "1": "Operação Tributável", "2": "Imunidade", "3": "Exportação de Serviço", "4": "Não Incidência" };
const LABEL_TP_RET_ISSQN: Record<string, string> = { "1": "Não Retido", "2": "Retido pelo Tomador", "3": "Retido pelo Intermediário" };
const LABEL_TP_RET_PIS_COFINS: Record<string, string> = { "1": "PIS/COFINS Retido", "2": "PIS/COFINS Não Retido" };
const LABEL_TP_SUSP: Record<string, string> = { "1": "Exigibilidade Suspensa por Decisão Judicial", "2": "Exigibilidade Suspensa por Processo Administrativo" };

function rotulo(tabela: Record<string, string>, codigo: string | null): string {
  if (!codigo) return "-";
  return tabela[codigo] || `Cód. ${codigo}`;
}

// ---------------- Extração dos dados do XML ----------------
export type DadosDanfse = ReturnType<typeof extrairDadosDanfse>;

export function extrairDadosDanfse(xmlNfse: string) {
  const doc = new DOMParser({ errorHandler: () => {} } as any).parseFromString(xmlNfse, "text/xml");
  const nfse = doc.documentElement; // <NFSe>
  const infNFSe = firstChildByTag(nfse, "infNFSe");
  const dps = path(infNFSe, "DPS");
  const infDPS = path(dps, "infDPS");
  const prest = path(infDPS, "prest");
  const toma = path(infDPS, "toma");
  const dest = path(infDPS, "IBSCBS", "dest");
  const interm = path(infDPS, "interm");
  const serv = path(infDPS, "serv");
  const cServ = path(serv, "cServ");
  const valoresDps = path(infDPS, "valores");
  const trib = path(valoresDps, "trib");
  const tribMun = path(trib, "tribMun");
  const tribFed = path(trib, "tribFed");
  const piscofins = path(tribFed, "piscofins");
  const totTrib = path(trib, "totTrib");
  const ibscbs = path(infDPS, "IBSCBS");
  const ibscbsValores = path(ibscbs, "valores");
  const gIBSCBS = path(ibscbsValores, "trib", "gIBSCBS");
  const infNFSeIbscbs = path(infNFSe, "IBSCBS"); // totais apurados ficam em infNFSe/IBSCBS/totCIBS, não em DPS
  const totCIBS = path(infNFSeIbscbs, "totCIBS");
  const gIBS = path(totCIBS, "gIBS");
  const gCBS = path(totCIBS, "gCBS");
  const valoresNfse = path(infNFSe, "valores");
  const infoCompl = path(serv, "infoCompl");

  const emit = firstChildByTag(infNFSe, "emit"); // dados cadastrais do prestador na hora da emissão (pode diferir do "prest" da DPS em detalhes de contato)

  // A chave de acesso vem no atributo Id do próprio elemento <infNFSe Id="NFS..."> — não é uma tag
  // filha, então não dá pra usar o helper text()/path() aqui.
  const chaveAcessoBruta = infNFSe?.getAttribute ? infNFSe.getAttribute("Id") : null;

  return {
    // Identificação
    chaveAcesso: chaveAcessoBruta ? chaveAcessoBruta.replace(/^NFS/, "") : "-",
    numeroNFSe: text(infNFSe, "nNFSe") || "-",
    competencia: fmtDataBr(text(infDPS, "dCompet")),
    dhEmissaoNFSe: fmtDataHoraBr(text(infNFSe, "dhProc")),
    numeroDPS: text(infDPS, "nDPS") || "-",
    serieDPS: text(infDPS, "serie") || "-",
    dhEmissaoDPS: fmtDataHoraBr(text(infDPS, "dhEmi")),
    emitenteNFSe: rotulo(LABEL_TP_EMIT, text(infDPS, "tpEmit")),
    situacaoNFSe: rotulo(LABEL_CSTAT, text(infNFSe, "cStat")),
    finalidade: rotulo(LABEL_FIN_NFSE, text(infDPS, "IBSCBS", "finNFSe") || text(ibscbs, "finNFSe")),
    municipioEmitente: text(infNFSe, "xLocEmi") || "-",
    ufEmitente: text(emit, "enderNac", "UF") || "",
    ambienteGerador: rotulo(LABEL_AMB_GER, text(infNFSe, "ambGer")),
    tipoAmbiente: rotulo(LABEL_TP_AMB, text(infDPS, "tpAmb")),
    homologacao: text(infDPS, "tpAmb") === "2",

    // Prestador
    prestDoc: fmtDoc(text(prest, "CNPJ") || text(prest, "CPF")),
    prestIM: text(prest, "IM") || "-",
    prestFone: text(prest, "fone") || text(emit, "fone") || "-",
    prestNome: reticencias(text(emit, "xNome") || text(prest, "xNome"), 77),
    prestMunicipioUf: concatMunicipioUf(text(infNFSe, "xLocEmi"), text(emit, "enderNac", "UF")) || "-",
    prestCepIbge: [text(emit, "enderNac", "cMun"), text(emit, "enderNac", "CEP")].filter(Boolean).join(" / ") || "-",
    prestEndereco: reticencias(concatEndereco(path(emit, "enderNac")), 77),
    prestEmail: reticencias(text(prest, "email") || text(emit, "email"), 80),
    prestSimplesNacional: rotulo(LABEL_OP_SIMP_NAC, text(prest, "regTrib", "opSimpNac")),
    prestRegimeApuracaoSN: text(prest, "regTrib", "opSimpNac") === "3" ? reticencias(rotulo(LABEL_REG_AP_TRIB_SN, text(prest, "regTrib", "regApTribSN") || "1"), 77) : "-",

    // Tomador
    tomaVazio: !toma,
    tomaDoc: fmtDoc(text(toma, "CNPJ") || text(toma, "CPF")),
    tomaIM: text(toma, "IM") || "-",
    tomaFone: text(toma, "fone") || "-",
    tomaNome: reticencias(text(toma, "xNome"), 77),
    // Sem tabela IBGE (código→nome) disponível neste sistema pra resolver o nome do município do
    // tomador (diferente do prestador/emitente, cujo nome já vem pronto em NFSe/infNFSe/xLocEmi) —
    // mostra o código bruto em vez de inventar um nome ou esconder o dado que existe de verdade.
    tomaMunicipioUf: text(toma, "end", "endNac", "cMun") ? `Cód. IBGE ${text(toma, "end", "endNac", "cMun")}` : "-",
    tomaCepIbge: [text(toma, "end", "endNac", "cMun"), text(toma, "end", "endNac", "CEP")].filter(Boolean).join(" / ") || "-",
    tomaEndereco: reticencias(concatEndereco(path(toma, "end")), 77),
    tomaEmail: reticencias(text(toma, "email"), 80),

    // Destinatário da operação (IBSCBS/dest) — este sistema ainda não emite operações com
    // destinatário distinto do tomador, então normalmente sai "não identificado" (regra 2.3.1).
    destVazio: !dest,
    destDoc: fmtDoc(text(dest, "CNPJ") || text(dest, "CPF")),
    destFone: text(dest, "fone") || "-",
    destNome: reticencias(text(dest, "xNome"), 77),
    destEndereco: reticencias(concatEndereco(path(dest, "end")), 77),
    destEmail: reticencias(text(dest, "email"), 80),

    // Intermediário — este sistema não emite com intermediário.
    intermVazio: !interm,
    intermDoc: fmtDoc(text(interm, "CNPJ") || text(interm, "CPF")),
    intermIM: text(interm, "IM") || "-",
    intermFone: text(interm, "fone") || "-",
    intermNome: reticencias(text(interm, "xNome"), 77),
    intermEndereco: reticencias(concatEndereco(path(interm, "end")), 77),
    intermEmail: reticencias(text(interm, "email"), 80),

    // Serviço
    codTribNacMun: [text(cServ, "cTribNac"), text(cServ, "cTribMun")].filter(Boolean).join(" / ") || "-",
    codNBS: text(cServ, "cNBS") || "-",
    localPrestacaoUfPais: text(infNFSe, "xLocPrestacao") || "-",
    descricaoTributacao: reticencias(text(infNFSe, "xTribMun") || text(infNFSe, "xTribNac"), 167),
    descricaoServico: reticencias(text(cServ, "xDescServ"), 1297),

    // ISSQN
    tribIssqnVazio: !tribMun,
    tipoTributacaoIssqn: rotulo(LABEL_TRIB_ISSQN, text(tribMun, "tribISSQN")),
    localIncidenciaIssqn: text(infNFSe, "xLocIncid") || "-",
    regimeEspecialIssqn: reticencias(rotulo(LABEL_REG_ESP_TRIB, text(prest, "regTrib", "regEspTrib") || "0"), 27),
    tipoImunidadeIssqn: "-",
    suspensaoIssqn: text(tribMun, "exigSusp", "tpSusp") ? reticencias(rotulo(LABEL_TP_SUSP, text(tribMun, "exigSusp", "tpSusp")), 37) : "-",
    numeroProcessoSuspensao: text(tribMun, "exigSusp", "nProcesso") || "-",
    beneficioMunicipal: "-",
    calculoBM: "-",
    totalDeducoes: "-",
    descontoIncondicionadoIssqn: "-",
    bcIssqn: fmtDinheiro(text(valoresNfse, "vBC")),
    aliquotaAplicada: fmtPct(text(tribMun, "pAliq")),
    retencaoIssqn: rotulo(LABEL_TP_RET_ISSQN, text(tribMun, "tpRetISSQN")),
    issqnApurado: fmtDinheiro(text(valoresNfse, "vISSQN")),

    // Tributação Federal (exceto CBS)
    irrf: fmtDinheiro(text(tribFed, "vRetIRRF")),
    contribPrevidenciaria: fmtDinheiro(text(tribFed, "vRetCP")),
    contribSociaisRetidas: fmtDinheiro(text(tribFed, "vRetCSLL")),
    pisDebito: fmtDinheiro(text(piscofins, "vPis")),
    cofinsDebito: fmtDinheiro(text(piscofins, "vCofins")),
    descricaoContribSociais: rotulo(LABEL_TP_RET_PIS_COFINS, text(piscofins, "tpRetPisCofins")),

    // IBS/CBS — a maioria das notas emitidas hoje ainda não preenche esse grupo (opcional até a
    // Reforma Tributária exigir); quando ausente, cada campo sai como "-" (nota 12 da NT 008).
    ibscbsPreenchido: !!ibscbs,
    cstCclasstrib: [text(gIBSCBS, "CST"), text(gIBSCBS, "cClassTrib")].filter(Boolean).join(" / ") || "-",
    indOperacaoIbscbs: [text(ibscbs, "cIndOp"), text(infNFSeIbscbs, "cLocalidadeIncid"), text(infNFSeIbscbs, "xLocalidadeIncid")].filter(Boolean).join(" / ") || "-",
    exclusoesReducoesBc: "-",
    bcApósExclusoes: fmtDinheiro(text(ibscbsValores, "vBC")),
    reducaoAliquotaIbsCbs: [fmtPct(text(ibscbsValores, "uf", "pRedAliqUF")), fmtPct(text(ibscbsValores, "mun", "pRedAliqMun")), fmtPct(text(ibscbsValores, "fed", "pRedAliqCBS"))].join(" / "),
    aliquotaIbsUfMun: [fmtPct(text(ibscbsValores, "uf", "pIBSUF")), fmtPct(text(ibscbsValores, "mun", "pIBSMun"))].join(" / "),
    aliquotaEfetivaMunIbs: fmtPct(text(ibscbsValores, "mun", "pAliqEfetMun")),
    valorApuradoMunIbs: fmtDinheiro(text(gIBS, "gIBSMunTot", "vIBSMun")),
    aliquotaEfetivaUfIbs: fmtPct(text(ibscbsValores, "uf", "pAliqEfetUF")),
    valorApuradoUfIbs: fmtDinheiro(text(gIBS, "gIBSUFTot", "vIBSUF")),
    valorTotalIbs: fmtDinheiro(text(gIBS, "vIBSTot")),
    aliquotaCbs: fmtPct(text(ibscbsValores, "fed", "pCBS")),
    aliquotaEfetivaCbs: fmtPct(text(ibscbsValores, "fed", "pAliqEfetCBS")),
    valorTotalCbs: fmtDinheiro(text(gCBS, "vCBS")),

    // Valor total
    valorServico: fmtDinheiro(text(valoresDps, "vServPrest", "vServ")),
    descontoIncondicionado: fmtDinheiro(text(valoresDps, "vDescCondIncond", "vDescIncond") || text(valoresDps, "vDescIncond")),
    descontoCondicionado: fmtDinheiro(text(valoresDps, "vDescCondIncond", "vDescCond") || text(valoresDps, "vDescCond")),
    totalRetencoes: fmtDinheiro(text(valoresNfse, "vTotalRet")),
    valorLiquidoNFSe: fmtDinheiro(text(valoresNfse, "vLiq")),
    totalIbsCbs: fmtDinheiro((() => {
      const ibs = Number(text(gIBS, "vIBSTot") || 0);
      const cbs = Number(text(gCBS, "vCBS") || 0);
      return ibs || cbs ? String(ibs + cbs) : null;
    })()),
    valorLiquidoTotal: fmtDinheiro(text(totCIBS, "vTotNF") || text(valoresNfse, "vLiq")),

    // Informações complementares
    docReferencia: text(infoCompl, "docRef"),
    xInfComp: text(infoCompl, "xInfComp"),
    totTribFed: text(totTrib, "pTotTribSN"),

    // XML bruto (não exibido — só pra debug/relatório de erro se algo faltar)
    _tinhaXml: !!infNFSe,
  };
}

// ---------------- QR Code ----------------
async function gerarQrCodeDataUri(chaveAcesso: string): Promise<string> {
  const url = `https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${chaveAcesso}`;
  return QRCode.toDataURL(url, { margin: 0, errorCorrectionLevel: "M", width: 300 });
}

// ---------------- Layout (posições em cm — Nota Técnica 008/2026 v1.02, item 2.4.5 e Anexo I) ----------------
// A tabela do item 2.4.5 dá X/Y absolutos por campo, mas o Anexo I (modelo visual) mostra que o
// "título do bloco" (ex.: "PRESTADOR / FORNECEDOR") NÃO é uma barra separada acima da 1ª linha de
// campos — ele OCUPA a própria coluna 1 da 1ª linha, lado a lado com CNPJ/IM/Telefone na mesma
// altura. Por isso o layout abaixo é montado linha a linha (grade de 4 colunas de 5,09cm), com o
// título do bloco entrando como mais uma célula — não como uma linha extra.
const MARGEM = 0.3;
const COL_W = 5.09;
const COL_X = [MARGEM, 5.41, 10.51, 15.62];
const LARG_DUPLA = 10.19;
const LARG_TOTAL = 20.4;
const ROW_H = 0.64;
const ALTURA_MIN_SUPRIMIDO = 0.32;

type CelulaSpec = { label?: string; valor: string; col: number; largura?: number; destaque?: boolean };
type LinhaHtmlOpts = { top: number; height?: number };

function celulaHtml(c: CelulaSpec, top: number, height: number): string {
  const left = COL_X[c.col];
  const width = c.largura ?? COL_W;
  return `<div class="campo${c.destaque ? " campo-destaque" : ""}" style="top:${top}cm; left:${left}cm; width:${width}cm; height:${height}cm;">
    ${c.label ? `<div class="campo-label">${esc(c.label)}</div>` : ""}
    <div class="campo-valor">${esc(c.valor)}</div>
  </div>`;
}
// Uma linha de campos, todos na mesma altura Y — cada CelulaSpec já diz em qual coluna (0-3) cai.
function linha(celulas: CelulaSpec[], opts: LinhaHtmlOpts): string {
  const h = opts.height ?? ROW_H;
  return celulas.map((c) => celulaHtml(c, opts.top, h)).join("\n");
}
// Bloco com título ocupando a coluna 1 da 1ª linha (o caso comum: Prestador, Tomador, Destinatário,
// Intermediário, Serviço Prestado, Tributação Municipal/Federal/IBS-CBS, Valor Total).
function blocoComTitulo(titulo: string, top: number, linhas: CelulaSpec[][]): { html: string; alturaTotal: number } {
  const partes: string[] = [];
  partes.push(`<div class="bloco-titulo-inline" style="top:${top}cm; left:${MARGEM}cm; width:${COL_W}cm; height:${ROW_H}cm;">${esc(titulo)}</div>`);
  linhas.forEach((celulas, i) => partes.push(linha(celulas, { top: top + i * ROW_H })));
  return { html: partes.join("\n"), alturaTotal: linhas.length * ROW_H };
}
// Bloco suprimido (dados vazios): uma única faixa de largura total com o texto substituto, centralizado.
function blocoSuprimido(texto: string, top: number): { html: string; alturaTotal: number } {
  const html = `<div class="bloco-suprimido" style="top:${top}cm; left:${MARGEM}cm; width:${LARG_TOTAL}cm; height:${ALTURA_MIN_SUPRIMIDO}cm;">${esc(texto)}</div>`;
  return { html, alturaTotal: ALTURA_MIN_SUPRIMIDO };
}

export function gerarDanfseHtml(d: DadosDanfse, opts: { qrCodeDataUri: string; marcaDagua?: "CANCELADA" | "SUBSTITUIDA" }): string {
  const campos: string[] = [];
  let y: number;

  // ---- Cabeçalho ----
  campos.push(`<div class="cabecalho-borda" style="top:0.30cm; left:0.30cm; width:20.40cm; height:1.16cm;"></div>`);
  campos.push(`<div class="logo-nfse" style="top:0.44cm; left:0.49cm; width:4.00cm; height:0.85cm;">NFS-e</div>`);
  campos.push(`<div class="titulo-danfse" style="top:0.30cm; left:5.41cm; width:10.19cm; height:1.16cm;">
    <div class="titulo-danfse-l1">DANFSe v2.0</div>
    <div class="titulo-danfse-l2">Documento Auxiliar da NFS-e</div>
    ${d.homologacao ? `<div class="titulo-danfse-homolog">NFS-e SEM VALIDADE JURÍDICA</div>` : ""}
  </div>`);
  campos.push(`<div class="ident-municipio" style="top:0.30cm; left:15.62cm; width:5.09cm; height:1.16cm;">
    <div class="ident-municipio-nome">${esc(d.municipioEmitente)}${d.ufEmitente ? ` / ${esc(d.ufEmitente)}` : ""}</div>
    <div class="ident-municipio-amb">${esc(d.ambienteGerador)}</div>
    <div class="ident-municipio-amb">${esc(d.tipoAmbiente)}</div>
  </div>`);
  campos.push(`<div class="qrcode-box" style="top:1.67cm; left:17.48cm; width:1.52cm; height:1.52cm;"><img src="${opts.qrCodeDataUri}"></div>`);
  campos.push(`<div class="qrcode-complemento" style="top:3.36cm; left:15.80cm; width:4.72cm; height:0.68cm;">A autenticidade desta NFS-e pode ser verificada pela leitura deste código QR ou pela consulta da chave de acesso no portal nacional da NFS-e</div>`);

  // ---- Dados de identificação da NFS-e (sem título de bloco visível — ver Anexo I) ----
  // Y absolutos fixos, direto da NT 008 (1,48 / 2,27 / 2,96 / 3,65) — não acumulados a partir de
  // ROW_H, pra não desalinhar com o complemento do QR Code (que tem posição própria fixa em 3,36).
  // Larguras exatas da NT 008 (item 2.4.5) — a chave e os 3 campos da coluna 3 (Data/Hora NFS-e,
  // Data/Hora DPS, Finalidade) são largura simples (não dupla), pra não invadir a faixa reservada
  // ao QR Code (Esq. 17,48) e ao texto abaixo dele — invadir causava linha de grade cruzando por
  // cima do QR, como no print comparado com o portal oficial.
  campos.push(linha([{ label: "Chave de Acesso da NFS-e", valor: d.chaveAcesso, col: 0, largura: 15.3 }], { top: 1.48, height: 0.77 }));
  campos.push(
    linha(
      [
        { label: "Número da NFS-e", valor: d.numeroNFSe, col: 0 },
        { label: "Competência da NFS-e", valor: d.competencia, col: 1 },
        { label: "Data e Hora da Emissão da NFS-e", valor: d.dhEmissaoNFSe, col: 2 },
      ],
      { top: 2.27, height: 0.67 }
    )
  );
  campos.push(
    linha(
      [
        { label: "Número da DPS", valor: d.numeroDPS, col: 0 },
        { label: "Série da DPS", valor: d.serieDPS, col: 1 },
        { label: "Data e Hora da Emissão da DPS", valor: d.dhEmissaoDPS, col: 2 },
      ],
      { top: 2.96, height: 0.67 }
    )
  );
  campos.push(
    linha(
      [
        { label: "Emitente da NFS-e", valor: d.emitenteNFSe, col: 0, destaque: true },
        { label: "Situação da NFS-e", valor: d.situacaoNFSe, col: 1 },
        { label: "Finalidade", valor: d.finalidade, col: 2 },
      ],
      { top: 3.65, height: 0.67 }
    )
  );
  y = 4.34; // início do bloco PRESTADOR / FORNECEDOR — fixo pela NT 008.

  // ---- Prestador ----
  {
    const b = blocoComTitulo("PRESTADOR / FORNECEDOR", y, [
      [
        { label: "CNPJ / CPF / NIF", valor: d.prestDoc, col: 1 },
        { label: "Indicador Municipal (Inscrição)", valor: d.prestIM, col: 2 },
        { label: "Telefone", valor: d.prestFone, col: 3 },
      ],
      [
        { label: "Nome / Nome Empresarial", valor: d.prestNome, col: 0, largura: LARG_DUPLA },
        { label: "Município / Sigla UF", valor: d.prestMunicipioUf, col: 2 },
        { label: "Código IBGE / CEP", valor: d.prestCepIbge, col: 3 },
      ],
      [
        { label: "Endereço", valor: d.prestEndereco, col: 0, largura: LARG_DUPLA },
        { label: "Email", valor: d.prestEmail, col: 2, largura: LARG_DUPLA },
      ],
      [
        { label: "Simples Nacional na Data de Competência", valor: d.prestSimplesNacional, col: 0 },
        { label: "Regime de Apuração Tributária pelo SN", valor: d.prestRegimeApuracaoSN, col: 2, largura: LARG_DUPLA },
      ],
    ]);
    campos.push(b.html);
    y += b.alturaTotal;
  }

  // ---- Tomador ----
  if (d.tomaVazio) {
    const b = blocoSuprimido("TOMADOR/ADQUIRENTE DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e", y);
    campos.push(b.html);
    y += b.alturaTotal;
  } else {
    const b = blocoComTitulo("TOMADOR / ADQUIRENTE", y, [
      [
        { label: "CNPJ / CPF / NIF", valor: d.tomaDoc, col: 1 },
        { label: "Indicador Municipal (Inscrição)", valor: d.tomaIM, col: 2 },
        { label: "Telefone", valor: d.tomaFone, col: 3 },
      ],
      [
        { label: "Nome / Nome Empresarial", valor: d.tomaNome, col: 0, largura: LARG_DUPLA },
        { label: "Município / Sigla UF", valor: d.tomaMunicipioUf, col: 2 },
        { label: "Código IBGE / CEP", valor: d.tomaCepIbge, col: 3 },
      ],
      [
        { label: "Endereço", valor: d.tomaEndereco, col: 0, largura: LARG_DUPLA },
        { label: "E-mail", valor: d.tomaEmail, col: 2, largura: LARG_DUPLA },
      ],
    ]);
    campos.push(b.html);
    y += b.alturaTotal;
  }

  // ---- Destinatário ----
  if (d.destVazio) {
    const b = blocoSuprimido("DESTINATÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e", y);
    campos.push(b.html);
    y += b.alturaTotal;
  } else {
    const b = blocoComTitulo("DESTINATÁRIO DA OPERAÇÃO", y, [
      [
        { label: "CNPJ / CPF / NIF", valor: d.destDoc, col: 1 },
        { label: "Telefone", valor: d.destFone, col: 3 },
      ],
      [
        { label: "Nome / Nome Empresarial", valor: d.destNome, col: 0, largura: LARG_DUPLA },
        { label: "Email", valor: d.destEmail, col: 2, largura: LARG_DUPLA },
      ],
      [{ label: "Endereço", valor: d.destEndereco, col: 0, largura: LARG_DUPLA }],
    ]);
    campos.push(b.html);
    y += b.alturaTotal;
  }

  // ---- Intermediário ----
  if (d.intermVazio) {
    const b = blocoSuprimido("INTERMEDIÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e", y);
    campos.push(b.html);
    y += b.alturaTotal;
  } else {
    const b = blocoComTitulo("INTERMEDIÁRIO DA OPERAÇÃO", y, [
      [
        { label: "CNPJ / CPF / NIF", valor: d.intermDoc, col: 1 },
        { label: "Indicador Municipal (Inscrição)", valor: d.intermIM, col: 2 },
        { label: "Telefone", valor: d.intermFone, col: 3 },
      ],
      [
        { label: "Nome / Nome Empresarial", valor: d.intermNome, col: 0, largura: LARG_DUPLA },
        { label: "Email", valor: d.intermEmail, col: 2, largura: LARG_DUPLA },
      ],
      [{ label: "Endereço", valor: d.intermEndereco, col: 0, largura: LARG_DUPLA }],
    ]);
    campos.push(b.html);
    y += b.alturaTotal;
  }

  // ---- Serviço prestado ----
  {
    const b = blocoComTitulo("SERVIÇO PRESTADO", y, [
      [
        { label: "Código de Tributação Nacional / Municipal", valor: d.codTribNacMun, col: 1 },
        { label: "Código da NBS", valor: d.codNBS, col: 2 },
        { label: "Local da Prestação / Sigla UF / País", valor: d.localPrestacaoUfPais, col: 3 },
      ],
    ]);
    campos.push(b.html);
    y += b.alturaTotal;
    campos.push(linha([{ valor: d.descricaoTributacao, col: 0, largura: LARG_TOTAL }], { top: y, height: 0.4 }));
    y += 0.42;
    // "Descrição do Serviço" é uma das duas zonas flexíveis da NT 008 (item 2.3) — cresce pra ocupar
    // o espaço sobrando na página, já que o Canhoto (opcional) não é usado aqui.
    const alturaDescServico = 1.3;
    campos.push(linha([{ label: "Descrição do Serviço", valor: d.descricaoServico, col: 0, largura: LARG_TOTAL }], { top: y, height: alturaDescServico }));
    y += alturaDescServico + 0.04;
  }

  // ---- Tributação Municipal (ISSQN) ----
  if (d.tribIssqnVazio) {
    const b = blocoSuprimido("TRIBUTAÇÃO MUNICIPAL (ISSQN) - OPERAÇÃO NÃO SUJEITA AO ISSQN", y);
    campos.push(b.html);
    y += b.alturaTotal;
  } else {
    const b = blocoComTitulo("TRIBUTAÇÃO MUNICIPAL (ISSQN)", y, [
      [
        { label: "Tipo de Tributação do ISSQN", valor: d.tipoTributacaoIssqn, col: 1 },
        { label: "Município / Sigla UF / País da Incidência do ISSQN", valor: d.localIncidenciaIssqn, col: 2, largura: LARG_DUPLA },
      ],
      [
        { label: "Regime Especial de Tributação do ISSQN", valor: d.regimeEspecialIssqn, col: 0 },
        { label: "Suspensão da Exigibilidade do ISSQN", valor: d.suspensaoIssqn, col: 2 },
        { label: "Número Processo Suspensão", valor: d.numeroProcessoSuspensao, col: 3 },
      ],
      [
        { label: "BC ISSQN", valor: d.bcIssqn, col: 0 },
        { label: "Alíquota Aplicada", valor: d.aliquotaAplicada, col: 1 },
        { label: "Retenção do ISSQN", valor: d.retencaoIssqn, col: 2 },
        { label: "ISSQN Apurado", valor: d.issqnApurado, col: 3 },
      ],
    ]);
    campos.push(b.html);
    y += b.alturaTotal;
  }

  // ---- Tributação Federal (exceto CBS) ----
  {
    const b = blocoComTitulo("TRIBUTAÇÃO FEDERAL (EXCETO CBS)", y, [
      [
        { label: "IRRF", valor: d.irrf, col: 1 },
        { label: "Contribuição Previdenciária - Retida", valor: d.contribPrevidenciaria, col: 2 },
        { label: "Contribuições Sociais - Retidas", valor: d.contribSociaisRetidas, col: 3 },
      ],
      [
        { label: "PIS - Débito Apuração Própria", valor: d.pisDebito, col: 0 },
        { label: "COFINS - Débito Apuração Própria", valor: d.cofinsDebito, col: 1 },
        { label: "Descrição Contrib. Sociais - Retidas", valor: d.descricaoContribSociais, col: 2, largura: LARG_DUPLA },
      ],
    ]);
    campos.push(b.html);
    y += b.alturaTotal;
  }

  // ---- Tributação IBS/CBS ----
  {
    const b = blocoComTitulo("TRIBUTAÇÃO IBS / CBS", y, [
      [
        { label: "CST / cClassTrib", valor: d.cstCclasstrib, col: 1 },
        { label: "Indicador de Operação / Cód. IBGE Incidência / Município Incidência / Sigla UF", valor: d.indOperacaoIbscbs, col: 2, largura: LARG_DUPLA },
      ],
      [
        { label: "Exclusões e Reduções da Base de Cálculo", valor: d.exclusoesReducoesBc, col: 0 },
        { label: "Base de Cálculo Após Exclusões e Reduções", valor: d.bcApósExclusoes, col: 1 },
        { label: "Red. Alíquota IBS / Red. Alíquota CBS", valor: d.reducaoAliquotaIbsCbs, col: 2 },
        { label: "Alíquota - IBS UF / IBS Mun", valor: d.aliquotaIbsUfMun, col: 3 },
      ],
      [
        { label: "Alíq. Efetiva Municipal - IBS", valor: d.aliquotaEfetivaMunIbs, col: 0 },
        { label: "Valor Apurado Municipal - IBS", valor: d.valorApuradoMunIbs, col: 1 },
        { label: "Alíq. Efetiva Estadual - IBS", valor: d.aliquotaEfetivaUfIbs, col: 2 },
        { label: "Valor Apurado Estadual - IBS", valor: d.valorApuradoUfIbs, col: 3 },
      ],
      [
        { label: "Valor Total Apurado - IBS", valor: d.valorTotalIbs, col: 0 },
        { label: "Alíquota - CBS", valor: d.aliquotaCbs, col: 1 },
        { label: "Alíquota Efetiva - CBS", valor: d.aliquotaEfetivaCbs, col: 2 },
        { label: "Valor Total Apurado - CBS", valor: d.valorTotalCbs, col: 3 },
      ],
    ]);
    campos.push(b.html);
    y += b.alturaTotal;
  }

  // ---- Valor total ----
  {
    const b = blocoComTitulo("VALOR TOTAL DA NFS-E", y, [
      [
        { label: "Valor da Operação / Serviço", valor: d.valorServico, col: 1 },
        { label: "Desconto Incondicionado", valor: d.descontoIncondicionado, col: 2 },
        { label: "Desconto Condicionado", valor: d.descontoCondicionado, col: 3 },
      ],
      [
        { label: "Total das Retenções (ISSQN / Federais)", valor: d.totalRetencoes, col: 0 },
        { label: "Valor Líquido da NFS-e", valor: d.valorLiquidoNFSe, col: 1 },
        { label: "Total do IBS/CBS", valor: d.totalIbsCbs, col: 2 },
        { label: "Valor Líquido da NFS-e + IBS/CBS", valor: d.valorLiquidoTotal, col: 3, destaque: true },
      ],
    ]);
    campos.push(b.html);
    y += b.alturaTotal;
  }

  // ---- Informações complementares (zona flexível: absorve o espaço restante da página) ----
  const totaisAproximados = d.totTribFed
    ? `Totais Aproximados dos Tributos cfe. Lei nº 12.741/2012: Federais: ${d.totTribFed}% ; Estaduais: - ; Municipais: -`
    : "Totais Aproximados dos Tributos cfe. Lei nº 12.741/2012: Federais: - ; Estaduais: - ; Municipais: -";
  const partesInfoCompl = [d.xInfComp ? `Inf. Cont.: ${d.xInfComp}` : null, d.docReferencia ? `Doc. Ref.: ${d.docReferencia}` : null, totaisAproximados].filter(Boolean);
  campos.push(`<div class="bloco-titulo-cheio" style="top:${y}cm; left:${MARGEM}cm; width:${LARG_TOTAL}cm; height:0.4cm;">INFORMAÇÕES COMPLEMENTARES</div>`);
  y += 0.42;
  const alturaInfoCompl = Math.max(1, 29.4 - y); // até ~0,3cm da borda inferior da página (sem canhoto)
  campos.push(linha([{ valor: reticencias(partesInfoCompl.join(" | "), 1997), col: 0, largura: LARG_TOTAL }], { top: y, height: alturaInfoCompl }));

  const marcaDaguaHtml = opts.marcaDagua
    ? `<div class="marca-dagua">${opts.marcaDagua === "CANCELADA" ? "CANCELADA" : "SUBSTITUÍDA"}</div>`
    : "";

  return `<!doctype html><html><head><meta charset="utf-8"><title>DANFSe ${esc(d.numeroNFSe)}</title>
  <style>
    @page { size: 21cm 29.7cm; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; width: 21cm; height: 29.7cm; position: relative; font-family: "Microsoft Sans Serif", Arial, sans-serif; color: #000; }
    .pagina { position: absolute; inset: 0; border: 1pt solid #000; }
    .cabecalho-borda { position: absolute; border-bottom: 0.5pt solid #000; background: #f2f2f2; }
    .logo-nfse { position: absolute; font-family: Arial, sans-serif; font-weight: bold; font-size: 13pt; display:flex; align-items:center; color:#1a1a1a; }
    .titulo-danfse { position: absolute; text-align: center; font-family: Arial, sans-serif; }
    .titulo-danfse-l1, .titulo-danfse-l2 { font-weight: bold; font-size: 9pt; }
    .titulo-danfse-homolog { font-weight: bold; font-size: 9pt; color: #ff0000; margin-top: 2px; }
    .ident-municipio { position: absolute; text-align: right; font-family: "Microsoft Sans Serif", Arial, sans-serif; }
    .ident-municipio-nome { font-size: 8pt; }
    .ident-municipio-amb { font-size: 6pt; }
    .qrcode-box { position: absolute; }
    .qrcode-box img { display: block; width: 100%; height: 100%; }
    .qrcode-complemento { position: absolute; font-size: 6pt; line-height: 1.15; }
    .bloco-titulo-inline, .bloco-titulo-cheio, .bloco-suprimido { position: absolute; background: #f2f2f2; border: 0.5pt solid #000; font-family: Arial, sans-serif; font-weight: bold; font-size: 7pt; text-transform: uppercase; display: flex; align-items: center; padding: 0 3px; }
    .bloco-suprimido { justify-content: center; }
    .campo { position: absolute; border: 0.5pt solid #000; overflow: hidden; padding: 1px 3px; }
    .campo-destaque { background: #f2f2f2; }
    .campo-label { font-family: Arial, sans-serif; font-weight: bold; font-size: 6pt; white-space: nowrap; }
    .campo-valor { font-family: "Microsoft Sans Serif", Arial, sans-serif; font-size: 7pt; word-break: break-word; }
    .marca-dagua { position: absolute; top: 45%; left: 0; width: 100%; text-align: center; transform: rotate(-35deg); font-family: Arial, sans-serif; font-size: 50pt; color: rgba(89,89,89,0.55); font-weight: normal; pointer-events: none; z-index: 10; }
  </style></head>
  <body>
    <div class="pagina">
      ${campos.join("\n")}
      ${marcaDaguaHtml}
    </div>
  </body></html>`;
}

export async function gerarDanfsePdf(xmlNfse: string, opts: { marcaDagua?: "CANCELADA" | "SUBSTITUIDA" } = {}): Promise<Buffer> {
  const dados = extrairDadosDanfse(xmlNfse);
  const qrCodeDataUri = await gerarQrCodeDataUri(dados.chaveAcesso);
  const html = gerarDanfseHtml(dados, { qrCodeDataUri, marcaDagua: opts.marcaDagua });
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    const pdf = await page.pdf({ width: "21cm", height: "29.7cm", printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } });
    return pdf as Buffer;
  } finally {
    await browser.close();
  }
}
