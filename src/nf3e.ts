// Leitura do XML da NF3-e (Nota Fiscal de Energia Elétrica Eletrônica, modelo 66) — conta de energia.
// A NF3-e NÃO vem pela Distribuição de DF-e da Sefaz (só NF-e/CT-e têm esse serviço nacional), por isso
// entra por uma importação PRÓPRIA (rota /api/nfe/nf3e/...), separada da busca padrão do site e da do
// Extrato NFE: grava em nfe_documentos com fonte='nf3e' e tipo='nf3e'.
// Leitura tolerante por tags (o leiaute da NF3-e segue o padrão da NF-e: infNF3e/ide/emit/dest/total/protNF3e).

export interface Nf3e {
  chave: string;
  numero: string;
  serie: string;
  dhEmi: string;
  emitCnpj: string | null;
  emitNome: string | null;
  destDoc: string | null; // CNPJ ou CPF do titular da conta
  destNome: string | null;
  valor: number; // vNF
  vICMS: number;
  vPIS: number;
  vCOFINS: number;
  competencia: string | null; // AAAA-MM (gFat/CompetFat)
  vencimento: string | null; // AAAA-MM-DD (gFat/dVencFat)
  unidadeConsumidora: string | null; // acessante/idAcesso
  autorizada: boolean; // protNF3e cStat 100
}
export interface EventoNf3e {
  chave: string;
  tipoEvento: string; // 110111 = cancelamento
  descricao: string;
  dhEvento: string | null;
}

const tag = (x: string, t: string): string | null => {
  const m = x.match(new RegExp(`<(?:\\w+:)?${t}>([^<]*)</(?:\\w+:)?${t}>`));
  return m ? m[1].trim() : null;
};
const bloco = (x: string, t: string): string => {
  const m = x.match(new RegExp(`<(?:\\w+:)?${t}[ >][\\s\\S]*?</(?:\\w+:)?${t}>`));
  return m ? m[0] : "";
};
const num = (s: string | null) => {
  const n = Number(String(s ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

export function ehNf3e(xml: string): boolean {
  return /<(?:\w+:)?(NF3e|nf3eProc)[ >]/.test(xml) || /<(?:\w+:)?infNF3e[ >]/.test(xml);
}
export function ehEventoNf3e(xml: string): boolean {
  return /<(?:\w+:)?(procEventoNF3e|eventoNF3e)[ >]/.test(xml);
}

export function lerNf3e(xml: string): Nf3e {
  if (!ehNf3e(xml)) throw new Error("Não é um XML de NF3-e (conta de energia, modelo 66).");
  const inf = bloco(xml, "infNF3e");
  if (!inf) throw new Error("XML de NF3-e sem o grupo infNF3e.");
  const idAttr = inf.match(/Id="NF3e(\d{44})"/)?.[1];
  const chave = tag(xml, "chNF3e") || idAttr;
  if (!chave || !/^\d{44}$/.test(chave)) throw new Error("Não achei a chave de acesso (44 dígitos) da NF3-e.");
  const ide = bloco(inf, "ide"), emit = bloco(inf, "emit"), dest = bloco(inf, "dest"), total = bloco(inf, "total");
  const gFat = bloco(inf, "gFat"), acess = bloco(inf, "acessante");
  const compet = tag(gFat, "CompetFat"); // AAAAMM
  const prot = bloco(xml, "protNF3e");
  const icmsTot = bloco(total, "ICMSTot");
  const vNF = num(tag(total, "vNF"));
  return {
    chave,
    numero: String(Number(tag(ide, "nNF") || chave.slice(25, 34))),
    serie: String(Number(tag(ide, "serie") || chave.slice(22, 25))),
    dhEmi: tag(ide, "dhEmi") || "",
    emitCnpj: tag(emit, "CNPJ"),
    emitNome: tag(emit, "xNome"),
    destDoc: tag(dest, "CNPJ") || tag(dest, "CPF"),
    destNome: tag(dest, "xNome"),
    valor: vNF,
    vICMS: num(tag(icmsTot || total, "vICMS")),
    vPIS: num(tag(total, "vPIS")),
    vCOFINS: num(tag(total, "vCOFINS")),
    competencia: compet && /^\d{6}$/.test(compet) ? `${compet.slice(0, 4)}-${compet.slice(4, 6)}` : null,
    vencimento: tag(gFat, "dVencFat"),
    unidadeConsumidora: tag(acess, "idAcesso"),
    autorizada: !prot || tag(prot, "cStat") === "100",
  };
}

export function lerEventoNf3e(xml: string): EventoNf3e {
  const chave = tag(xml, "chNF3e");
  if (!chave || !/^\d{44}$/.test(chave)) throw new Error("Evento de NF3-e sem a chave de acesso.");
  const tipoEvento = tag(xml, "tpEvento") || "";
  const descricao = tag(xml, "descEvento") || (tipoEvento === "110111" ? "Cancelamento" : `Evento ${tipoEvento}`);
  return { chave, tipoEvento, descricao, dhEvento: tag(xml, "dhEvento") };
}
