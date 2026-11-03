// Auditoria da Reforma Tributária (IBS/CBS) nas NF-e de ENTRADA de um cliente: lê cada XML recebido
// item a item, confere o grupo IBSCBS contra o leiaute oficial e a tabela oficial de cClassTrib, valida
// NCM x cClassTrib na API pública da Calculadora de Tributos (RFB/CGIBS), classifica o regime de IBS/CBS
// de cada fornecedor e calcula o crédito aproveitável x o crédito de referência (o que o cliente tomaria
// se o fornecedor emitisse no regime regular), apontando evidências e o preenchimento esperado.
//
// Fontes (pesquisadas e conferidas em nov/2026):
//  - NT 2025.002-RTC v1.53 (NF-e/NFC-e IBS/CBS/IS) — grupo UB12 (IBSCBS), regras UB12-10, UB14-10/20/25,
//    UB16-10 (base de cálculo), UB18/UB37/UB56 (alíquotas), UB28 (pAliqEfet), totais W34+.
//  - NT 2026.005 v1.00 (Simples Nacional) — emit/tpRegimeIBSCBS (C21a) e IBSCBS/gTribSN (UB115a).
//  - IT 2025.002 v1.71 — Tabelas de Classificação do IBS e da CBS (cClassTrib/CST), embarcada em
//    reforma-tabelas/cclasstrib-ibscbs.json.
//  - LC 214/2025: arts. 343, 344, 346 e 347 (alíquotas de transição), 41 §3º e 47 §9º (Simples Nacional:
//    crédito do adquirente limitado ao valor pago no regime único, salvo opção pelo regime regular).
//  - API Calculadora de Tributos: consumo.tributos.gov.br/.../dados-abertos/classificacoes-tributarias/ncm-aplicavel
import { XMLParser } from "fast-xml-parser";
import * as path from "path";
import * as fs from "fs";

const parser = new XMLParser({ attributeNamePrefix: "@_", textNodeName: "value", ignoreAttributes: false, parseAttributeValue: false, parseTagValue: false, trimValues: true });

interface ClassTrib {
  cClassTrib: string; cst: string; nome: string; descricao: string; artigoLC: string; tipoAliquota: string; pRedIBS: number; pRedCBS: number;
  indTribRegular: boolean; indCredPresOper: boolean; indMono: boolean; iniVig: string | null; fimVig: string | null; indNFe: boolean; indNFCe: boolean;
  anexo: string | null;
  // Vindos da lista oficial da Calculadora (atualizada a cada 15 dias): false = classificação veda o
  // crédito do adquirente; foraDaListaOficial = saiu da lista vigente na última atualização.
  creditoAdquirenteCbs?: boolean; creditoAdquirenteIbs?: boolean; foraDaListaOficial?: boolean; vinculadaNcm?: boolean;
}
// Base embarcada: IT 2025.002 v1.71 (planilha oficial) + retrato dos NCM vigentes. Em produção, o
// servidor baixa de novo da API oficial a cada 15 dias e chama aplicarTabelasOficiais() (ver server.ts).
const TABELA = JSON.parse(fs.readFileSync(path.join(__dirname, "reforma-tabelas", "cclasstrib-ibscbs.json"), "utf8")) as {
  fonte: string; cclasstrib: ClassTrib[]; cst: { cst: string; descricao: string; gIBSCBS: boolean; gIBSCBSMono: boolean; gRed: boolean; gDif: boolean }[];
};
const NCM_BASE = JSON.parse(fs.readFileSync(path.join(__dirname, "reforma-tabelas", "ncm-vigentes.json"), "utf8")) as { fonte: string; data: string; ncms: [string, string][] };
const CLASS = new Map<string, ClassTrib>(TABELA.cclasstrib.map((c) => [c.cClassTrib, c]));
const CSTS = new Map(TABELA.cst.map((c) => [c.cst, c]));
// A API devolve a descrição com marcação HTML (ex.: "<i>pellets</i>", "cm<sup>2</sup>") — guarda só o texto.
const textoNcm = (s: any) => String(s || "").replace(/<sup>(\d+)<\/sup>/gi, "$1").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
let NCM_VIGENTES = new Map<string, string>(NCM_BASE.ncms.map(([c, d]) => [c, textoNcm(d)]));
export const VERSAO_TABELAS = { cClassTrib: TABELA.fonte, ncm: `${NCM_BASE.fonte} (${NCM_BASE.data})`, atualizadoEm: null as string | null };
export const FONTE_TABELA = TABELA.fonte;
export function infoCClassTrib(c: string) { return CLASS.get(c) || null; }
export function descricaoNcm(ncm: string) { return NCM_VIGENTES.get(ncm) || null; }
export function ncmVigenteHoje(ncm: string) { return NCM_VIGENTES.has(ncm); }

// Aplica as listas oficiais baixadas da Calculadora de Tributos (RFB/CGIBS). Só troca o que veio
// íntegro (listas vazias/curtas são ignoradas — melhor ficar com a versão anterior do que zerar).
export function aplicarTabelasOficiais(d: { data: string; classes?: any[]; situacoes?: any[]; ncms?: any[] }) {
  const mudancas: string[] = [];
  if (Array.isArray(d.ncms) && d.ncms.length > 5000) {
    const novo = new Map<string, string>(d.ncms.filter((x) => /^\d{8}$/.test(x?.ncm)).map((x) => [x.ncm, textoNcm(x.descricao)]));
    const sairam = [...NCM_VIGENTES.keys()].filter((k) => !novo.has(k)).length, entraram = [...novo.keys()].filter((k) => !NCM_VIGENTES.has(k)).length;
    if (sairam || entraram) mudancas.push(`NCM: ${entraram} novo(s), ${sairam} extinto(s)`);
    NCM_VIGENTES = novo;
    VERSAO_TABELAS.ncm = `Calculadora de Tributos RFB/CGIBS — ncm/vigentes (${d.data})`;
  }
  if (Array.isArray(d.classes) && d.classes.length > 100) {
    const cstDe = new Map<string, string>();
    for (const sit of Array.isArray(d.situacoes) ? d.situacoes : []) for (const c of sit?.classificacoesTributarias || []) cstDe.set(String(c.codigo), String(sit.codigo).padStart(3, "0"));
    const vistos = new Set<string>();
    for (const c of d.classes) {
      const cod = String(c?.codigo || "").padStart(6, "0");
      if (!/^\d{6}$/.test(cod)) continue;
      vistos.add(cod);
      const atual = CLASS.get(cod);
      const pRedIBS = Number(c.percentualReducaoIbsUf) || 0, pRedCBS = Number(c.percentualReducaoCbs) || 0;
      if (atual && (atual.pRedIBS !== pRedIBS || atual.pRedCBS !== pRedCBS)) mudancas.push(`cClassTrib ${cod}: redução ${atual.pRedCBS}% → ${pRedCBS}%`);
      const base: ClassTrib = atual || {
        cClassTrib: cod, cst: cstDe.get(cod) || cod.slice(0, 3), nome: String(c.descricao || ""), descricao: String(c.descricao || ""), artigoLC: "", tipoAliquota: String(c.tipoAliquota || ""),
        pRedIBS, pRedCBS, indTribRegular: false, indCredPresOper: false, indMono: false, iniVig: d.data, fimVig: null,
        indNFe: (c.tiposDfeClassificacao || []).some((t: any) => Number(t.tipo) === 55), indNFCe: (c.tiposDfeClassificacao || []).some((t: any) => Number(t.tipo) === 65), anexo: null,
      };
      if (!atual) mudancas.push(`cClassTrib ${cod} novo na lista oficial`);
      CLASS.set(cod, { ...base, pRedIBS, pRedCBS, creditoAdquirenteCbs: c.indicaApropriacaoCreditoAdquirenteCbs !== false, creditoAdquirenteIbs: c.indicaApropriacaoCreditoAdquirenteIbs !== false, vinculadaNcm: /NCM/.test(String(c.nomenclatura || "")), foraDaListaOficial: false });
    }
    for (const [cod, c] of CLASS) if (!vistos.has(cod) && !c.foraDaListaOficial) { c.foraDaListaOficial = true; mudancas.push(`cClassTrib ${cod} saiu da lista vigente`); }
  }
  VERSAO_TABELAS.atualizadoEm = d.data;
  return mudancas;
}

// Alíquotas nominais oficiais por ano (LC 214/2025). CBS de 2027/2028 = referência − 0,1 p.p. (art. 347),
// ainda dependente de resolução do Senado → não validada; só usada como ESTIMATIVA na projeção.
export const CBS_2027_ESTIMADA = 11.2; // TCU: referência 11,3% (estimativa) − 0,1 p.p.
function aliquotasAno(ano: number): { pCBS: number | null; pIBSUF: number; pIBSMun: number } | null {
  if (ano === 2026) return { pCBS: 0.9, pIBSUF: 0.1, pIBSMun: 0 };
  if (ano === 2027 || ano === 2028) return { pCBS: null, pIBSUF: 0.05, pIBSMun: 0.05 };
  return null;
}
// Obrigação legal de destacar o grupo IBSCBS no regime regular (Ato Conjunto RFB/CGIBS nº 4/2026).
const INICIO_OBRIGACAO_REGULAR = "2026-08-03";
// Campos do Simples Nacional na NF-e (NT 2026.005) entram em produção em 16/11/2026.
const INICIO_CAMPOS_SN = "2026-11-16";

const n = (v: any) => (v != null && v !== "" && !isNaN(Number(v)) ? Number(v) : 0);
const arr = (v: any) => (Array.isArray(v) ? v : v != null ? [v] : []);
const r2 = (v: number) => Math.round(v * 100) / 100;
const primeiroFilho = (g: any) => (g && typeof g === "object" ? (Object.values(g)[0] as any) || {} : {});
function achar(obj: any, chave: string): any {
  if (!obj || typeof obj !== "object") return undefined;
  if (chave in obj) return obj[chave];
  for (const v of Object.values(obj)) {
    const r = achar(v, chave);
    if (r !== undefined) return r;
  }
  return undefined;
}

export interface GrupoTrib { p: number; pRed: number | null; pAliqEfet: number | null; vDif: number; vDevTrib: number; v: number; temDif: boolean }
export interface ItemRT {
  nItem: number; cProd: string; xProd: string; ncm: string; cfop: string;
  vProd: number; baseFormula: number;
  temIBSCBS: boolean; cst: string | null; cClassTrib: string | null; vBC: number;
  uf: GrupoTrib | null; mun: GrupoTrib | null; cbs: GrupoTrib | null;
  temTribRegular: boolean; temMono: boolean; temCredPres: boolean;
  sn: { pIBSSN: number; vIBSSN: number; pCBSSN: number; vCBSSN: number } | null;
  combustivelMono: boolean;
}
export interface NotaRT {
  docId: number; chave: string; numero: string; serie: string; dhEmi: string; mod: string; finNFe: number;
  emitCnpj: string; emitNome: string; emitUF: string; crt: number | null; tpRegimeIBSCBS: string | null;
  vNF: number; itens: ItemRT[];
  tot: { vBC: number; vIBS: number; vCBS: number; vIBSSN: number; vCBSSN: number; temGrupo: boolean };
}

function lerGrupo(g: any): GrupoTrib | null {
  if (!g || typeof g !== "object") return null;
  const p = n(g.pIBSUF ?? g.pIBSMun ?? g.pCBS);
  const v = n(g.vIBSUF ?? g.vIBSMun ?? g.vCBS);
  return {
    p, v,
    pRed: g.gRed ? n(g.gRed.pRedAliq) : null,
    pAliqEfet: g.gRed ? n(g.gRed.pAliqEfet) : null,
    vDif: g.gDif ? n(g.gDif.vDif) : 0,
    vDevTrib: g.gDevTrib ? n(g.gDevTrib.vDevTrib) : 0,
    temDif: !!g.gDif,
  };
}

export function lerNotaReforma(docId: number, xml: string): NotaRT | null {
  let j: any;
  try { j = parser.parse(xml); } catch { return null; }
  const inf = j?.nfeProc?.NFe?.infNFe || j?.NFe?.infNFe;
  if (!inf) return null;
  const ide = inf.ide || {}, emit = inf.emit || {};
  const itens: ItemRT[] = arr(inf.det).map((d: any, i: number) => {
    const prod = d.prod || {}, imp = d.imposto || {};
    const icms = primeiroFilho(imp.ICMS);
    const ufDest = imp.ICMSUFDest || {};
    const vPIS = n(primeiroFilho(imp.PIS).vPIS), vCOFINS = n(primeiroFilho(imp.COFINS).vCOFINS);
    // Base de cálculo oficial (NT 2025.002, regra UB16-10): vProd + vServ + vFrete + vSeg + vOutro + vII
    // − vDesc − vPIS − vCOFINS − vICMS − vICMSUFDest − vFCP − vFCPUFDest − vICMSMono − vISSQN + vIS.
    const baseFormula = r2(
      n(prod.vProd) + n(prod.vFrete) + n(prod.vSeg) + n(prod.vOutro) + n(imp.II?.vII)
      - n(prod.vDesc) - vPIS - vCOFINS - n(icms.vICMS) - n(ufDest.vICMSUFDest) - n(icms.vFCP) - n(ufDest.vFCPUFDest)
      - n(icms.vICMSMono) - n(imp.ISSQN?.vISSQN) + n(imp.IS?.vIS)
    );
    const ib = imp.IBSCBS;
    const g = ib?.gIBSCBS;
    const sn = ib ? achar(ib, "gTribSN") : undefined;
    return {
      nItem: Number(d["@_nItem"]) || i + 1,
      cProd: String(prod.cProd || ""), xProd: String(prod.xProd || ""), ncm: String(prod.NCM || ""), cfop: String(prod.CFOP || ""),
      vProd: n(prod.vProd), baseFormula,
      temIBSCBS: !!ib,
      cst: ib?.CST != null ? String(ib.CST).padStart(3, "0") : null,
      cClassTrib: ib?.cClassTrib != null ? String(ib.cClassTrib).padStart(6, "0") : null,
      vBC: n(g?.vBC),
      uf: lerGrupo(g?.gIBSUF), mun: lerGrupo(g?.gIBSMun), cbs: lerGrupo(g?.gCBS),
      temTribRegular: !!(ib && achar(ib, "gTribRegular")),
      temMono: !!(ib && ib.gIBSCBSMono),
      temCredPres: !!(ib && (achar(ib, "gCredPresOper") || achar(ib, "gCredPresIBSZFM"))),
      sn: sn ? { pIBSSN: n(sn.gIBSSN?.pIBSSN), vIBSSN: n(sn.gIBSSN?.vIBSSN), pCBSSN: n(sn.gCBSSN?.pCBSSN), vCBSSN: n(sn.gCBSSN?.vCBSSN) } : null,
      combustivelMono: !!(prod.comb && prod.comb.cProdANP),
    };
  });
  const t = inf.total?.IBSCBSTot;
  const tSN = t ? achar(t, "gTribSN") : undefined;
  return {
    docId, chave: String(inf["@_Id"] || "").replace(/^NFe/, ""), numero: String(ide.nNF || ""), serie: String(ide.serie || ""),
    dhEmi: String(ide.dhEmi || "").slice(0, 10), mod: String(ide.mod || "55"), finNFe: n(ide.finNFe) || 1,
    emitCnpj: String(emit.CNPJ || emit.CPF || ""), emitNome: String(emit.xNome || ""), emitUF: String(emit.enderEmit?.UF || ""),
    crt: emit.CRT != null ? Number(emit.CRT) : null, tpRegimeIBSCBS: emit.tpRegimeIBSCBS != null ? String(emit.tpRegimeIBSCBS) : null,
    vNF: n(inf.total?.ICMSTot?.vNF), itens,
    tot: {
      temGrupo: !!t, vBC: n(t?.vBCIBSCBS), vIBS: n(t?.gIBS?.vIBS) || n(t?.gIBS?.gIBSUF?.vIBSUF) + n(t?.gIBS?.gIBSMun?.vIBSMun), vCBS: n(t?.gCBS?.vCBS),
      vIBSSN: n(tSN?.vIBSSN), vCBSSN: n(tSN?.vCBSSN),
    },
  };
}

// Regime de IBS/CBS do fornecedor, como a NF-e informa (CRT + tpRegimeIBSCBS + gTribSN).
export type RegimeFornecedor = "regular" | "sn_regular" | "sn_dentro" | "sn_indefinido" | "mei" | "pf" | "desconhecido";
export const REGIME_FORNECEDOR_LABEL: Record<RegimeFornecedor, string> = {
  regular: "Regime normal",
  sn_regular: "Simples — IBS/CBS por fora (regime regular)",
  sn_dentro: "Simples — IBS/CBS dentro do DAS",
  sn_indefinido: "Simples — regime de IBS/CBS não informado",
  mei: "MEI",
  pf: "Produtor rural / pessoa física",
  desconhecido: "Não identificado",
};
export function regimeFornecedor(nota: NotaRT): RegimeFornecedor {
  // Emitente com CPF (NF-e de produtor rural pessoa física): não contribuinte, não destaca IBS/CBS —
  // não é "regime normal" mesmo com CRT 3 na nota.
  if (nota.emitCnpj.replace(/\D/g, "").length === 11) return "pf";
  if (nota.crt === 3) return "regular";
  if (nota.crt === 4) return "mei";
  if (nota.crt === 1 || nota.crt === 2) {
    if (nota.tpRegimeIBSCBS === "1") return "sn_regular";
    if (nota.itens.some((i) => i.sn) || nota.tot.vIBSSN > 0 || nota.tot.vCBSSN > 0) return "sn_dentro";
    return "sn_indefinido";
  }
  return "desconhecido";
}

export type Severidade = "alta" | "media" | "baixa" | "info";
export interface Achado {
  regra: string; severidade: Severidade; titulo: string; detalhe: string;
  evidencia: string; // tags/valores do XML que comprovam
  esperado?: string; // como o fornecedor deveria ter emitido
  recomendacao: string; nItem?: number; valor?: number;
  produto?: string; ncm?: string; cfop?: string; fundamento?: string;
}
// Validação oficial NCM x cClassTrib: true/false, ou undefined enquanto a API ainda não respondeu.
export type ConsultaNcm = (cClassTrib: string, ncm: string, ano: number) => boolean | undefined;
// NCM existia na nomenclatura na data da emissão? (consulta oficial dados-abertos/ncm por data)
export type ConsultaVigenciaNcm = (ncm: string, data: string) => boolean | undefined;

const fmt = (v: number, casas = 2) => v.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
// Valores dentro de trechos de XML (evidência / "como deveria emitir") saem como no XML: ponto decimal.
const fx = (v: number, casas = 2) => v.toFixed(casas);
const CFOP_VENDA = /^[56](101|102|103|104|105|106|109|110|111|113|114|115|116|117|118|119|120|122|123|124|125|401|402|403|405|651|652|653|654|655|656)$/;

function xmlEsperado(cst: string, cClassTrib: string, vBC: number, a: { pCBS: number | null; pIBSUF: number; pIBSMun: number }, pRedIBS: number, pRedCBS: number) {
  const ef = (p: number, red: number) => p * (1 - red / 100);
  const pUF = ef(a.pIBSUF, pRedIBS), pMun = ef(a.pIBSMun, pRedIBS), pCBS = a.pCBS == null ? null : ef(a.pCBS, pRedCBS);
  const vUF = r2((vBC * pUF) / 100), vMun = r2((vBC * pMun) / 100);
  const red = (p: number, r: number) => (r ? `<gRed><pRedAliq>${fx(r, 4)}</pRedAliq><pAliqEfet>${fx(ef(p, r), 4)}</pAliqEfet></gRed>` : "");
  return `<IBSCBS><CST>${cst}</CST><cClassTrib>${cClassTrib}</cClassTrib><gIBSCBS><vBC>${fx(vBC)}</vBC>` +
    `<gIBSUF><pIBSUF>${fx(a.pIBSUF, 4)}</pIBSUF>${red(a.pIBSUF, pRedIBS)}<vIBSUF>${fx(vUF)}</vIBSUF></gIBSUF>` +
    `<gIBSMun><pIBSMun>${fx(a.pIBSMun, 4)}</pIBSMun>${red(a.pIBSMun, pRedIBS)}<vIBSMun>${fx(vMun)}</vIBSMun></gIBSMun>` +
    `<vIBS>${fx(vUF + vMun)}</vIBS>` +
    (pCBS == null ? `<gCBS><pCBS>(alíquota de referência do ano)</pCBS>…</gCBS>` : `<gCBS><pCBS>${fx(a.pCBS!, 4)}</pCBS>${red(a.pCBS!, pRedCBS)}<vCBS>${fx(r2((vBC * pCBS) / 100))}</vCBS></gCBS>`) +
    `</gIBSCBS></IBSCBS>`;
}

export interface ResultadoNota {
  nota: NotaRT; regime: RegimeFornecedor; achados: Achado[];
  // Crédito (R$): destacado aproveitável, de referência (se fosse regime regular) no ano da nota e
  // projetado para 2027 (CBS estimada), e o que fica em risco de glosa por erro do fornecedor.
  credito: { aproveitavel: number; referencia: number; risco: number; perdaEstrutural: number; perdaErro: number; referencia2027: number; aproveitavel2027: number };
  itensConformes: number;
}

// Notas em que o grupo IBSCBS é exceção legítima (NT 2025.002, UB12-10).
function grupoDispensado(nota: NotaRT, it: ItemRT) {
  return nota.finNFe === 2 || nota.finNFe === 4 || it.combustivelMono;
}

export function auditarNota(nota: NotaRT, consultaNcm: ConsultaNcm, consultaVigencia: ConsultaVigenciaNcm = () => undefined): ResultadoNota {
  const regime = regimeFornecedor(nota);
  const ano = Number(nota.dhEmi.slice(0, 4)) || new Date().getFullYear();
  const aliq = aliquotasAno(ano);
  const achados: Achado[] = [];
  const cred = { aproveitavel: 0, referencia: 0, risco: 0, perdaEstrutural: 0, perdaErro: 0, referencia2027: 0, aproveitavel2027: 0 };
  let itensConformes = 0;
  const add = (a: Achado) => achados.push(a);

  // ---- Regras do regime do fornecedor (por nota) ----
  if (regime === "sn_indefinido" && nota.dhEmi >= INICIO_CAMPOS_SN) {
    add({ regra: "SN_SEM_REGIME", severidade: "media", titulo: "Simples Nacional sem informar o regime de IBS/CBS",
      detalhe: "Fornecedor do Simples (CRT " + nota.crt + ") emitiu sem tpRegimeIBSCBS e sem o grupo gTribSN, obrigatórios a partir de 16/11/2026 (NT 2026.005).",
      evidencia: `<emit><CRT>${nota.crt}</CRT></emit> sem <tpRegimeIBSCBS> e sem <gTribSN>`,
      esperado: "Se recolhe IBS/CBS no DAS: informar <gTribSN><gIBSSN><pIBSSN/><vIBSSN/></gIBSSN><gCBSSN><pCBSSN/><vCBSSN/></gCBSSN></gTribSN>. Se optou pelo regime regular: <tpRegimeIBSCBS>1</tpRegimeIBSCBS> e os grupos gIBSUF/gIBSMun/gCBS.",
      recomendacao: "Pedir ao fornecedor a atualização do emissor (NT 2026.005) — sem esses campos o crédito do Simples não fica documentado." });
  }
  if (regime === "sn_regular" && nota.itens.some((i) => i.sn || (i.temIBSCBS && !i.cbs))) {
    add({ regra: "SN_OPCAO_INCONSISTENTE", severidade: "alta", titulo: "Simples optante pelo regime regular com preenchimento incoerente",
      detalhe: "tpRegimeIBSCBS=1 exige os grupos gIBSUF/gIBSMun/gCBS e veda o gTribSN (NT 2026.005).",
      evidencia: `<tpRegimeIBSCBS>1</tpRegimeIBSCBS> com ${nota.itens.some((i) => i.sn) ? "<gTribSN> informado" : "item sem <gCBS>"}`,
      recomendacao: "Solicitar correção: o crédito integral depende do destaque correto no regime regular." });
  }
  if (regime === "pf") {
    add({ regra: "PRODUTOR_RURAL_PF", severidade: "info", titulo: "Compra de produtor rural / pessoa física",
      detalhe: "Emitente pessoa física (CPF): produtor rural não contribuinte não destaca IBS/CBS. Na aquisição de produtor rural não contribuinte o adquirente pode apropriar crédito presumido de IBS/CBS, nos percentuais fixados em ato do Poder Executivo/CGIBS (LC 214/2025, art. 168).",
      evidencia: `<emit><CPF>${nota.emitCnpj}</CPF></emit>`,
      recomendacao: "Não é erro do fornecedor. Avaliar o crédito presumido na apuração do adquirente." });
  }
  if (regime === "mei" && nota.itens.some((i) => i.temIBSCBS)) {
    add({ regra: "MEI_COM_IBSCBS", severidade: "baixa", titulo: "MEI informando grupo IBS/CBS",
      detalhe: "MEI (CRT 4) não informa o grupo IBSCBS — o valor destacado não gera crédito.", evidencia: "<CRT>4</CRT> com <IBSCBS>",
      recomendacao: "Não tomar crédito destas notas; orientar o fornecedor." });
  }

  // ---- Totais da nota ----
  const comGrupo = nota.itens.filter((i) => i.temIBSCBS);
  if (nota.tot.temGrupo && comGrupo.length) {
    const sBC = r2(comGrupo.reduce((a, i) => a + i.vBC, 0));
    const sCBS = r2(comGrupo.reduce((a, i) => a + (i.cbs?.v || 0), 0));
    const sIBS = r2(comGrupo.reduce((a, i) => a + (i.uf?.v || 0) + (i.mun?.v || 0), 0));
    const difs = [["vBCIBSCBS", nota.tot.vBC, sBC], ["vCBS", nota.tot.vCBS, sCBS], ["vIBS", nota.tot.vIBS, sIBS]].filter(([, t, s]) => Math.abs((t as number) - (s as number)) > 0.05);
    if (difs.length && !comGrupo.some((i) => i.temCredPres)) {
      add({ regra: "TOTAL_DIVERGENTE", severidade: "media", titulo: "Total de IBS/CBS diferente da soma dos itens",
        detalhe: "Os totais do grupo IBSCBSTot devem ser a soma dos itens (NT 2025.002, W34 e seguintes).",
        evidencia: difs.map(([k, t, s]) => `${k}: total R$ ${fmt(t as number)} × soma dos itens R$ ${fmt(s as number)}`).join(" · "),
        recomendacao: "Solicitar correção ao fornecedor." });
    }
  }

  // ---- Itens ----
  for (const it of nota.itens) {
    const antes = achados.length;
    let altaNoItem = false;
    const addItem = (a: Achado) => { add({ ...a, nItem: it.nItem, produto: it.xProd, ncm: it.ncm, cfop: it.cfop }); if (a.severidade === "alta") altaNoItem = true; };
    const cls = it.cClassTrib ? CLASS.get(it.cClassTrib) || null : null;
    let pRedIBS = cls && !cls.indTribRegular ? cls.pRedIBS : 0, pRedCBS = cls && !cls.indTribRegular ? cls.pRedCBS : 0;
    const vBCref = it.temIBSCBS && it.vBC > 0 ? it.vBC : Math.max(0, it.baseFormula);
    const ident = `Item ${it.nItem} — ${it.xProd.slice(0, 60)} (NCM ${it.ncm})`;

    // NCM vencido / inexistente na nomenclatura oficial (TEC/NCM) — lista de vigentes da Calculadora,
    // confirmada na data da emissão pela consulta oficial por data.
    if (it.ncm && it.ncm !== "00000000") {
      if (!/^\d{8}$/.test(it.ncm)) {
        addItem({ regra: "NCM_INVALIDO", severidade: "alta", titulo: "NCM em formato inválido", detalhe: `${ident}: o NCM deve ter 8 dígitos.`, evidencia: `<NCM>${it.ncm}</NCM>`, recomendacao: "Solicitar correção — NCM inválido impede validar a tributação do item." });
      } else if (!NCM_VIGENTES.has(it.ncm)) {
        const naEmissao = consultaVigencia(it.ncm, nota.dhEmi);
        if (naEmissao === false) {
          addItem({ regra: "NCM_NAO_VIGENTE", severidade: "alta", titulo: "NCM vencido/inexistente na data da emissão",
            detalhe: `${ident}: o NCM ${it.ncm} não existe na nomenclatura oficial vigente em ${nota.dhEmi.split("-").reverse().join("/")} (consulta à Calculadora de Tributos da RFB). O fornecedor está usando um código extinto — a classificação tributária do item fica sem amparo.`,
            evidencia: `<NCM>${it.ncm}</NCM> · API dados-abertos/ncm (data ${nota.dhEmi}) → 404 "NCM não encontrada"`,
            recomendacao: "Solicitar ao fornecedor a atualização do cadastro do produto para o NCM vigente e a correção da nota (CC-e). Risco de glosa do crédito e de autuação na entrada.", valor: it.vProd });
        } else if (naEmissao === true) {
          addItem({ regra: "NCM_EXTINTO_DEPOIS", severidade: "baixa", titulo: "NCM extinto após a emissão",
            detalhe: `${ident}: o NCM ${it.ncm} era válido na emissão, mas não consta mais da nomenclatura vigente.`,
            evidencia: `<NCM>${it.ncm}</NCM> · fora da lista ncm/vigentes atual`,
            recomendacao: "Avisar o fornecedor para atualizar o cadastro do produto nas próximas notas." });
        }
      }
    }
    if (!it.temIBSCBS) {
      if ((regime === "regular" || regime === "sn_regular") && nota.dhEmi >= INICIO_OBRIGACAO_REGULAR && !grupoDispensado(nota, it)) {
        addItem({ regra: "GRUPO_AUSENTE", severidade: ano >= 2027 ? "alta" : "media", titulo: "Item sem o grupo IBS/CBS",
          detalhe: `${ident}: fornecedor do regime regular emitiu sem o grupo IBSCBS, obrigatório desde 03/08/2026 (Ato Conjunto RFB/CGIBS nº 4/2026; NT 2025.002, UB12). A SEFAZ ainda não rejeita (regra UB12-10 em "implementação futura" na produção), por isso a nota foi autorizada.`,
          evidencia: `<det nItem="${it.nItem}"><imposto> sem <IBSCBS>`,
          esperado: aliq ? xmlEsperado("000", "000001", vBCref, aliq, 0, 0) : undefined,
          recomendacao: ano >= 2027 ? "Sem destaque não há crédito documentado de CBS/IBS. Exigir NF-e com o grupo IBSCBS." : "Notificar o fornecedor para adequar o emissor antes de 2027, quando o crédito passa a valer em dinheiro.",
          valor: vBCref });
      }
    } else {
      // CST / cClassTrib x tabela oficial
      if (!it.cst || !CSTS.has(it.cst)) {
        addItem({ regra: "CST_INEXISTENTE", severidade: "alta", titulo: "CST de IBS/CBS inexistente", detalhe: `${ident}: CST ${it.cst} não existe na tabela oficial (IT 2025.002).`, evidencia: `<CST>${it.cst}</CST>`, recomendacao: "Solicitar correção do enquadramento." });
      }
      if (!cls) {
        addItem({ regra: "CCLASSTRIB_INEXISTENTE", severidade: "alta", titulo: "cClassTrib inexistente", detalhe: `${ident}: cClassTrib ${it.cClassTrib} não consta da tabela oficial (IT 2025.002 v1.71).`, evidencia: `<cClassTrib>${it.cClassTrib}</cClassTrib>`, recomendacao: "Solicitar correção — classificação inexistente gera risco de glosa do crédito." });
      } else {
        if (it.cst && cls.cst !== it.cst) {
          addItem({ regra: "CST_X_CCLASSTRIB", severidade: "alta", titulo: "cClassTrib incompatível com o CST", detalhe: `${ident}: o cClassTrib ${cls.cClassTrib} pertence ao CST ${cls.cst}, mas a nota informou CST ${it.cst} (regra UB14-20).`, evidencia: `<CST>${it.cst}</CST><cClassTrib>${it.cClassTrib}</cClassTrib>`, esperado: `<CST>${cls.cst}</CST><cClassTrib>${cls.cClassTrib}</cClassTrib>`, recomendacao: "Solicitar correção do enquadramento." });
        }
        if (cls.foraDaListaOficial && !cls.fimVig) {
          addItem({ regra: "CCLASSTRIB_FORA_LISTA", severidade: "media", titulo: "cClassTrib fora da lista oficial atualizada", detalhe: `${ident}: o cClassTrib ${cls.cClassTrib} não consta mais da lista vigente da Calculadora de Tributos (atualização de ${VERSAO_TABELAS.atualizadoEm || "—"}).`, evidencia: `<cClassTrib>${it.cClassTrib}</cClassTrib>`, recomendacao: "Confirmar com o fornecedor a classificação vigente." });
        }
        if ((cls.iniVig && nota.dhEmi < cls.iniVig) || (cls.fimVig && nota.dhEmi > cls.fimVig)) {
          addItem({ regra: "CCLASSTRIB_FORA_VIGENCIA", severidade: "alta", titulo: "cClassTrib fora da vigência", detalhe: `${ident}: cClassTrib ${cls.cClassTrib} vigente de ${cls.iniVig || "—"} a ${cls.fimVig || "atual"}; nota de ${nota.dhEmi}.`, evidencia: `<cClassTrib>${it.cClassTrib}</cClassTrib> · dhEmi ${nota.dhEmi}`, recomendacao: "Solicitar correção para a classificação vigente." });
        }
        if ((nota.mod === "55" && !cls.indNFe) || (nota.mod === "65" && !cls.indNFCe)) {
          addItem({ regra: "CCLASSTRIB_MODELO", severidade: "media", titulo: "cClassTrib não permitido para NF-e", detalhe: `${ident}: a tabela oficial não admite o cClassTrib ${cls.cClassTrib} no modelo ${nota.mod} (regra UB14-25).`, evidencia: `<mod>${nota.mod}</mod> · <cClassTrib>${it.cClassTrib}</cClassTrib>`, recomendacao: "Solicitar correção." });
        }
        // Redução aplicada a NCM fora do anexo da LC 214 (validação oficial na Calculadora da RFB).
        if (cls.anexo && it.ncm) {
          const ok = consultaNcm(cls.cClassTrib, it.ncm, ano);
          if (ok === false) {
            pRedIBS = 0; pRedCBS = 0; // sem direito à redução: a referência é a alíquota cheia
            addItem({ regra: "NCM_FORA_ANEXO", severidade: "alta", titulo: "NCM não autorizado para a classificação usada",
              detalhe: `${ident}: o fornecedor usou ${cls.cClassTrib} (${cls.nome}${cls.pRedCBS ? `, redução de ${fmt(cls.pRedCBS, 0)}%` : ""}), mas a Calculadora oficial da RFB responde que o NCM ${it.ncm} NÃO está vinculado a essa classificação.`,
              evidencia: `<NCM>${it.ncm}</NCM> · <cClassTrib>${it.cClassTrib}</cClassTrib> · API ncm-aplicavel → valido:false`,
              esperado: aliq ? xmlEsperado("000", "000001", vBCref, aliq, 0, 0) : "<CST>000</CST><cClassTrib>000001</cClassTrib> (tributação integral)",
              recomendacao: "Redução indevida: o crédito destacado é menor que o devido e o fornecedor tem passivo. Solicitar NF-e complementar/correção.", valor: vBCref });
          }
        }
        // Sem incidência (410xxx) numa venda onerosa.
        if (cls.cst === "410" && CFOP_VENDA.test(it.cfop)) {
          addItem({ regra: "SEM_INCIDENCIA_EM_VENDA", severidade: "alta", titulo: "Venda classificada como sem incidência", detalhe: `${ident}: CFOP ${it.cfop} (venda) com cClassTrib ${cls.cClassTrib} — ${cls.nome}.`, evidencia: `<CFOP>${it.cfop}</CFOP> · <cClassTrib>${it.cClassTrib}</cClassTrib>`, esperado: aliq ? xmlEsperado("000", "000001", vBCref, aliq, 0, 0) : undefined, recomendacao: "O fornecedor deixou de destacar IBS/CBS numa operação onerosa — sem destaque não há crédito. Solicitar correção.", valor: vBCref });
        }
        // Alíquotas nominais do ano.
        if (aliq && nota.finNFe !== 4) {
          const esperaZero = cls.indTribRegular;
          const checa: [string, GrupoTrib | null, number | null][] = [["pIBSUF", it.uf, esperaZero ? 0 : aliq.pIBSUF], ["pIBSMun", it.mun, esperaZero ? 0 : aliq.pIBSMun], ["pCBS", it.cbs, esperaZero ? 0 : aliq.pCBS]];
          const errados = checa.filter(([, g, e]) => g && e != null && Math.abs(g.p - e) > 0.00005);
          if (errados.length && (regime === "regular" || regime === "sn_regular")) {
            addItem({ regra: "ALIQUOTA_DIVERGENTE", severidade: "alta", titulo: "Alíquota de IBS/CBS diferente da vigente",
              detalhe: `${ident}: alíquotas nominais de ${ano} — CBS ${aliq.pCBS ?? "referência"}%, IBS UF ${aliq.pIBSUF}%, IBS Mun ${aliq.pIBSMun}% (LC 214, arts. 343, 344 e 346).`,
              evidencia: errados.map(([k, g]) => `<${k}>${fx(g!.p, 4)}</${k}>`).join(" "),
              esperado: errados.map(([k, , e]) => `<${k}>${fx(e!, 4)}</${k}>`).join(" "),
              recomendacao: "Destaque a maior gera crédito indevido (risco de glosa); a menor, crédito perdido. Solicitar correção.", valor: vBCref });
          }
        }
        // Redução (gRed) coerente com a tabela oficial.
        const grupos: [string, GrupoTrib | null, number][] = [["IBS UF", it.uf, cls.pRedIBS], ["IBS Mun", it.mun, cls.pRedIBS], ["CBS", it.cbs, cls.pRedCBS]];
        for (const [nome, g, pRedTab] of grupos) {
          if (!g || cls.indTribRegular) continue;
          if (pRedTab > 0 && g.pRed == null && g.p > 0) {
            addItem({ regra: "REDUCAO_NAO_INFORMADA", severidade: "alta", titulo: `Redução de alíquota não aplicada (${nome})`, detalhe: `${ident}: o cClassTrib ${cls.cClassTrib} prevê redução de ${fmt(pRedTab, 0)}%, mas o grupo ${nome} veio sem <gRed>.`, evidencia: `cClassTrib ${cls.cClassTrib} (pRed ${fmt(pRedTab, 2)}%) sem <gRed>`, esperado: `<gRed><pRedAliq>${fx(pRedTab, 4)}</pRedAliq><pAliqEfet>${fx(g.p * (1 - pRedTab / 100), 4)}</pAliqEfet></gRed>`, recomendacao: "Solicitar correção." });
          } else if (g.pRed != null) {
            const efet = g.p * (1 - g.pRed / 100);
            if (Math.abs(g.pRed - pRedTab) > 0.005 || (g.pAliqEfet != null && Math.abs(g.pAliqEfet - efet) > 0.0001)) {
              addItem({ regra: "REDUCAO_INCOERENTE", severidade: "alta", titulo: `Redução de alíquota incoerente (${nome})`, detalhe: `${ident}: tabela oficial manda pRedAliq ${fmt(pRedTab, 2)}% para o cClassTrib ${cls.cClassTrib}; pAliqEfet = alíquota × (1 − pRedAliq/100) (regra UB28).`, evidencia: `<pRedAliq>${fx(g.pRed, 4)}</pRedAliq><pAliqEfet>${fx(g.pAliqEfet || 0, 4)}</pAliqEfet>`, esperado: `<pRedAliq>${fx(pRedTab, 4)}</pRedAliq><pAliqEfet>${fx(g.p * (1 - pRedTab / 100), 4)}</pAliqEfet>`, recomendacao: "Solicitar correção." });
            }
          }
        }
        // Valores = vBC × alíquota efetiva − diferimento − devolução (tolerância de R$ 0,02).
        const valErr = grupos.filter(([, g]) => g && Math.abs(r2((it.vBC * (g.pAliqEfet ?? g.p)) / 100 - g.vDif - g.vDevTrib) - g.v) > 0.02);
        if (valErr.length && !it.temCredPres && !it.temMono) {
          addItem({ regra: "VALOR_DIVERGENTE", severidade: "alta", titulo: "Valor de IBS/CBS não bate com base × alíquota", detalhe: `${ident}: v = vBC × alíquota efetiva/100 − vDif − vDevTrib (NT 2025.002, regras de valor).`, evidencia: valErr.map(([nm, g]) => `${nm}: destacado R$ ${fmt(g!.v)} (vBC ${fmt(it.vBC)} × ${fmt(g!.pAliqEfet ?? g!.p, 4)}%)`).join(" · "), esperado: valErr.map(([nm, g]) => `${nm}: R$ ${fmt(r2((it.vBC * (g!.pAliqEfet ?? g!.p)) / 100 - g!.vDif - g!.vDevTrib))}`).join(" · "), recomendacao: "Solicitar correção do valor destacado." });
        }
        // Base de cálculo pela fórmula oficial (UB16-10 — a SEFAZ ainda não valida).
        if (it.vBC > 0 && Math.abs(it.vBC - it.baseFormula) > 0.02 && !it.temMono) {
          addItem({ regra: "BASE_DIVERGENTE", severidade: "media", titulo: "Base de cálculo de IBS/CBS fora da fórmula oficial",
            detalhe: `${ident}: vBC = vProd + vFrete + vSeg + vOutro + vII − vDesc − vPIS − vCOFINS − vICMS − vICMSUFDest − vFCP − vFCPUFDest − vICMSMono − vISSQN + vIS (NT 2025.002, UB16-10). A SEFAZ ainda não rejeita por essa regra, por isso precisa de auditoria.`,
            evidencia: `<vBC>${fx(it.vBC)}</vBC> · fórmula: R$ ${fmt(it.baseFormula)} (diferença R$ ${fmt(it.vBC - it.baseFormula)})`, esperado: `<vBC>${fx(it.baseFormula)}</vBC>`,
            recomendacao: it.vBC < it.baseFormula ? "Base a menor reduz o crédito destacado. Solicitar correção." : "Base a maior infla o crédito — risco de glosa. Solicitar correção.", valor: r2(it.vBC - it.baseFormula) });
        }
        if (it.uf?.temDif || it.cbs?.temDif) {
          addItem({ regra: "DIFERIMENTO", severidade: "info", titulo: "Operação com diferimento", detalhe: `${ident}: parte do IBS/CBS foi diferida (gDif) — o crédito considera só o valor efetivamente destacado.`, evidencia: `vDif IBS UF ${fmt(it.uf?.vDif || 0)} · vDif CBS ${fmt(it.cbs?.vDif || 0)}`, recomendacao: "Conferir o tratamento do crédito sobre a parcela diferida." });
        }
        if (it.temTribRegular) {
          addItem({ regra: "TRIBUTACAO_REGULAR", severidade: "info", titulo: "Tributação regular informada à parte (gTribRegular)", detalhe: `${ident}: operação com suspensão/ZFM — o valor fica em vTribReg*, sem crédito imediato.`, evidencia: "<gTribRegular>", recomendacao: "Acompanhar a conversão em tributação regular." });
        }
      }
    }
    // Redução esquecida: item tributado integralmente cujo NCM é da cesta básica (Anexo I) ou do Anexo VII.
    if (it.cClassTrib === "000001" && /^(0|1|2[0-4])/.test(it.ncm) && it.ncm.length === 8) {
      const a1 = consultaNcm("200003", it.ncm, ano), a7 = a1 ? false : consultaNcm("200034", it.ncm, ano);
      if (a1 || a7) {
        const c = a1 ? "200003" : "200034";
        const ci = CLASS.get(c)!;
        addItem({ regra: "REDUCAO_ESQUECIDA", severidade: "media", titulo: "Produto com direito a alíquota reduzida tributado integralmente",
          detalhe: `${ident}: a Calculadora oficial confirma o NCM ${it.ncm} no ${a1 ? "Anexo I (Cesta Básica Nacional — alíquota zero)" : "Anexo VII (redução de 60%)"}, mas o fornecedor destacou tributação integral (000001).`,
          evidencia: `<cClassTrib>000001</cClassTrib> · API ncm-aplicavel(${c}, ${it.ncm}) → valido:true`,
          esperado: aliq ? xmlEsperado(ci.cst, c, vBCref, aliq, ci.pRedIBS, ci.pRedCBS) : `<CST>${ci.cst}</CST><cClassTrib>${c}</cClassTrib>`,
          recomendacao: "O preço pode estar embutindo tributo maior que o devido. Renegociar o preço líquido com o fornecedor.", valor: vBCref });
      }
    }

    // ---- Crédito do item ----
    if (aliq) {
      const pCBSano = aliq.pCBS ?? CBS_2027_ESTIMADA;
      cred.referencia += (vBCref * (pCBSano * (1 - pRedCBS / 100) + (aliq.pIBSUF + aliq.pIBSMun) * (1 - pRedIBS / 100))) / 100;
    }
    const ref27 = regime === "pf" ? 0 : (vBCref * (CBS_2027_ESTIMADA * (1 - pRedCBS / 100) + 0.1 * (1 - pRedIBS / 100))) / 100;
    cred.referencia2027 += ref27;
    let aprov = 0, aprov27 = 0;
    if (regime === "regular" || regime === "sn_regular") {
      aprov = (it.uf?.v || 0) + (it.mun?.v || 0) + (it.cbs?.v || 0);
      aprov27 = it.temIBSCBS ? ref27 : 0; // emitindo certo, toma o crédito integral
    } else if (regime === "sn_dentro" && it.sn) {
      aprov = it.sn.vIBSSN + it.sn.vCBSSN;
      aprov27 = (vBCref * (it.sn.pIBSSN + it.sn.pCBSSN)) / 100;
    }
    // Classificação que veda o crédito do adquirente (lista oficial: indicaApropriacaoCreditoAdquirente).
    if (cls && aprov > 0 && (cls.creditoAdquirenteCbs === false || cls.creditoAdquirenteIbs === false)) {
      const vedado = (cls.creditoAdquirenteCbs === false ? it.cbs?.v || 0 : 0) + (cls.creditoAdquirenteIbs === false ? (it.uf?.v || 0) + (it.mun?.v || 0) : 0);
      if (vedado > 0) {
        add({ regra: "CREDITO_VEDADO", severidade: "info", nItem: it.nItem, titulo: "Classificação sem direito a crédito pelo adquirente", detalhe: `${ident}: pela lista oficial, o cClassTrib ${cls.cClassTrib} não permite apropriação de crédito pelo adquirente.`, evidencia: `<cClassTrib>${it.cClassTrib}</cClassTrib> · destacado R$ ${fmt(vedado)}`, recomendacao: "Não tomar crédito destes valores.", valor: vedado });
        aprov -= vedado;
      }
    }
    if (altaNoItem && aprov > 0) cred.risco += aprov;
    else cred.aproveitavel += aprov;
    cred.aproveitavel2027 += aprov27;
    const refAno = aliq && regime !== "pf" ? (vBCref * ((aliq.pCBS ?? CBS_2027_ESTIMADA) * (1 - pRedCBS / 100) + (aliq.pIBSUF + aliq.pIBSMun) * (1 - pRedIBS / 100))) / 100 : 0;
    const perda = Math.max(0, refAno - aprov);
    if (regime === "regular" || regime === "sn_regular") cred.perdaErro += perda;
    else cred.perdaEstrutural += perda;
    const novos = achados.slice(antes).filter((a) => a.severidade === "alta" || a.severidade === "media");
    if (!novos.length) itensConformes++;
  }
  for (const k of Object.keys(cred) as (keyof typeof cred)[]) cred[k] = r2(cred[k]);
  return { nota, regime, achados, credito: cred, itensConformes };
}

// Pares (cClassTrib, NCM) que a auditoria precisa validar na API oficial.
// NCMs fora da lista vigente que precisam de confirmação na data da emissão.
export function ncmsParaConfirmarVigencia(notas: NotaRT[]): { ncm: string; data: string }[] {
  const out = new Map<string, { ncm: string; data: string }>();
  for (const nota of notas) for (const it of nota.itens) {
    if (/^\d{8}$/.test(it.ncm) && it.ncm !== "00000000" && !NCM_VIGENTES.has(it.ncm)) out.set(`${it.ncm}|${nota.dhEmi}`, { ncm: it.ncm, data: nota.dhEmi });
  }
  return [...out.values()];
}
export async function consultarNcmVigenteNaDataApi(ncm: string, data: string): Promise<boolean> {
  const resp = await fetch(`${API_CALCULADORA}/ncm?ncm=${encodeURIComponent(ncm)}&data=${encodeURIComponent(data)}`, { signal: AbortSignal.timeout(20_000), headers: { Accept: "application/json" } });
  if (resp.status === 404) return false;
  if (!resp.ok) throw new Error(`Calculadora RFB respondeu HTTP ${resp.status}`);
  return true;
}
// Listas oficiais completas (atualização a cada 15 dias).
export async function baixarTabelasOficiaisApi(data: string) {
  const get = async (u: string) => { const r = await fetch(`${API_CALCULADORA}/${u}`, { signal: AbortSignal.timeout(90_000), headers: { Accept: "application/json" } }); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.json(); };
  const [ncms, classes, situacoes] = await Promise.all([get(`ncm/vigentes?data=${data}`), get(`classificacoes-tributarias/cbs-ibs?data=${data}`), get(`situacoes-tributarias/cbs-ibs?data=${data}&siglaDfe=NF-e`)]);
  return { data, ncms, classes, situacoes };
}
export function paresParaValidar(notas: NotaRT[]): { cClassTrib: string; ncm: string; ano: number }[] {
  const out = new Map<string, { cClassTrib: string; ncm: string; ano: number }>();
  const put = (c: string, ncm: string, ano: number) => out.set(`${c}|${ncm}|${ano}`, { cClassTrib: c, ncm, ano });
  for (const nota of notas) {
    const ano = Number(nota.dhEmi.slice(0, 4)) || new Date().getFullYear();
    for (const it of nota.itens) {
      if (!it.ncm || it.ncm.length !== 8) continue;
      const cls = it.cClassTrib ? CLASS.get(it.cClassTrib) : null;
      if (cls?.anexo) put(cls.cClassTrib, it.ncm, ano);
      if (it.cClassTrib === "000001" && /^(0|1|2[0-4])/.test(it.ncm)) { put("200003", it.ncm, ano); put("200034", it.ncm, ano); }
    }
  }
  return [...out.values()];
}

// Consulta oficial: Calculadora de Tributos (RFB/CGIBS), pública e sem autenticação.
const API_CALCULADORA = "https://consumo.tributos.gov.br/servico/calcular-tributos-consumo/api/calculadora/dados-abertos";
export async function consultarNcmAplicavelApi(cClassTrib: string, ncm: string, ano: number): Promise<boolean> {
  const hoje = new Date().toISOString().slice(0, 10);
  const data = `${ano}-12-31` < hoje ? `${ano}-12-31` : hoje;
  const url = `${API_CALCULADORA}/classificacoes-tributarias/ncm-aplicavel?cClassTrib=${encodeURIComponent(cClassTrib)}&ncm=${encodeURIComponent(ncm)}&dataOcorrenciaFatoGerador=${data}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`Calculadora RFB respondeu HTTP ${resp.status}`);
  const j: any = await resp.json();
  if (typeof j?.valido !== "boolean") throw new Error("Resposta inesperada da Calculadora RFB");
  return j.valido;
}
