import fs from "fs";
import path from "path";
import { XMLParser } from "fast-xml-parser";

// PDF do DANFE não é segredo (é o mesmo documento que qualquer parte interessada já vê) — cache em
// disco sem cifra, só pra não rerenderizar (Playwright/Chromium) toda vez que baixarem de novo.
const PDF_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, "..", "data"), "nfe-documentos-pdf");
fs.mkdirSync(PDF_DIR, { recursive: true });
export function salvarPdfEmCache(chaveOuId: string, pdfBuffer: Buffer): string {
  const nome = chaveOuId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const destino = path.join(PDF_DIR, `${nome}.pdf`);
  fs.writeFileSync(destino, pdfBuffer);
  return destino;
}

/**
 * DANFE (Documento Auxiliar da Nota Fiscal Eletrônica) — modelo 55 (NF-e) e 65 (NFC-e), gerado
 * localmente a partir do XML já buscado, sem depender de nenhuma API externa (o mesmo princípio já
 * usado no DANFSe — ver src/danfse.ts). Layout reproduz as caixas/seções do leiaute retrato padrão
 * (Manual de Orientação do Contribuinte, Anexo do DANFE) — código de barras Code128C da chave de
 * acesso via JSBarcode, gerado no próprio navegador (Playwright) antes de imprimir o PDF, sem
 * precisar de canvas no lado do servidor.
 *
 * Quando o documento veio como resumo (schema resNFe/resNFCe, sem itens), mostra só o cabeçalho —
 * a Sefaz não manda os itens nesse formato, só na versão completa (procNFe).
 */

const xmlParser = new XMLParser({ attributeNamePrefix: "@_", ignoreAttributes: false, parseAttributeValue: false, parseTagValue: false, trimValues: true });

function esc(s: any): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function num(v: any): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}
function fmtMoney(v: number | null | undefined): string {
  return v == null ? "0,00" : v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtQtd(v: number | null | undefined): string {
  return v == null ? "-" : v.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}
function fmtDoc(doc: string | null | undefined): string {
  const d = String(doc || "").replace(/\D/g, "");
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  return doc || "";
}
function fmtCep(cep: string | null | undefined): string {
  const c = String(cep || "").replace(/\D/g, "");
  return c.length === 8 ? c.replace(/(\d{5})(\d{3})/, "$1-$2") : cep || "";
}
function fmtDataHora(iso: string | null | undefined): { data: string; hora: string } {
  if (!iso) return { data: "", hora: "" };
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { data: "", hora: "" };
  return { data: d.toLocaleDateString("pt-BR"), hora: d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) };
}
function fmtChave(chave: string | null | undefined): string {
  const c = String(chave || "").replace(/\D/g, "");
  return c ? (c.match(/.{1,4}/g) || []).join(" ") : "";
}
// Dentro de <ICMS>/<IPI> o nome da tag-filha muda conforme o CST/CSOSN (ICMS00, ICMS10, ICMS60,
// ICMSSN102, IPITrib, IPINT...) mas os campos internos (vBC, pICMS, vICMS...) têm o mesmo nome em
// qualquer variante — então só pega o primeiro (e único) filho, seja qual for a tag dele.
function primeiroFilho(obj: any): any {
  if (!obj || typeof obj !== "object") return null;
  const chave = Object.keys(obj)[0];
  return chave ? obj[chave] : null;
}
function comoLista(v: any): any[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export interface ItemNfe {
  numero: number;
  codigo: string | null;
  descricao: string | null;
  ncm: string | null;
  cst: string | null;
  cfop: string | null;
  unidade: string | null;
  quantidade: number | null;
  valorUnitario: number | null;
  valorTotal: number | null;
  valorDesconto: number | null;
  bcIcms: number | null;
  valorIcms: number | null;
  aliqIcms: number | null;
  valorIpi: number | null;
  aliqIpi: number | null;
}
interface Endereco {
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  municipio: string | null;
  uf: string | null;
  cep: string | null;
  fone: string | null;
}
interface Parcela {
  numero: string | null;
  vencimento: string | null;
  valor: number | null;
}
export interface DadosNfe {
  resumo: boolean; // true = só temos o resumo (resNFe/resNFCe), sem itens
  modelo: "nfe" | "nfce" | "outro";
  tipoOperacao: "0" | "1" | null; // 0-Entrada, 1-Saída
  chaveAcesso: string | null;
  numero: string | null;
  serie: string | null;
  dataEmissao: string | null;
  dataSaidaEntrada: string | null;
  naturezaOperacao: string | null;
  protocolo: { numero: string | null; dataHora: string | null };
  emitente: { documento: string | null; nome: string | null; ie: string | null; ieSt: string | null; endereco: Endereco };
  destinatario: { documento: string | null; nome: string | null; ie: string | null; endereco: Endereco };
  itens: ItemNfe[];
  fatura: { parcelas: Parcela[] };
  transportador: {
    modalidadeFrete: string | null;
    documento: string | null;
    nome: string | null;
    ie: string | null;
    endereco: string | null;
    municipio: string | null;
    uf: string | null;
    veiculoPlaca: string | null;
    veiculoUf: string | null;
    veiculoAntt: string | null;
    volumes: { quantidade: string | null; especie: string | null; marca: string | null; numeracao: string | null; pesoBruto: string | null; pesoLiquido: string | null } | null;
  };
  totais: {
    bcIcms: number | null;
    icms: number | null;
    bcIcmsSt: number | null;
    icmsSt: number | null;
    icmsDesoneracao: number | null;
    produtos: number | null;
    frete: number | null;
    seguro: number | null;
    desconto: number | null;
    outrasDespesas: number | null;
    ipi: number | null;
    total: number | null;
  };
  issqn: { inscricaoMunicipal: string | null; valorServicos: number | null; bcIssqn: number | null; valorIssqn: number | null } | null;
  informacoesComplementares: string | null;
  informacoesFisco: string | null;
}

function montarEndereco(end: any): Endereco {
  return {
    logradouro: end?.xLgr || null,
    numero: end?.nro || null,
    complemento: end?.xCpl || null,
    bairro: end?.xBairro || null,
    municipio: end?.xMun || null,
    uf: end?.UF || null,
    cep: end?.CEP || null,
    fone: end?.fone || null,
  };
}
function enderecoLinha1(e: Endereco): string {
  return [e.logradouro, e.numero, e.complemento].filter(Boolean).join(", ");
}

export function extrairDadosNfe(xml: string): DadosNfe | null {
  const json = xmlParser.parse(xml) as any;
  const infNFe = json?.nfeProc?.NFe?.infNFe || json?.NFe?.infNFe;
  if (infNFe) {
    const emit = infNFe.emit || {};
    const dest = infNFe.dest || {};
    const ide = infNFe.ide || {};
    const total = infNFe.total?.ICMSTot || {};
    const issqnTot = infNFe.total?.ISSQNtot;
    const transp = infNFe.transp || {};
    const cobr = infNFe.cobr;
    const infAdic = infNFe.infAdic;
    const protNFe = json?.nfeProc?.protNFe?.infProt;

    let detList = comoLista(infNFe.det);
    const itens: ItemNfe[] = detList.map((d: any, i: number) => {
      const prod = d.prod || {};
      const icmsFilho = primeiroFilho(d.imposto?.ICMS) || {};
      const ipiFilho = primeiroFilho(d.imposto?.IPI?.IPITrib ? { IPITrib: d.imposto.IPI.IPITrib } : d.imposto?.IPI) || {};
      return {
        numero: Number(d["@_nItem"]) || i + 1,
        codigo: prod.cProd || null,
        descricao: prod.xProd || null,
        ncm: prod.NCM || null,
        cst: icmsFilho.CST || icmsFilho.CSOSN || null,
        cfop: prod.CFOP || null,
        unidade: prod.uCom || null,
        quantidade: num(prod.qCom),
        valorUnitario: num(prod.vUnCom),
        valorTotal: num(prod.vProd),
        valorDesconto: num(prod.vDesc),
        bcIcms: num(icmsFilho.vBC),
        valorIcms: num(icmsFilho.vICMS),
        aliqIcms: num(icmsFilho.pICMS),
        valorIpi: num(ipiFilho.vIPI),
        aliqIpi: num(ipiFilho.pIPI),
      };
    });

    const dup: Parcela[] = comoLista(cobr?.dup).map((p: any) => ({ numero: p.nDup || null, vencimento: p.dVenc || null, valor: num(p.vDup) }));

    const volRaw = comoLista(transp.vol)[0];
    const veic = transp.veicTransp || {};
    const transporta = transp.transporta || {};

    return {
      resumo: false,
      modelo: ide.mod === "65" ? "nfce" : ide.mod === "55" ? "nfe" : "outro",
      tipoOperacao: ide.tpNF === "0" ? "0" : ide.tpNF === "1" ? "1" : null,
      chaveAcesso: String(infNFe["@_Id"] || "").replace(/^NFe/, "") || null,
      numero: ide.nNF || null,
      serie: ide.serie || null,
      dataEmissao: ide.dhEmi || null,
      dataSaidaEntrada: ide.dhSaiEnt || null,
      naturezaOperacao: ide.natOp || null,
      protocolo: { numero: protNFe?.nProt || null, dataHora: protNFe?.dhRecbto || null },
      emitente: {
        documento: emit.CNPJ || emit.CPF || null,
        nome: emit.xNome || null,
        ie: emit.IE || null,
        ieSt: emit.IEST || null,
        endereco: montarEndereco(emit.enderEmit),
      },
      destinatario: {
        documento: dest.CNPJ || dest.CPF || null,
        nome: dest.xNome || null,
        ie: dest.IE || null,
        endereco: montarEndereco(dest.enderDest),
      },
      itens,
      fatura: { parcelas: dup },
      transportador: {
        modalidadeFrete: transp.modFrete ?? null,
        documento: transporta.CNPJ || transporta.CPF || null,
        nome: transporta.xNome || null,
        ie: transporta.IE || null,
        endereco: transporta.xEnder || null,
        municipio: transporta.xMun || null,
        uf: transporta.UF || null,
        veiculoPlaca: veic.placa || null,
        veiculoUf: veic.UF || null,
        veiculoAntt: veic.RNTC || null,
        volumes: volRaw
          ? { quantidade: volRaw.qVol || null, especie: volRaw.esp || null, marca: volRaw.marca || null, numeracao: volRaw.nVol || null, pesoBruto: volRaw.pesoB || null, pesoLiquido: volRaw.pesoL || null }
          : null,
      },
      totais: {
        bcIcms: num(total.vBC),
        icms: num(total.vICMS),
        bcIcmsSt: num(total.vBCST),
        icmsSt: num(total.vST),
        icmsDesoneracao: num(total.vICMSDeson),
        produtos: num(total.vProd),
        frete: num(total.vFrete),
        seguro: num(total.vSeg),
        desconto: num(total.vDesc),
        outrasDespesas: num(total.vOutro),
        ipi: num(total.vIPI),
        total: num(total.vNF),
      },
      issqn: issqnTot ? { inscricaoMunicipal: emit.IM || null, valorServicos: num(issqnTot.vServ), bcIssqn: num(issqnTot.vBC), valorIssqn: num(issqnTot.vISS) } : null,
      informacoesComplementares: infAdic?.infCpl || null,
      informacoesFisco: infAdic?.infAdFisco || null,
    };
  }
  // Resumo (resNFe/resNFCe) — sem itens, só o cabeçalho básico.
  const res = json?.resNFe;
  if (res) {
    return {
      resumo: true,
      modelo: "outro",
      tipoOperacao: null,
      chaveAcesso: res.chNFe || null,
      numero: null,
      serie: null,
      dataEmissao: res.dhEmi || null,
      dataSaidaEntrada: null,
      naturezaOperacao: null,
      protocolo: { numero: null, dataHora: null },
      emitente: { documento: res.CNPJ || null, nome: res.xNome || null, ie: null, ieSt: null, endereco: { logradouro: null, numero: null, complemento: null, bairro: null, municipio: null, uf: null, cep: null, fone: null } },
      destinatario: { documento: null, nome: null, ie: null, endereco: { logradouro: null, numero: null, complemento: null, bairro: null, municipio: null, uf: null, cep: null, fone: null } },
      itens: [],
      fatura: { parcelas: [] },
      transportador: { modalidadeFrete: null, documento: null, nome: null, ie: null, endereco: null, municipio: null, uf: null, veiculoPlaca: null, veiculoUf: null, veiculoAntt: null, volumes: null },
      totais: { bcIcms: null, icms: null, bcIcmsSt: null, icmsSt: null, icmsDesoneracao: null, produtos: null, frete: null, seguro: null, desconto: null, outrasDespesas: null, ipi: null, total: num(res.vNF) },
      issqn: null,
      informacoesComplementares: null,
      informacoesFisco: null,
    };
  }
  return null;
}

const FRETE_LABEL: Record<string, string> = {
  "0": "0 - Contratação do Frete por conta do Remetente (CIF)",
  "1": "1 - Contratação do Frete por conta do Destinatário (FOB)",
  "2": "2 - Contratação do Frete por conta de Terceiros",
  "3": "3 - Transporte Próprio por conta do Remetente",
  "4": "4 - Transporte Próprio por conta do Destinatário",
  "9": "9 - Sem Ocorrência de Transporte",
};

function campo(rotulo: string, valor: string, opts?: { destaque?: boolean; span?: number }): string {
  const estiloValor = opts?.destaque ? `font-weight:bold; font-size:12px;` : "";
  const estiloCol = opts?.span ? `grid-column:span ${opts.span};` : "";
  return `<div class="campo" style="${estiloCol}"><b>${esc(rotulo)}</b><span style="${estiloValor}">${esc(valor) || "&nbsp;"}</span></div>`;
}

export function gerarNfeHtml(d: DadosNfe): string {
  const tituloModelo = d.modelo === "nfce" ? "NFC-e" : "NF-e";
  const emitEnd = d.emitente.endereco;
  const destEnd = d.destinatario.endereco;
  const protocolo = d.protocolo.numero ? `${d.protocolo.numero}${d.protocolo.dataHora ? " " + fmtDataHora(d.protocolo.dataHora).data + " " + fmtDataHora(d.protocolo.dataHora).hora : ""}` : "";
  const dataEmissao = fmtDataHora(d.dataEmissao);
  const dataSaida = fmtDataHora(d.dataSaidaEntrada);
  const valorTotalNota = d.totais.total ?? d.totais.produtos;
  const valorAExtenso = "";

  const linhasItens = d.itens
    .map(
      (it) => `<tr>
        <td>${esc(it.codigo)}</td>
        <td class="descProd">${esc(it.descricao)}</td>
        <td>${esc(it.ncm)}</td>
        <td class="center">${esc(it.cst)}</td>
        <td class="center">${esc(it.cfop)}</td>
        <td class="center">${esc(it.unidade)}</td>
        <td class="num">${fmtQtd(it.quantidade)}</td>
        <td class="num">${fmtMoney(it.valorUnitario)}</td>
        <td class="num">${fmtMoney(it.valorTotal)}</td>
        <td class="num">${fmtMoney(it.bcIcms)}</td>
        <td class="num">${fmtMoney(it.valorIcms)}</td>
        <td class="num">${fmtMoney(it.valorIpi)}</td>
        <td class="num">${it.aliqIcms != null ? it.aliqIcms.toLocaleString("pt-BR") : "-"}</td>
      </tr>`
    )
    .join("");

  const linhasParcelas = d.fatura.parcelas
    .map((p) => `Dup=${esc(p.numero)} Venc=${p.vencimento ? new Date(p.vencimento).toLocaleDateString("pt-BR") : "-"} Valor=${fmtMoney(p.valor)}`)
    .join(" &nbsp;&nbsp; ");

  const vol = d.transportador.volumes;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 8mm; }
    *{box-sizing:border-box;}
    body{font-family:Arial,Helvetica,sans-serif; font-size:9px; color:#000; margin:0;}
    .quadro{border:1px solid #000;}
    .linha{display:flex;}
    .linha > div{border-right:1px solid #000; padding:2px 4px;}
    .linha > div:last-child{border-right:none;}
    .campo{padding:2px 4px; border-right:1px solid #000;}
    .campo:last-child{border-right:none;}
    .campo b{display:block; font-size:6.5px; text-transform:uppercase; color:#333; font-weight:normal;}
    .campo span{display:block; font-size:9.5px;}
    .grid{display:grid;}
    .titulo-secao{font-size:7px; text-transform:uppercase; font-weight:bold; border-bottom:1px solid #000; padding:1px 4px; background:#f2f2f2;}
    .mb{margin-bottom:2mm;}
    table.itens{width:100%; border-collapse:collapse; font-size:7.5px;}
    table.itens th, table.itens td{border:1px solid #000; padding:2px 3px;}
    table.itens th{background:#f2f2f2; font-size:6.5px; text-transform:uppercase; font-weight:normal;}
    table.itens td.num{text-align:right; white-space:nowrap;}
    table.itens td.center{text-align:center;}
    table.itens td.descProd{max-width:220px;}
    .canhoto{font-size:7.5px; margin-bottom:2mm;}
    .canhoto .linha > div:first-child{flex:1;}
    .canhoto .linha > div:last-child{width:110px; text-align:center;}
    .canhoto .nfeLabel{font-size:13px; font-weight:bold;}
    .canhoto small{display:block; font-size:6.5px; margin-top:2px;}
    .header{}
    .header .col-emit{flex:2; padding:4px;}
    .header .col-danfe{flex:1.3; text-align:center; padding:4px;}
    .header .col-chave{flex:2; padding:4px; font-size:7.5px;}
    .header .col-danfe .titDanfe{font-size:14px; font-weight:bold; margin-top:2px;}
    .header .col-danfe .subDanfe{font-size:7px; margin-bottom:4px;}
    .header .col-danfe .tipoBox{display:inline-block; border:1px solid #000; width:16px; height:16px; line-height:16px; font-weight:bold; margin-top:2px;}
    .header .col-emit .nomeEmit{font-size:12px; font-weight:bold;}
    .header .col-chave b{font-size:6.5px; text-transform:uppercase; color:#333; font-weight:normal; display:block;}
    .header .col-chave .chaveTxt{font-family:'Courier New',monospace; font-size:9.5px; letter-spacing:0.5px; margin:2px 0 4px;}
    svg#barcode{margin-top:2px;}
    .campo6{grid-template-columns:repeat(6,1fr);}
    .campo4{grid-template-columns:repeat(4,1fr);}
    .campo3{grid-template-columns:repeat(3,1fr);}
    .campo2{grid-template-columns:repeat(2,1fr);}
    .aviso{background:#fff8e1; border:1px solid #e0c060; padding:6px 10px; font-size:9px; margin-bottom:6px;}
    .infAdic{font-size:7.5px; padding:4px; min-height:22mm;}
  </style></head><body>
    ${d.resumo ? `<div class="aviso">A Sefaz disponibilizou só o resumo deste documento (sem itens detalhados) — é o que estava disponível na distribuição. O DANFE completo abaixo mostra só os dados do cabeçalho.</div>` : ""}

    <div class="quadro canhoto">
      <div class="linha">
        <div>RECEBEMOS DE ${esc(d.emitente.nome || "-")} OS PRODUTOS/SERVIÇOS CONSTANTES DA NOTA FISCAL INDICADA AO LADO</div>
        <div><span class="nfeLabel">NF-e</span><small>Nº ${esc(d.numero || "-")}&nbsp;&nbsp;SÉRIE ${esc(d.serie || "-")}</small></div>
      </div>
      <div class="linha" style="border-top:1px solid #000;">
        <div style="flex:1;">DATA DE RECEBIMENTO</div>
        <div style="flex:2; border-right:none;">IDENTIFICAÇÃO E ASSINATURA DO RECEBEDOR</div>
      </div>
    </div>

    <div class="quadro mb header linha" style="align-items:stretch;">
      <div class="col-emit">
        <div class="nomeEmit">${esc(d.emitente.nome || "-")}</div>
        <div>${esc(enderecoLinha1(emitEnd))}</div>
        <div>${esc([emitEnd.bairro, emitEnd.municipio, emitEnd.uf].filter(Boolean).join(" - "))} ${emitEnd.cep ? "CEP: " + esc(fmtCep(emitEnd.cep)) : ""}</div>
        ${emitEnd.fone ? `<div>Fone: ${esc(emitEnd.fone)}</div>` : ""}
      </div>
      <div class="col-danfe">
        <div class="titDanfe">DANFE</div>
        <div class="subDanfe">Documento Auxiliar da Nota Fiscal Eletrônica</div>
        <div style="font-size:7px;">${d.tipoOperacao === "0" ? "0-ENTRADA" : "1-SAÍDA"} <span class="tipoBox">${esc(d.tipoOperacao || "1")}</span></div>
        <div style="margin-top:4px; font-size:9px;">Nº ${esc(d.numero || "-")}</div>
        <div style="font-size:9px;">SÉRIE ${esc(d.serie || "-")}</div>
        <div style="font-size:7px; margin-top:2px;">FOLHA 1/1</div>
      </div>
      <div class="col-chave">
        <b>Chave de acesso</b>
        <div class="chaveTxt">${esc(fmtChave(d.chaveAcesso))}</div>
        <svg id="barcode"></svg>
        <div style="font-size:7px; margin-top:4px;">Consulta de autenticidade no portal nacional da NF-e www.nfe.fazenda.gov.br/portal ou no site da Sefaz autorizadora</div>
        ${protocolo ? `<b style="margin-top:4px;">Protocolo de autorização de uso</b><span style="font-size:8.5px;">${esc(protocolo)}</span>` : ""}
      </div>
    </div>

    <div class="quadro mb campo" style="display:block;">
      <b>Natureza da operação</b><span>${esc(d.naturezaOperacao || "-")}</span>
    </div>

    <div class="quadro mb grid campo3">
      ${campo("Inscrição estadual", d.emitente.ie || "")}
      ${campo("Insc. estadual do subst. tributário", d.emitente.ieSt || "")}
      ${campo("CNPJ/CPF", fmtDoc(d.emitente.documento))}
    </div>

    <div class="quadro mb">
      <div class="titulo-secao">Destinatário/Remetente</div>
      <div class="grid campo3">
        ${campo("Nome/Razão social", d.destinatario.nome || "-", { span: 2 })}
        ${campo("CNPJ/CPF", fmtDoc(d.destinatario.documento))}
      </div>
      <div class="grid campo4" style="border-top:1px solid #000;">
        ${campo("Endereço", enderecoLinha1(destEnd), { span: 2 })}
        ${campo("Bairro/Distrito", destEnd.bairro || "")}
        ${campo("CEP", fmtCep(destEnd.cep))}
      </div>
      <div class="grid campo4" style="border-top:1px solid #000;">
        ${campo("Município", destEnd.municipio || "")}
        ${campo("Fone/Fax", destEnd.fone || "")}
        ${campo("UF", destEnd.uf || "")}
        ${campo("Inscrição estadual", d.destinatario.ie || "")}
      </div>
      <div class="grid campo3" style="border-top:1px solid #000;">
        ${campo("Data da emissão", dataEmissao.data)}
        ${campo("Data da entrada/saída", dataSaida.data)}
        ${campo("Hora da entrada/saída", dataSaida.hora)}
      </div>
    </div>

    ${d.fatura.parcelas.length ? `
    <div class="quadro mb">
      <div class="titulo-secao">Fatura/Duplicata</div>
      <div style="padding:3px 4px; font-size:8px;">${linhasParcelas}</div>
    </div>` : ""}

    <div class="quadro mb">
      <div class="titulo-secao">Cálculo do imposto</div>
      <div class="grid campo4">
        ${campo("Base de cálculo do ICMS", fmtMoney(d.totais.bcIcms))}
        ${campo("Valor do ICMS", fmtMoney(d.totais.icms))}
        ${campo("Base de cálculo do ICMS ST", fmtMoney(d.totais.bcIcmsSt))}
        ${campo("Valor do ICMS ST", fmtMoney(d.totais.icmsSt))}
      </div>
      <div class="grid campo4" style="border-top:1px solid #000;">
        ${campo("Valor do ICMS desoneração", fmtMoney(d.totais.icmsDesoneracao))}
        ${campo("Valor total dos produtos", fmtMoney(d.totais.produtos))}
        ${campo("Valor do frete", fmtMoney(d.totais.frete))}
        ${campo("Valor do seguro", fmtMoney(d.totais.seguro))}
      </div>
      <div class="grid campo4" style="border-top:1px solid #000;">
        ${campo("Desconto", fmtMoney(d.totais.desconto))}
        ${campo("Outras despesas acessórias", fmtMoney(d.totais.outrasDespesas))}
        ${campo("Valor do IPI", fmtMoney(d.totais.ipi))}
        ${campo("Valor total da nota", fmtMoney(valorTotalNota), { destaque: true })}
      </div>
    </div>

    <div class="quadro mb">
      <div class="titulo-secao">Transportador/Volumes transportados</div>
      <div class="grid campo4">
        ${campo("Razão social", d.transportador.nome || "", { span: 2 })}
        ${campo("Frete por conta", d.transportador.modalidadeFrete != null ? FRETE_LABEL[d.transportador.modalidadeFrete] || d.transportador.modalidadeFrete : "")}
        ${campo("CNPJ/CPF", fmtDoc(d.transportador.documento))}
      </div>
      <div class="grid campo4" style="border-top:1px solid #000;">
        ${campo("Endereço", d.transportador.endereco || "")}
        ${campo("Município", d.transportador.municipio || "")}
        ${campo("UF", d.transportador.uf || "")}
        ${campo("Inscrição estadual", d.transportador.ie || "")}
      </div>
      <div class="grid campo4" style="border-top:1px solid #000;">
        ${campo("Placa do veículo", d.transportador.veiculoPlaca || "")}
        ${campo("UF", d.transportador.veiculoUf || "")}
        ${campo("Código ANTT", d.transportador.veiculoAntt || "")}
        ${campo("Quantidade/Espécie", vol ? `${vol.quantidade || ""} ${vol.especie || ""}` : "")}
      </div>
      <div class="grid campo4" style="border-top:1px solid #000;">
        ${campo("Marca", vol?.marca || "")}
        ${campo("Numeração", vol?.numeracao || "")}
        ${campo("Peso bruto", vol?.pesoBruto || "")}
        ${campo("Peso líquido", vol?.pesoLiquido || "")}
      </div>
    </div>

    ${d.itens.length ? `
    <div class="quadro mb">
      <div class="titulo-secao">Dados dos produtos/serviços</div>
      <table class="itens">
        <thead><tr>
          <th>Código</th><th>Descrição</th><th>NCM/SH</th><th>CST</th><th>CFOP</th><th>Un.</th>
          <th>Quant.</th><th>Vlr. unit.</th><th>Vlr. total</th><th>BC ICMS</th><th>Vlr. ICMS</th><th>Vlr. IPI</th><th>Alíq. ICMS</th>
        </tr></thead>
        <tbody>${linhasItens}</tbody>
      </table>
    </div>` : ""}

    ${d.issqn ? `
    <div class="quadro mb">
      <div class="titulo-secao">Cálculo do ISSQN</div>
      <div class="grid campo4">
        ${campo("Inscrição municipal", d.issqn.inscricaoMunicipal || "")}
        ${campo("Valor total dos serviços", fmtMoney(d.issqn.valorServicos))}
        ${campo("Base de cálculo do ISSQN", fmtMoney(d.issqn.bcIssqn))}
        ${campo("Valor do ISSQN", fmtMoney(d.issqn.valorIssqn))}
      </div>
    </div>` : ""}

    ${d.informacoesComplementares || d.informacoesFisco ? `
    <div class="quadro linha">
      <div style="flex:2;">
        <div class="titulo-secao">Dados adicionais — informações complementares</div>
        <div class="infAdic">${esc(d.informacoesComplementares || "")}</div>
      </div>
      <div style="flex:1;">
        <div class="titulo-secao">Reservado ao fisco</div>
        <div class="infAdic">${esc(d.informacoesFisco || "")}</div>
      </div>
    </div>` : ""}

    <script>${fs.readFileSync(require.resolve("jsbarcode/dist/JsBarcode.all.min.js"), "utf8")}</script>
    <script>
      try {
        JsBarcode("#barcode", ${JSON.stringify(String(d.chaveAcesso || "").replace(/\D/g, ""))}, {
          format: "CODE128C", width: 1.4, height: 34, displayValue: false, margin: 0,
        });
      } catch (e) { /* chave ausente/inválida — deixa o espaço em branco em vez de quebrar o PDF inteiro */ }
    </script>
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
    const pdf = await page.pdf({ format: "A4", printBackground: true, margin: { top: "8mm", bottom: "8mm", left: "8mm", right: "8mm" } });
    return pdf as Buffer;
  } finally {
    await browser.close();
  }
}
