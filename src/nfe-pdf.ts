import fs from "fs";
import path from "path";
import { XMLParser } from "fast-xml-parser";

// PDF simplificado não é segredo (é o mesmo documento que qualquer parte interessada já vê) —
// cache em disco sem cifra, só pra não rerenderizar (Playwright/Chromium) toda vez que baixarem de novo.
const PDF_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, "..", "data"), "nfe-documentos-pdf");
fs.mkdirSync(PDF_DIR, { recursive: true });
export function salvarPdfEmCache(chaveOuId: string, pdfBuffer: Buffer): string {
  const nome = chaveOuId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const destino = path.join(PDF_DIR, `${nome}.pdf`);
  fs.writeFileSync(destino, pdfBuffer);
  return destino;
}

/**
 * Representação simplificada em PDF de uma NF-e/NFC-e já buscada (não é o DANFE oficial — esse
 * layout tem posicionamento certificado por Nota Técnica própria, mais complexo que o DANFSe;
 * aqui é só uma versão legível com os dados que já temos do XML, pra conferência/arquivo do
 * escritório). Quando o documento veio como resumo (schema resNFe/resNFCe, sem itens), mostra só o
 * cabeçalho — a Sefaz não manda os itens nesse formato, só na versão completa (procNFe).
 */

const xmlParser = new XMLParser({ attributeNamePrefix: "@_", ignoreAttributes: false, parseAttributeValue: false, parseTagValue: false, trimValues: true });

function esc(s: any): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmtMoney(v: string | number | null | undefined): string {
  const n = v != null ? Number(v) : NaN;
  return isNaN(n) ? "-" : n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function fmtDoc(doc: string | null | undefined): string {
  const d = String(doc || "").replace(/\D/g, "");
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  return doc || "-";
}
function fmtData(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso) : d.toLocaleString("pt-BR");
}
function fmtChave(chave: string | null | undefined): string {
  const c = String(chave || "").replace(/\D/g, "");
  return c ? c.replace(/(\d{4})(?=\d)/g, "$1 ") : "-";
}

export interface ItemNfe {
  codigo: string | null;
  descricao: string | null;
  ncm: string | null;
  cfop: string | null;
  unidade: string | null;
  quantidade: number | null;
  valorUnitario: number | null;
  valorTotal: number | null;
}
export interface DadosNfe {
  resumo: boolean; // true = só temos o resumo (resNFe/resNFCe), sem itens
  modelo: "nfe" | "nfce" | "outro";
  chaveAcesso: string | null;
  numero: string | null;
  serie: string | null;
  dataEmissao: string | null;
  naturezaOperacao: string | null;
  protocolo: string | null;
  emitente: { documento: string | null; nome: string | null; ie: string | null; endereco: string | null };
  destinatario: { documento: string | null; nome: string | null; endereco: string | null };
  itens: ItemNfe[];
  totais: { produtos: number | null; frete: number | null; desconto: number | null; icms: number | null; total: number | null };
}

function montarEndereco(end: any): string | null {
  if (!end) return null;
  const partes = [end.xLgr, end.nro, end.xCpl, end.xBairro, end.xMun, end.UF, end.CEP].filter(Boolean);
  return partes.length ? partes.join(", ") : null;
}

export function extrairDadosNfe(xml: string): DadosNfe | null {
  const json = xmlParser.parse(xml) as any;
  const infNFe = json?.nfeProc?.NFe?.infNFe;
  if (infNFe) {
    const emit = infNFe.emit || {};
    const dest = infNFe.dest || {};
    const ide = infNFe.ide || {};
    const total = infNFe.total?.ICMSTot || {};
    const protNFe = json?.nfeProc?.protNFe?.infProt;
    let detList = infNFe.det;
    if (!detList) detList = [];
    else if (!Array.isArray(detList)) detList = [detList];
    const itens: ItemNfe[] = detList.map((d: any) => {
      const prod = d.prod || {};
      return {
        codigo: prod.cProd || null,
        descricao: prod.xProd || null,
        ncm: prod.NCM || null,
        cfop: prod.CFOP || null,
        unidade: prod.uCom || null,
        quantidade: prod.qCom != null ? Number(prod.qCom) : null,
        valorUnitario: prod.vUnCom != null ? Number(prod.vUnCom) : null,
        valorTotal: prod.vProd != null ? Number(prod.vProd) : null,
      };
    });
    return {
      resumo: false,
      modelo: ide.mod === "65" ? "nfce" : ide.mod === "55" ? "nfe" : "outro",
      chaveAcesso: String(infNFe["@_Id"] || "").replace(/^NFe/, "") || null,
      numero: ide.nNF || null,
      serie: ide.serie || null,
      dataEmissao: ide.dhEmi || null,
      naturezaOperacao: ide.natOp || null,
      protocolo: protNFe?.nProt || null,
      emitente: { documento: emit.CNPJ || emit.CPF || null, nome: emit.xNome || null, ie: emit.IE || null, endereco: montarEndereco(emit.enderEmit) },
      destinatario: { documento: dest.CNPJ || dest.CPF || null, nome: dest.xNome || null, endereco: montarEndereco(dest.enderDest) },
      itens,
      totais: {
        produtos: total.vProd != null ? Number(total.vProd) : null,
        frete: total.vFrete != null ? Number(total.vFrete) : null,
        desconto: total.vDesc != null ? Number(total.vDesc) : null,
        icms: total.vICMS != null ? Number(total.vICMS) : null,
        total: total.vNF != null ? Number(total.vNF) : null,
      },
    };
  }
  // Resumo (resNFe/resNFCe) — sem itens, só o cabeçalho básico.
  const res = json?.resNFe;
  if (res) {
    return {
      resumo: true,
      modelo: "outro",
      chaveAcesso: res.chNFe || null,
      numero: null,
      serie: null,
      dataEmissao: res.dhEmi || null,
      naturezaOperacao: null,
      protocolo: null,
      emitente: { documento: res.CNPJ || null, nome: res.xNome || null, ie: null, endereco: null },
      destinatario: { documento: null, nome: null, endereco: null },
      itens: [],
      totais: { produtos: null, frete: null, desconto: null, icms: null, total: res.vNF != null ? Number(res.vNF) : null },
    };
  }
  return null;
}

export function gerarNfeHtml(d: DadosNfe): string {
  const tituloModelo = d.modelo === "nfce" ? "NFC-e" : d.modelo === "nfe" ? "NF-e" : "Documento Fiscal";
  const linhasItens = d.itens
    .map(
      (it) => `<tr>
        <td>${esc(it.codigo)}</td>
        <td>${esc(it.descricao)}</td>
        <td>${esc(it.ncm)}</td>
        <td>${esc(it.cfop)}</td>
        <td style="text-align:right;">${it.quantidade != null ? it.quantidade.toLocaleString("pt-BR") : "-"} ${esc(it.unidade)}</td>
        <td style="text-align:right;">${fmtMoney(it.valorUnitario)}</td>
        <td style="text-align:right;">${fmtMoney(it.valorTotal)}</td>
      </tr>`
    )
    .join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,Helvetica,sans-serif; font-size:11px; color:#1a1a1a; margin:0;}
    .titulo{font-size:16px; font-weight:bold; border-bottom:2px solid #1a1a1a; padding-bottom:6px; margin-bottom:10px;}
    .titulo small{display:block; font-size:11px; font-weight:normal; color:#555;}
    .aviso{background:#fff8e1; border:1px solid #e0c060; padding:6px 10px; font-size:10px; margin-bottom:10px;}
    .bloco{border:1px solid #ccc; border-radius:4px; padding:8px 10px; margin-bottom:10px;}
    .bloco h4{margin:0 0 6px; font-size:11px; text-transform:uppercase; color:#555;}
    .grid{display:grid; grid-template-columns:1fr 1fr; gap:4px 16px;}
    .campo b{display:block; font-size:9px; color:#777; text-transform:uppercase;}
    table{width:100%; border-collapse:collapse; margin-top:6px;}
    th,td{border:1px solid #ccc; padding:4px 6px; font-size:10px;}
    th{background:#f0f0f0; text-align:left;}
    .totais{display:flex; justify-content:flex-end; gap:24px; margin-top:8px;}
    .totais .campo{text-align:right;}
    .chave{font-family:'Courier New',monospace; font-size:11px;}
  </style></head><body>
    <div class="titulo">${esc(tituloModelo)} ${d.numero ? `nº ${esc(d.numero)}${d.serie ? ` — série ${esc(d.serie)}` : ""}` : ""}
      <small>Chave de acesso: <span class="chave">${fmtChave(d.chaveAcesso)}</span></small>
    </div>
    ${d.resumo ? `<div class="aviso">A Sefaz disponibilizou só o resumo deste documento (sem itens detalhados) — é o que estava disponível na distribuição.</div>` : ""}
    <div class="bloco">
      <h4>Emitente</h4>
      <div class="grid">
        <div class="campo"><b>Nome/Razão social</b>${esc(d.emitente.nome || "-")}</div>
        <div class="campo"><b>CNPJ/CPF</b>${fmtDoc(d.emitente.documento)}</div>
        ${d.emitente.ie ? `<div class="campo"><b>Inscrição estadual</b>${esc(d.emitente.ie)}</div>` : ""}
        ${d.emitente.endereco ? `<div class="campo" style="grid-column:1/-1;"><b>Endereço</b>${esc(d.emitente.endereco)}</div>` : ""}
      </div>
    </div>
    ${d.destinatario.nome || d.destinatario.documento ? `
    <div class="bloco">
      <h4>Destinatário</h4>
      <div class="grid">
        <div class="campo"><b>Nome/Razão social</b>${esc(d.destinatario.nome || "-")}</div>
        <div class="campo"><b>CNPJ/CPF</b>${fmtDoc(d.destinatario.documento)}</div>
        ${d.destinatario.endereco ? `<div class="campo" style="grid-column:1/-1;"><b>Endereço</b>${esc(d.destinatario.endereco)}</div>` : ""}
      </div>
    </div>` : ""}
    <div class="bloco">
      <h4>Dados do documento</h4>
      <div class="grid">
        <div class="campo"><b>Data de emissão</b>${fmtData(d.dataEmissao)}</div>
        ${d.naturezaOperacao ? `<div class="campo"><b>Natureza da operação</b>${esc(d.naturezaOperacao)}</div>` : ""}
        ${d.protocolo ? `<div class="campo"><b>Protocolo de autorização</b>${esc(d.protocolo)}</div>` : ""}
      </div>
    </div>
    ${d.itens.length ? `
    <div class="bloco">
      <h4>Itens</h4>
      <table>
        <thead><tr><th>Código</th><th>Descrição</th><th>NCM</th><th>CFOP</th><th>Qtd.</th><th>Vlr. unit.</th><th>Vlr. total</th></tr></thead>
        <tbody>${linhasItens}</tbody>
      </table>
    </div>` : ""}
    <div class="totais">
      ${d.totais.produtos != null ? `<div class="campo"><b>Total produtos</b>${fmtMoney(d.totais.produtos)}</div>` : ""}
      ${d.totais.desconto ? `<div class="campo"><b>Desconto</b>${fmtMoney(d.totais.desconto)}</div>` : ""}
      ${d.totais.frete ? `<div class="campo"><b>Frete</b>${fmtMoney(d.totais.frete)}</div>` : ""}
      ${d.totais.icms != null ? `<div class="campo"><b>ICMS</b>${fmtMoney(d.totais.icms)}</div>` : ""}
      <div class="campo"><b>Valor total</b><span style="font-size:14px; font-weight:bold;">${fmtMoney(d.totais.total)}</span></div>
    </div>
  </body></html>`;
}

export async function gerarPdfSimplificadoNfe(xml: string): Promise<Buffer> {
  const dados = extrairDadosNfe(xml);
  if (!dados) throw new Error("Não consegui montar o PDF — XML em formato inesperado.");
  const html = gerarNfeHtml(dados);
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    const pdf = await page.pdf({ format: "A4", printBackground: true, margin: { top: "1.2cm", bottom: "1.2cm", left: "1.2cm", right: "1.2cm" } });
    return pdf as Buffer;
  } finally {
    await browser.close();
  }
}
