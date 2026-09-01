import https from "https";
import zlib from "zlib";
import { XMLParser } from "fast-xml-parser";
import * as nfse from "./nfse";

/**
 * Busca automática de NF-e/NFC-e destinadas a uma empresa (webservice nacional de Distribuição de
 * DF-e da Sefaz — NFeDistribuicaoDFe), usando o certificado digital da própria empresa.
 *
 * Baseado na documentação oficial (Manual de Orientação ao Contribuinte — NF-e/NFC-e, Nota Técnica
 * 2014.002) e conferido contra uma implementação real de referência (node-mde, MIT) pra garantir que
 * o envelope SOAP e o formato de resposta batem com o que a Sefaz realmente espera — mesmo cuidado
 * tomado com nfse.ts antes de bater no ambiente real. AINDA NÃO TESTADO contra o webservice real
 * (precisa de um CNPJ com certificado válido e notas de verdade pra confirmar o primeiro uso).
 *
 * Reaproveita a leitura/cifra de certificado .pfx já validada em nfse.ts — não duplica essa lógica.
 */

const DISTRIBUICAO_URL = {
  producao: "https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx",
  homologacao: "https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx",
} as const;
export type AmbienteNfe = keyof typeof DISTRIBUICAO_URL;

// Código IBGE de 2 dígitos de cada UF — cUFAutor da requisição (Nota Técnica 2014.002, tabela do
// Manual de Orientação ao Contribuinte). Referência estável, não muda.
export const UF_CODIGO_IBGE: Record<string, string> = {
  RO: "11", AC: "12", AM: "13", RR: "14", PA: "15", AP: "16", TO: "17",
  MA: "21", PI: "22", CE: "23", RN: "24", PB: "25", PE: "26", AL: "27", SE: "28", BA: "29",
  MG: "31", ES: "32", RJ: "33", SP: "35",
  PR: "41", SC: "42", RS: "43",
  MS: "50", MT: "51", GO: "52", DF: "53",
};

const xmlParser = new XMLParser({
  attributeNamePrefix: "@_",
  textNodeName: "value",
  ignoreAttributes: false,
  allowBooleanAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

function unzipBase64(str: string): Promise<string> {
  return new Promise((resolve, reject) => {
    zlib.unzip(Buffer.from(str, "base64"), (err, buf) => {
      if (err) reject(err);
      else resolve(buf.toString("utf8"));
    });
  });
}

function chamarDistribuicao(ambiente: AmbienteNfe, xmlBody: string, cert: nfse.CertificadoInfo): Promise<{ status: number; corpo: string }> {
  const envelope = `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>${xmlBody}</soap12:Body></soap12:Envelope>`;
  return new Promise((resolve, reject) => {
    const url = new URL(DISTRIBUICAO_URL[ambiente]);
    const bodyBuffer = Buffer.from(envelope, "utf8");
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: "POST",
        cert: cert.certPem,
        key: cert.privateKeyPem,
        rejectUnauthorized: true,
        headers: {
          "Content-Type": "application/soap+xml; charset=utf-8",
          "Content-Length": String(bodyBuffer.length),
        },
        timeout: 30000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode || 0, corpo: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("Tempo esgotado ao conectar na Sefaz.")));
    req.on("error", (e) => reject(e));
    req.write(bodyBuffer);
    req.end();
  });
}

export interface DocumentoDistribuido {
  nsu: string;
  schema: string; // ex.: "resNFe_v1.01.xsd", "procNFe_v4.00.xsd", "resEvento_v1.01.xsd"
  xml: string; // XML já descompactado (resumo ou completo, depende do schema)
}
export interface RespostaDistribuicao {
  cStat: string;
  xMotivo: string;
  ultNSU: string;
  maxNSU: string;
  documentos: DocumentoDistribuido[];
}
function montarConsultaDistDFeInt(params: {
  ambiente: AmbienteNfe;
  cnpj: string;
  cUFAutor: string;
  modo: { tipo: "ultNSU"; valor: string } | { tipo: "NSU"; valor: string } | { tipo: "chNFe"; valor: string };
}): string {
  const tpAmb = params.ambiente === "producao" ? "1" : "2";
  const documentoLimpo = params.cnpj.replace(/\D/g, "");
  // O schema oficial do distDFeInt aceita CNPJ (14 dígitos) OU CPF (11 dígitos), nunca os dois —
  // mandar um documento de 11 dígitos dentro de <CNPJ> é rejeitado na validação de schema (cStat
  // 215, "Falha no esquema xml"), confirmado em teste real com o certificado de um cliente pessoa
  // física (e-CPF).
  const tagDocumento = documentoLimpo.length === 11 ? `<CPF>${documentoLimpo}</CPF>` : `<CNPJ>${documentoLimpo}</CNPJ>`;
  let consultaTag: string;
  if (params.modo.tipo === "ultNSU") {
    consultaTag = `<distNSU><ultNSU>${params.modo.valor.padStart(15, "0")}</ultNSU></distNSU>`;
  } else if (params.modo.tipo === "NSU") {
    consultaTag = `<consNSU><NSU>${params.modo.valor.padStart(15, "0")}</NSU></consNSU>`;
  } else {
    consultaTag = `<consChNFe><chNFe>${params.modo.valor}</chNFe></consChNFe>`;
  }
  const distDFeInt =
    `<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">` +
    `<tpAmb>${tpAmb}</tpAmb><cUFAutor>${params.cUFAutor}</cUFAutor>${tagDocumento}${consultaTag}</distDFeInt>`;
  return `<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDadosMsg>${distDFeInt}</nfeDadosMsg></nfeDistDFeInteresse>`;
}
async function consultarDistribuicao(params: {
  ambiente: AmbienteNfe;
  cnpj: string;
  cUFAutor: string;
  cert: nfse.CertificadoInfo;
  modo: { tipo: "ultNSU"; valor: string } | { tipo: "NSU"; valor: string } | { tipo: "chNFe"; valor: string };
}): Promise<RespostaDistribuicao> {
  const xmlBody = montarConsultaDistDFeInt(params);
  const { status, corpo } = await chamarDistribuicao(params.ambiente, xmlBody, params.cert);
  if (status !== 200) {
    throw new Error(`A Sefaz recusou a conexão (HTTP ${status}) — confira se o certificado está correto e a UF autora bate com o CNPJ.`);
  }
  const json = xmlParser.parse(corpo) as any;
  const retDistDFeInt =
    json?.["soap:Envelope"]?.["soap:Body"]?.nfeDistDFeInteresseResponse?.nfeDistDFeInteresseResult?.retDistDFeInt;
  if (!retDistDFeInt) {
    throw new Error("Resposta da Sefaz em formato inesperado — não encontrei o bloco retDistDFeInt.");
  }
  if (retDistDFeInt.cStat !== "138") {
    // 138 = "Documento localizado" (sucesso, mesmo se vier lista vazia de novos documentos).
    // Outros códigos comuns: 137 (nenhum documento localizado — não é erro), 656 (consumo indevido/rate limit).
    if (retDistDFeInt.cStat === "137") {
      return { cStat: retDistDFeInt.cStat, xMotivo: retDistDFeInt.xMotivo, ultNSU: retDistDFeInt.ultNSU || "", maxNSU: retDistDFeInt.maxNSU || "", documentos: [] };
    }
    throw new Error(`Sefaz: ${retDistDFeInt.xMotivo || "erro desconhecido"} (cStat ${retDistDFeInt.cStat}).`);
  }
  let docZipList = retDistDFeInt.loteDistDFeInt?.docZip;
  if (!docZipList) docZipList = [];
  else if (!Array.isArray(docZipList)) docZipList = [docZipList];
  const documentos: DocumentoDistribuido[] = await Promise.all(
    docZipList.map(async (doc: any) => ({
      nsu: doc["@_NSU"],
      schema: doc["@_schema"],
      xml: await unzipBase64(doc.value),
    }))
  );
  return { cStat: retDistDFeInt.cStat, xMotivo: retDistDFeInt.xMotivo, ultNSU: retDistDFeInt.ultNSU || "", maxNSU: retDistDFeInt.maxNSU || "", documentos };
}
// Busca incremental — chamada mais comum: "me manda tudo que eu ainda não vi". A Sefaz devolve em
// lotes de até 50 documentos; se maxNSU > ultNSU ainda tem mais, chame de novo com o novo ultNSU.
export function consultarNovosDocumentos(params: { ambiente: AmbienteNfe; cnpj: string; cUFAutor: string; cert: nfse.CertificadoInfo; ultimoNsuConhecido: string }): Promise<RespostaDistribuicao> {
  return consultarDistribuicao({ ...params, modo: { tipo: "ultNSU", valor: params.ultimoNsuConhecido } });
}
export function consultarPorChave(params: { ambiente: AmbienteNfe; cnpj: string; cUFAutor: string; cert: nfse.CertificadoInfo; chave: string }): Promise<RespostaDistribuicao> {
  return consultarDistribuicao({ ...params, modo: { tipo: "chNFe", valor: params.chave } });
}

// ===================== Extração dos campos principais de cada documento retornado =====================
export interface DocumentoIdentificado {
  tipo: "nfe" | "nfce" | "cte" | "evento" | "outro";
  chaveAcesso: string | null;
  emitenteCnpj: string | null;
  emitenteNome: string | null;
  destinatarioCnpj: string | null;
  destinatarioNome: string | null;
  valorTotal: number | null;
  dataEmissao: string | null; // ISO
}
// O "schema" que a Sefaz devolve em cada docZip diz o tipo de conteúdo — resNFe/resNFCe são só um
// resumo (sem todos os campos, ex. sem itens), procNFe/procCTe já vêm com o XML completo assinado.
export function identificarDocumento(xml: string, schema: string): DocumentoIdentificado {
  const json = xmlParser.parse(xml) as any;
  const base: DocumentoIdentificado = {
    tipo: "outro",
    chaveAcesso: null,
    emitenteCnpj: null,
    emitenteNome: null,
    destinatarioCnpj: null,
    destinatarioNome: null,
    valorTotal: null,
    dataEmissao: null,
  };
  if (schema.startsWith("resEvento")) {
    const r = json?.resEvento;
    if (!r) return base;
    return { ...base, tipo: "evento", chaveAcesso: r.chNFe || null, dataEmissao: r.dhEvento || null };
  }
  if (schema.startsWith("resNFe")) {
    const r = json?.resNFe;
    if (!r) return base;
    return {
      ...base,
      tipo: "nfe",
      chaveAcesso: r.chNFe || null,
      emitenteCnpj: r.CNPJ || null,
      emitenteNome: r.xNome || null,
      valorTotal: r.vNF != null ? Number(r.vNF) : null,
      dataEmissao: r.dhEmi || null,
    };
  }
  // resCTe (resumo do CT-e, mesma família de schema do resNFe — só não confirmado ainda contra um
  // CT-e real, já que nenhuma empresa cadastrada até agora recebeu um pela Distribuição DFe).
  if (schema.startsWith("resCTe")) {
    const r = json?.resCTe;
    if (!r) return base;
    return {
      ...base,
      tipo: "cte",
      chaveAcesso: r.chCTe || null,
      emitenteCnpj: r.CNPJ || null,
      emitenteNome: r.xNome || null,
      valorTotal: r.vCT != null ? Number(r.vCT) : null,
      dataEmissao: r.dhEmi || null,
    };
  }
  // cteProc (completo, assinado) — vem envelopado em cteProc > CTe > infCte, estrutura paralela ao
  // nfeProc. CT-e não tem um "dest" único e simples como a NF-e (o tomador do serviço pode ser
  // remetente/expedidor/recebedor/destinatário, indicado em ide.toma) — usamos o bloco <dest> quando
  // presente, que na prática é o mais comum de aparecer preenchido.
  const infCte = json?.cteProc?.CTe?.infCte;
  if (infCte) {
    const emit = infCte.emit || {};
    const dest = infCte.dest || {};
    const vPrest = infCte.vPrest || {};
    return {
      ...base,
      tipo: "cte",
      chaveAcesso: (infCte["@_Id"] || "").replace(/^CTe/, "") || null,
      emitenteCnpj: emit.CNPJ || null,
      emitenteNome: emit.xNome || null,
      destinatarioCnpj: dest.CNPJ || dest.CPF || null,
      destinatarioNome: dest.xNome || null,
      valorTotal: vPrest.vTPrest != null ? Number(vPrest.vTPrest) : null,
      dataEmissao: infCte.ide?.dhEmi || null,
    };
  }
  // procNFe (completo, assinado) — vem envelopado em nfeProc > NFe > infNFe.
  const infNFe = json?.nfeProc?.NFe?.infNFe;
  if (infNFe) {
    const emit = infNFe.emit || {};
    const dest = infNFe.dest || {};
    const total = infNFe.total?.ICMSTot || {};
    const modelo = infNFe.ide?.mod; // 55 = NF-e, 65 = NFC-e
    return {
      tipo: modelo === "65" ? "nfce" : "nfe",
      chaveAcesso: (infNFe["@_Id"] || "").replace(/^NFe/, "") || null,
      emitenteCnpj: emit.CNPJ || null,
      emitenteNome: emit.xNome || null,
      destinatarioCnpj: dest.CNPJ || dest.CPF || null,
      destinatarioNome: dest.xNome || null,
      valorTotal: total.vNF != null ? Number(total.vNF) : null,
      dataEmissao: infNFe.ide?.dhEmi || null,
    };
  }
  return base;
}
