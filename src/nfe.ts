import https from "https";
import zlib from "zlib";
import { XMLParser } from "fast-xml-parser";
import { SignedXml } from "xml-crypto";
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

// CT-e tem um web service de Distribuição DFe PRÓPRIO, separado do de NF-e (Nota Técnica 2015.002,
// CTeDistribuicaoDFe — host cte.fazenda.gov.br, não nfe.fazenda.gov.br). É a causa real de CT-e
// tomado nunca aparecer: o sistema só chamava NFeDistribuicaoDFe, que NUNCA devolve CT-e — mesmo o
// CNPJ sendo o tomador de verdade (confirmado na NT: tomador tem direito ao CT-e, evento de
// cancelamento, carta de correção etc., igual destinatário). Mesma família de schema (distDFeInt/
// retDistDFeInt, mesmos cStat 137/138/656), só muda a tag raiz do envelope (cteDistDFeInteresse/
// cteDadosMsg em vez de nfeDistDFeInteresse/nfeDadosMsg), o host, e o xmlns+versao do distDFeInt
// interno (cte em vez de nfe, versao 1.00).
const CTE_DISTRIBUICAO_URL = {
  producao: "https://www1.cte.fazenda.gov.br/CTeDistribuicaoDFe/CTeDistribuicaoDFe.asmx",
  homologacao: "https://hom1.cte.fazenda.gov.br/CTeDistribuicaoDFe/CTeDistribuicaoDFe.asmx",
} as const;

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

function chamarDistribuicao(servico: "nfe" | "cte", ambiente: AmbienteNfe, xmlBody: string, cert: nfse.CertificadoInfo): Promise<{ status: number; corpo: string }> {
  const envelope = `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>${xmlBody}</soap12:Body></soap12:Envelope>`;
  return new Promise((resolve, reject) => {
    const url = new URL((servico === "cte" ? CTE_DISTRIBUICAO_URL : DISTRIBUICAO_URL)[ambiente]);
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
function montarConsultaDistDFeInt(servico: "nfe" | "cte", params: {
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
  // CT-e usa namespace e versão de schema PRÓPRIOS no distDFeInt (confirmado contra relato real de
  // implementação — usar o namespace de NF-e aqui é rejeitado pela Sefaz do CT-e).
  const distDFeInt =
    servico === "cte"
      ? `<distDFeInt xmlns="http://www.portalfiscal.inf.br/cte" versao="1.00">` +
        `<tpAmb>${tpAmb}</tpAmb><cUFAutor>${params.cUFAutor}</cUFAutor>${tagDocumento}${consultaTag}</distDFeInt>`
      : `<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">` +
        `<tpAmb>${tpAmb}</tpAmb><cUFAutor>${params.cUFAutor}</cUFAutor>${tagDocumento}${consultaTag}</distDFeInt>`;
  return servico === "cte"
    ? `<cteDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/cte/wsdl/CTeDistribuicaoDFe"><cteDadosMsg>${distDFeInt}</cteDadosMsg></cteDistDFeInteresse>`
    : `<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDadosMsg>${distDFeInt}</nfeDadosMsg></nfeDistDFeInteresse>`;
}
async function consultarDistribuicao(servico: "nfe" | "cte", params: {
  ambiente: AmbienteNfe;
  cnpj: string;
  cUFAutor: string;
  cert: nfse.CertificadoInfo;
  modo: { tipo: "ultNSU"; valor: string } | { tipo: "NSU"; valor: string } | { tipo: "chNFe"; valor: string };
}): Promise<RespostaDistribuicao> {
  const xmlBody = montarConsultaDistDFeInt(servico, params);
  const { status, corpo } = await chamarDistribuicao(servico, params.ambiente, xmlBody, params.cert);
  if (status !== 200) {
    throw new Error(`A Sefaz recusou a conexão (HTTP ${status}) — confira se o certificado está correto e a UF autora bate com o CNPJ.`);
  }
  const json = xmlParser.parse(corpo) as any;
  const retDistDFeInt =
    servico === "cte"
      ? json?.["soap:Envelope"]?.["soap:Body"]?.cteDistDFeInteresseResponse?.cteDistDFeInteresseResult?.retDistDFeInt
      : json?.["soap:Envelope"]?.["soap:Body"]?.nfeDistDFeInteresseResponse?.nfeDistDFeInteresseResult?.retDistDFeInt;
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
  return consultarDistribuicao("nfe", { ...params, modo: { tipo: "ultNSU", valor: params.ultimoNsuConhecido } });
}
// Consulta por chave de acesso (consChNFe) — já existia (usada pra buscar UM documento específico). "Ancora"
// onde uma nota conhecida está na sequência de NSU do CNPJ. É o mecanismo que reaproveito pra pegar notas
// EMITIDAS (saída): a Distribuição DFe, pro emitente, muitas vezes só passa a listar a partir de um ponto —
// sem uma referência, um ultNSU=0 nem sempre traz o histórico de vendas inteiro. Achando o NSU de uma venda
// conhecida, dá pra "recuar" o cursor até ali e seguir dali pra frente pela busca incremental normal (que
// passa a trazer entrada E saída, tudo junto, dali em diante).
export function consultarPorChave(params: { ambiente: AmbienteNfe; cnpj: string; cUFAutor: string; cert: nfse.CertificadoInfo; chave: string }): Promise<RespostaDistribuicao> {
  return consultarDistribuicao("nfe", { ...params, modo: { tipo: "chNFe", valor: params.chave } });
}
// CT-e tem NSU próprio, independente do de NF-e, no web service separado CTeDistribuicaoDFe (ver
// comentário em CTE_DISTRIBUICAO_URL). Mesmas duas formas de consulta (incremental / por chave),
// reaproveitando a mesma lógica interna — só muda o "servico" passado pra consultarDistribuicao.
export function consultarNovosDocumentosCte(params: { ambiente: AmbienteNfe; cnpj: string; cUFAutor: string; cert: nfse.CertificadoInfo; ultimoNsuConhecido: string }): Promise<RespostaDistribuicao> {
  return consultarDistribuicao("cte", { ...params, modo: { tipo: "ultNSU", valor: params.ultimoNsuConhecido } });
}
export function consultarPorChaveCte(params: { ambiente: AmbienteNfe; cnpj: string; cUFAutor: string; cert: nfse.CertificadoInfo; chave: string }): Promise<RespostaDistribuicao> {
  return consultarDistribuicao("cte", { ...params, modo: { tipo: "chNFe", valor: params.chave } });
}

// ===================== MDF-e: Distribuição DFe (web service PRÓPRIO, NT 2015.002) =====================
// MDF-e tem um web service de Distribuição DFe à parte (host svrs.rs.gov.br — ambiente nacional único,
// não varia por UF como NF-e), com um envelope SOAP DIFERENTE dos dois acima: tem SOAP Header
// (mdfeCabecMsg com cUF+versaoDados) e o Body NÃO tem wrapper de operação (mdfeDadosMsg vai direto) —
// confirmado na Nota Técnica oficial (lida por completo antes de implementar, para não repetir o
// tentativa-e-erro da manifestação de Ciência). Por isso não reaproveita chamarDistribuicao/
// montarConsultaDistDFeInt (moldados pro formato nfe/cte) — tem as próprias funções, no mesmo espírito.
//
// Sigilo fiscal (ENCAT): a Sefaz mascara as chaves de NF-e/CT-e/MDF-e dentro do grupo de documentos
// originários (infDoc) com 46 noves — então pode não dar pra cruzar automaticamente "esta nota está
// neste MDF-e" por chave; só confirmando com uma captura real.
const MDFE_DISTRIBUICAO_URL = {
  producao: "https://mdfe.svrs.rs.gov.br/WS/MDFeDistribuicaoDFe/MDFeDistribuicaoDFe.asmx",
  homologacao: "https://mdfe-homologacao.svrs.rs.gov.br/WS/MDFeDistribuicaoDFe/MDFeDistribuicaoDFe.asmx",
} as const;
function montarConsultaMdfe(params: {
  ambiente: AmbienteNfe;
  cnpj: string;
  modo: { tipo: "ultNSU"; valor: string } | { tipo: "NSU"; valor: string } | { tipo: "chNFe"; valor: string };
}): string {
  const tpAmb = params.ambiente === "producao" ? "1" : "2";
  const documentoLimpo = params.cnpj.replace(/\D/g, "");
  const tagDocumento = documentoLimpo.length === 11 ? `<CPF>${documentoLimpo}</CPF>` : `<CNPJ>${documentoLimpo}</CNPJ>`;
  const consultaTag =
    params.modo.tipo === "ultNSU"
      ? `<distNSU><ultNSU>${params.modo.valor.padStart(15, "0")}</ultNSU></distNSU>`
      : params.modo.tipo === "NSU"
        ? `<consNSU><NSU>${params.modo.valor.padStart(15, "0")}</NSU></consNSU>`
        : `<consChMDFe><chMDFe>${params.modo.valor}</chMDFe></consChMDFe>`;
  return `<distDFeInt xmlns="http://www.portalfiscal.inf.br/mdfe" versao="1.00"><tpAmb>${tpAmb}</tpAmb>${tagDocumento}${consultaTag}</distDFeInt>`;
}
// mdfe.svrs.rs.gov.br usa certificado TLS emitido pela PRÓPRIA cadeia ICP-Brasil (raiz "Autoridade
// Certificadora Raiz Brasileira v10") — ao contrário de nfe/cte.fazenda.gov.br (cadeia pública comum,
// confiada por padrão), essa raiz não vem nos pacotes de CA confiável do Node/sistema. Confirmado ao
// vivo: a conexão falhava com "unable to get local issuer certificate" até passar essa raiz
// explicitamente. Baixado do repositório oficial do ITI (acraiz.icpbrasil.gov.br) e validado contra a
// cadeia real do servidor antes de embutir aqui.
const ICP_BRASIL_RAIZ_V10 = `-----BEGIN CERTIFICATE-----
MIIGrDCCBJSgAwIBAgIJANLVi0S/gZNCMA0GCSqGSIb3DQEBDQUAMIGYMQswCQYD
VQQGEwJCUjETMBEGA1UECgwKSUNQLUJyYXNpbDE9MDsGA1UECww0SW5zdGl0dXRv
IE5hY2lvbmFsIGRlIFRlY25vbG9naWEgZGEgSW5mb3JtYWNhbyAtIElUSTE1MDMG
A1UEAwwsQXV0b3JpZGFkZSBDZXJ0aWZpY2Fkb3JhIFJhaXogQnJhc2lsZWlyYSB2
MTAwHhcNMTkwNzAxMTkxNTU5WhcNMzIwNzAxMTIwMDU5WjCBmDELMAkGA1UEBhMC
QlIxEzARBgNVBAoMCklDUC1CcmFzaWwxPTA7BgNVBAsMNEluc3RpdHV0byBOYWNp
b25hbCBkZSBUZWNub2xvZ2lhIGRhIEluZm9ybWFjYW8gLSBJVEkxNTAzBgNVBAMM
LEF1dG9yaWRhZGUgQ2VydGlmaWNhZG9yYSBSYWl6IEJyYXNpbGVpcmEgdjEwMIIC
IjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAk3AxKl1ZtP0pNyjChqO7qNkn
+/sClZeqiV/Kd7KnnbkDbI2y3VWcUG7feCE/deIxot6GH6JXncRG794UZl+4doD0
D0/cEwBd4DvrDSZm0RT40xhmYYOTxZDJxv+coTHdmsT5aNmSkktfjzYX4HQHh/7M
em+kTOpT/3E4K6B7KVs9HkOT7nXx5yU1qYbVWqI0qpJM9mOTSFx8C9HiKcHvLCvt
1ioXKPAmFuHPkayOcXP2MXeb+VRNjWKU4E+L2t5uZPKVx1M/9i1DztlLb4K8OfYg
GaPDUSF1sxnoGk5qZHLleO6KjCpmuQepmgsBvxi2YNO7X2YUwQQx1AXNSolgtkAR
5gt+1WzxhbFUhItQqlhqxgWHefLmiT5T/Ctz/P2v+zSO4efkkIzsi1iwD+ypZvM2
lnIvB24RcSN6jzmCahLPX4CwjwIK6JsSoMVxIhpZHCguUP4LXqP8IWUZ6WgS/4zB
7B9E0EICl2rM1PRy+6ulv+ZOW256e8a0pijUB+hXM1msUq9L92476FAAX8va3sP7
+Uut94+bGHmubcTLImWUPrxNT7QyrvE3FyHicfiHioeFL2oV4cXTLZrEq2wS8R4P
KPdSzNn5Z9e2uMEGYQaSNO+OwvVycpIhOBOqrm12wJ9ZhWKtM5UOo34/o37r5ZBI
TYXAGbhqQDB9mWXwH+0CAwEAAaOB9jCB8zBOBgNVHSAERzBFMEMGBWBMAQEAMDow
OAYIKwYBBQUHAgEWLGh0dHA6Ly9hY3JhaXouaWNwYnJhc2lsLmdvdi5ici9EUENh
Y3JhaXoucGRmMEAGA1UdHwQ5MDcwNaAzoDGGL2h0dHA6Ly9hY3JhaXouaWNwYnJh
c2lsLmdvdi5ici9MQ1JhY3JhaXp2MTAuY3JsMB8GA1UdIwQYMBaAFHTzfv/8n1N6
8Xzrqz6kptoYukVjMB0GA1UdDgQWBBR0837//J9TevF866s+pKbaGLpFYzAPBgNV
HRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQ0FAAOCAgEA
eCNhBSuy/Ih/T+1VOtAJju85SrtoE3vET1qXASpmjQllDHG/ph7VFNRAkC+gha+B
CbjoA5oJ/8wwl+Qdp1KGz6nXXFTLx3osU+kjm0srmBf9nyXHPqvFyvBeB0A7sYb7
TmII9GKD20oCxsdkccR/oE/JuTaNnGq0GYZ2aDb5v62uLi21Y6P9UBiTxZqQ4ojW
ET6kXNjlK238jpXv17FR8Sg3VusCvX7Q8eJkavvHHZDeWck2fSA+ycAc2JeL2Z0B
MSxGWpH32WM9J8+6XqCJUXHiWEV0zCE8wDYiYC+047pTxQI/gB/FcU7jvylh98DJ
kQPHd/Tp6Og3ynlDA9n9uBbxYHVRZs9vsZ/7xTFaxRe+zk8dhgKgZ/3RrcMFB570
2t8LFbyuUE/kQVY6rZ0QJ9qMWQ7VPLRwRhiMeU3k8WDJb/tBbOXHBqldTbWyQ+mp
MEDWhbrzE/IED82wAuO23Tb05cYk2xC7+Izef8fSc3XdJDuPSbcDpWukzyCDtSEH
isLiGEtIbYRiPsF3czlQPsnIEVoTTCWxHCH1zYR6zScSv18Qh69qVe2J40K5jZoP
GEOhq/oKhVJQAdvAFW5Odp7mF3Tk9nivjjsctJSxY26LFiV5GRV+07SSse4ti0aO
jO5PLg5SWjfcOtBG2rz02EIvQAmLcb0kGBtfdj0lW/w=
-----END CERTIFICATE-----`;
function chamarMdfe(ambiente: AmbienteNfe, cUF: string, xmlBody: string, cert: nfse.CertificadoInfo): Promise<{ status: number; corpo: string }> {
  const nsWsdl = "http://www.portalfiscal.inf.br/mdfe/wsdl/MDFeDistribuicaoDFe";
  const corpoSoap = `<mdfeDadosMsg xmlns="${nsWsdl}">${xmlBody}</mdfeDadosMsg>`;
  const cabecMsg = `<mdfeCabecMsg xmlns="${nsWsdl}"><cUF>${cUF}</cUF><versaoDados>1.00</versaoDados></mdfeCabecMsg>`;
  const envelope =
    `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">` +
    `<soap12:Header>${cabecMsg}</soap12:Header><soap12:Body>${corpoSoap}</soap12:Body></soap12:Envelope>`;
  return new Promise((resolve, reject) => {
    const url = new URL(MDFE_DISTRIBUICAO_URL[ambiente]);
    const bodyBuffer = Buffer.from(envelope, "utf8");
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: "POST",
        cert: cert.certPem,
        key: cert.privateKeyPem,
        rejectUnauthorized: true,
        ca: ICP_BRASIL_RAIZ_V10,
        headers: { "Content-Type": "application/soap+xml; charset=utf-8", "Content-Length": String(bodyBuffer.length) },
        timeout: 30000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode || 0, corpo: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("Tempo esgotado ao conectar na Sefaz (MDF-e).")));
    req.on("error", (e) => reject(e));
    req.write(bodyBuffer);
    req.end();
  });
}
async function consultarDistribuicaoMdfe(params: {
  ambiente: AmbienteNfe;
  cnpj: string;
  cUF: string;
  cert: nfse.CertificadoInfo;
  modo: { tipo: "ultNSU"; valor: string } | { tipo: "NSU"; valor: string } | { tipo: "chNFe"; valor: string };
}): Promise<RespostaDistribuicao> {
  const xmlBody = montarConsultaMdfe(params);
  const { status, corpo } = await chamarMdfe(params.ambiente, params.cUF, xmlBody, params.cert);
  if (status !== 200) throw new Error(`A Sefaz recusou a conexão (HTTP ${status}) ao consultar MDF-e: ${corpo.slice(0, 800)}`);
  const json = xmlParser.parse(corpo) as any;
  // Mesma cautela da manifestação: o nome da tag que embrulha a resposta no Body pode variar por
  // ambiente — pega o único filho que o Body tiver, em vez de fixar um nome.
  const soapBody = json?.["soap:Envelope"]?.["soap:Body"];
  const bodyContent: any = soapBody ? Object.values(soapBody)[0] : null;
  const retDistDFeInt = bodyContent?.retDistDFeInt;
  if (!retDistDFeInt) throw new Error(`Resposta da Sefaz em formato inesperado ao consultar MDF-e: ${corpo.slice(0, 1000)}`);
  if (retDistDFeInt.cStat !== "138") {
    if (retDistDFeInt.cStat === "137") {
      return { cStat: retDistDFeInt.cStat, xMotivo: retDistDFeInt.xMotivo, ultNSU: retDistDFeInt.ultNSU || "", maxNSU: retDistDFeInt.maxNSU || "", documentos: [] };
    }
    throw new Error(`Sefaz: ${retDistDFeInt.xMotivo || "erro desconhecido"} (cStat ${retDistDFeInt.cStat}).`);
  }
  let docZipList = retDistDFeInt.loteDistDFeInt?.docZip;
  if (!docZipList) docZipList = [];
  else if (!Array.isArray(docZipList)) docZipList = [docZipList];
  const documentos: DocumentoDistribuido[] = await Promise.all(
    docZipList.map(async (doc: any) => ({ nsu: doc["@_NSU"], schema: doc["@_schema"], xml: await unzipBase64(doc.value) }))
  );
  return { cStat: retDistDFeInt.cStat, xMotivo: retDistDFeInt.xMotivo, ultNSU: retDistDFeInt.ultNSU || "", maxNSU: retDistDFeInt.maxNSU || "", documentos };
}
export function consultarNovosDocumentosMdfe(params: { ambiente: AmbienteNfe; cnpj: string; cUF: string; cert: nfse.CertificadoInfo; ultimoNsuConhecido: string }): Promise<RespostaDistribuicao> {
  return consultarDistribuicaoMdfe({ ...params, modo: { tipo: "ultNSU", valor: params.ultimoNsuConhecido } });
}
export function consultarPorChaveMdfe(params: { ambiente: AmbienteNfe; cnpj: string; cUF: string; cert: nfse.CertificadoInfo; chave: string }): Promise<RespostaDistribuicao> {
  return consultarDistribuicaoMdfe({ ...params, modo: { tipo: "chNFe", valor: params.chave } });
}

// ===================== Manifestação do destinatário (Ciência da Operação) =====================
// A Sefaz só libera o XML COMPLETO (nfeProc) pro destinatário depois dele reagir de alguma forma a
// uma NF-e — até lá, a Distribuição DFe só devolve o resumo (resNFe). "Ciência da Operação" (tpEvento
// 210210) é o evento desenhado justamente pra isso: não afirma que a mercadoria foi recebida nem
// confirma nada sobre a operação em si, só reconhece que o CNPJ está ciente que a nota existe — é o
// evento que ferramentas de captura de XML mandam automaticamente. NÃO é "Confirmação da Operação"
// (210200), que é uma afirmação mais forte e não deve sair sozinha.
//
// Mesmo sendo um evento, usa um web service PRÓPRIO (RecepcaoEvento), diferente da Distribuição DFe —
// mas sempre pelo Ambiente Nacional (SVRS, cOrgao 91), independente da UF de quem comprou, igual a
// Distribuição DFe em si (centralizada). Confere com a Nota Técnica 2014.002 (Manifestação do
// Destinatário). AINDA NÃO TESTADO contra o webservice real — mesma ressalva feita no topo do arquivo
// pra Distribuição DFe antes do primeiro uso em produção confirmar o envelope.
// Terceiro teste real: "www.sefazvirtual.fazenda.gov.br" é o ambiente de CONTINGÊNCIA (SVC-AN) — a
// Sefaz rejeitou com cStat 582 "UF não atendida pela SVC-AN" (PA não está em contingência). O endereço
// certo pro Ambiente Nacional "normal" (produção de verdade) é nfe.fazenda.gov.br, sem o "virtual".
const MANIFESTACAO_URL = {
  producao: "https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx",
  homologacao: "https://hom.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx",
} as const;
const CORGAO_AMBIENTE_NACIONAL = "91"; // SVRS — código fixo de órgão pro Ambiente Nacional

function dataHoraBrasiliaNfe(deslocamentoMs = 0): string {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000 + deslocamentoMs);
  return d.toISOString().replace(/\.\d{3}Z$/, "-03:00");
}

// Evento de NF-e assina com SHA1/RSA-SHA1 (perfil clássico de NF-e) — diferente do SHA256 usado na
// DPS do Sistema Nacional NFS-e (nfse.assinarXmlDps), que é um padrão mais novo.
function assinarXmlEventoNfe(xml: string, id: string, cert: nfse.CertificadoInfo): string {
  const sig = new SignedXml({ privateKey: cert.privateKeyPem, publicCert: cert.certPem, getKeyInfoContent: SignedXml.getKeyInfoContent });
  sig.addReference({
    xpath: "//*[local-name(.)='infEvento']",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"],
    digestAlgorithm: "http://www.w3.org/2000/09/xmldsig#sha1",
    uri: `#${id}`,
  });
  sig.signatureAlgorithm = "http://www.w3.org/2000/09/xmldsig#rsa-sha1";
  sig.canonicalizationAlgorithm = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='infEvento']", action: "after" } });
  return sig.getSignedXml();
}

export interface ResultadoManifestacao {
  cStat: string;
  xMotivo: string;
  // 135 (vinculado à NF-e) e 136 (registrado, NF-e ainda não recepcionada pela Sefaz) e 573
  // (duplicidade — já tinha sido mandado antes) contam como aceito; qualquer outro é erro de verdade.
  sucesso: boolean;
  xmlEnviado: string; // evento assinado que foi mandado — fica guardado como registro do que foi feito
  dhEvento: string;
}
export async function enviarManifestacaoCiencia(params: { ambiente: AmbienteNfe; cnpj: string; cUF: string; cert: nfse.CertificadoInfo; chave: string }): Promise<ResultadoManifestacao> {
  const tpAmb = params.ambiente === "producao" ? "1" : "2";
  const cnpjLimpo = params.cnpj.replace(/\D/g, "");
  const dhEvento = dataHoraBrasiliaNfe(-60_000);
  const idEvento = `ID210210${params.chave}01`;
  const infEvento =
    `<infEvento Id="${idEvento}">` +
    `<cOrgao>${CORGAO_AMBIENTE_NACIONAL}</cOrgao><tpAmb>${tpAmb}</tpAmb>` +
    // Pessoa física (CPF, 11 dígitos) usa a tag <CPF>; com <CNPJ> a Sefaz rejeita o lote (cStat 225).
    `${cnpjLimpo.length === 11 ? `<CPF>${cnpjLimpo}</CPF>` : `<CNPJ>${cnpjLimpo}</CNPJ>`}<chNFe>${params.chave}</chNFe><dhEvento>${dhEvento}</dhEvento>` +
    `<tpEvento>210210</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento>` +
    `<detEvento versao="1.00"><descEvento>Ciencia da Operacao</descEvento></detEvento>` +
    `</infEvento>`;
  const eventoXml = `<evento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">${infEvento}</evento>`;
  const eventoAssinado = assinarXmlEventoNfe(eventoXml, idEvento, params.cert);
  const envEvento = `<envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><idLote>1</idLote>${eventoAssinado}</envEvento>`;
  // Achado na pesquisa (2 fontes independentes, depois do primeiro teste real dar cStat 242 "Mensagem
  // SOAP inválida"): RecepcaoEvento4, diferente da Distribuição DFe, NÃO usa wrapper de operação no Body
  // (nfeDadosMsg vai direto) e EXIGE um SOAP Header nfeCabecMsg com cUF + versaoDados — padrão clássico
  // dos web services de NF-e, mesmo em SOAP 1.2.
  const nsWsdl = "http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4";
  const corpoSoap = `<nfeDadosMsg xmlns="${nsWsdl}">${envEvento}</nfeDadosMsg>`;
  const cabecMsg = `<nfeCabecMsg xmlns="${nsWsdl}"><cUF>${params.cUF}</cUF><versaoDados>1.00</versaoDados></nfeCabecMsg>`;
  const envelope =
    `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">` +
    `<soap12:Header>${cabecMsg}</soap12:Header><soap12:Body>${corpoSoap}</soap12:Body></soap12:Envelope>`;
  const url = new URL(MANIFESTACAO_URL[params.ambiente]);
  const bodyBuffer = Buffer.from(envelope, "utf8");
  const { status, corpo } = await new Promise<{ status: number; corpo: string }>((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: "POST",
        cert: params.cert.certPem,
        key: params.cert.privateKeyPem,
        rejectUnauthorized: true,
        // Diferente da Distribuição DFe (que aceita sem), o RecepcaoEvento4 EXIGE o parâmetro "action" no
        // Content-Type do SOAP 1.2 — confirmado ao vivo: sem isso a Sefaz responde HTTP 500 "Unable to
        // handle request without a valid action parameter. Please supply a valid soap action."
        headers: {
          "Content-Type": 'application/soap+xml; charset=utf-8; action="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4/nfeRecepcaoEvento"',
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
  if (status !== 200) throw new Error(`A Sefaz recusou a conexão (HTTP ${status}) ao mandar a manifestação: ${corpo.slice(0, 800)}`);
  const json = xmlParser.parse(corpo) as any;
  // O nome da tag que embrulha a resposta dentro do soap:Body MUDA dependendo do ambiente que atendeu
  // (confirmado ao vivo: "nfeResultMsg" na contingência SVC-AN, "nfeRecepcaoEventoNFResult" no Ambiente
  // Nacional normal) — em vez de apostar num nome fixo, pega o único filho que o Body tiver, seja
  // qual for o nome.
  const soapBody = json?.["soap:Envelope"]?.["soap:Body"];
  const bodyContent: any = soapBody ? Object.values(soapBody)[0] : null;
  const retEnvEvento = bodyContent?.retEnvEvento;
  if (!retEnvEvento) throw new Error(`Resposta da Sefaz em formato inesperado ao mandar a manifestação: ${corpo.slice(0, 1000)}`);
  const infEventoResp = retEnvEvento.retEvento?.infEvento;
  if (!infEventoResp) {
    throw new Error(`Sefaz: ${retEnvEvento.xMotivo || "erro desconhecido"} (cStat ${retEnvEvento.cStat}).`);
  }
  const cStat = String(infEventoResp.cStat || "");
  return { cStat, xMotivo: infEventoResp.xMotivo || "", sucesso: cStat === "135" || cStat === "136" || cStat === "573", xmlEnviado: eventoAssinado, dhEvento };
}

// ===================== Extração dos campos principais de cada documento retornado =====================
export interface DocumentoIdentificado {
  tipo: "nfe" | "nfce" | "cte" | "mdfe" | "evento" | "outro";
  chaveAcesso: string | null;
  emitenteCnpj: string | null;
  emitenteNome: string | null;
  destinatarioCnpj: string | null;
  destinatarioNome: string | null;
  valorTotal: number | null;
  dataEmissao: string | null; // ISO
  eventoDescricao: string | null; // xEvento (só preenchido quando tipo === "evento") — ex.: "Cancelamento", "Registro de Passagem Autorização"
  docsVinculados?: string[] | null; // MDF-e: chaves de NF-e/CT-e no grupo infDoc — a Sefaz pode mascará-las (sigilo fiscal, NT 2015.002)
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
    eventoDescricao: null,
  };
  if (schema.startsWith("resEvento")) {
    const r = json?.resEvento;
    if (!r) return base;
    return { ...base, tipo: "evento", chaveAcesso: r.chNFe || null, dataEmissao: r.dhEvento || null, eventoDescricao: r.xEvento || null };
  }
  // procEventoCTe (cancelamento, carta de correção, comprovante/insucesso de entrega etc.) — evento já
  // assinado e completo, estrutura PRÓPRIA do CT-e (sem resumo resEvento equivalente). A descrição do
  // evento fica dentro de detEvento, mas sob uma tag que MUDA conforme o tipo (evCECTe, evCancCTe,
  // evCCeCTe...) — em vez de listar cada uma, pega o primeiro "descEvento" que aparecer ali dentro.
  if (schema.startsWith("procEventoCTe")) {
    const infEvento = json?.procEventoCTe?.eventoCTe?.infEvento;
    if (!infEvento) return base;
    const detEvento = infEvento.detEvento || {};
    const descEvento = Object.values(detEvento).find((v: any) => v && typeof v === "object" && "descEvento" in v) as any;
    return {
      ...base,
      tipo: "evento",
      chaveAcesso: infEvento.chCTe || null,
      dataEmissao: infEvento.dhEvento || null,
      eventoDescricao: descEvento?.descEvento || null,
    };
  }
  // procEventoMDFe (cancelamento, encerramento, inclusão de condutor) — mesma ideia do procEventoCTe:
  // descEvento fica dentro de detEvento, sob uma tag que muda conforme o tipo.
  if (schema.startsWith("procEventoMDFe")) {
    const infEvento = json?.procEventoMDFe?.eventoMDFe?.infEvento;
    if (!infEvento) return base;
    const detEvento = infEvento.detEvento || {};
    const descEvento = Object.values(detEvento).find((v: any) => v && typeof v === "object" && "descEvento" in v) as any;
    return {
      ...base,
      tipo: "evento",
      chaveAcesso: infEvento.chMDFe || null,
      dataEmissao: infEvento.dhEvento || null,
      eventoDescricao: descEvento?.descEvento || null,
    };
  }
  // resMDFe (resumo, mesma família de schema do resNFe/resCTe).
  if (schema.startsWith("resMDFe")) {
    const r = json?.resMDFe;
    if (!r) return base;
    return {
      ...base,
      tipo: "mdfe",
      chaveAcesso: r.chMDFe || null,
      emitenteCnpj: r.CNPJ || r.CPF || null,
      emitenteNome: r.xNome || null,
      dataEmissao: r.dhEmi || null,
    };
  }
  if (schema.startsWith("resNFe")) {
    const r = json?.resNFe;
    if (!r) return base;
    // Confirmado ao vivo (checando a chave de acesso, que sempre embute o CNPJ real do emitente nas
    // posições 7-20, independente do schema): o campo CNPJ do resNFe já é mesmo o emitente — bate
    // com a chave em ~9 de cada 10 casos reais checados. O que faltava era o fallback pra CPF —
    // quando o emitente é pessoa física (produtor rural etc.), só existe <CPF>, nunca <CNPJ>, e o
    // código só lia CNPJ — resultado: essas notas ficavam com emitente em branco (mas ainda
    // corretamente contadas como "recebida" por padrão, já que CPF nunca bate com o CNPJ da própria
    // empresa — não é bug de direção, só de completude do dado exibido).
    return {
      ...base,
      tipo: "nfe",
      chaveAcesso: r.chNFe || null,
      emitenteCnpj: r.CNPJ || r.CPF || null,
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
  // procMDFe (completo, assinado) — vem envelopado em mdfeProc > MDFe > infMDFe. MDF-e não tem um único
  // "destinatário" (é um manifesto de transporte referenciando várias NF-e/CT-e, uma por município de
  // descarga em infDoc.infMunDescarga) — docsVinculados junta as chaves de NF-e/CT-e encontradas ali,
  // mas a Sefaz pode mascará-las com 46 noves por sigilo fiscal (NT 2015.002) — quem usa esse campo
  // precisa checar isso antes de confiar na chave.
  const infMDFe = json?.mdfeProc?.MDFe?.infMDFe;
  if (infMDFe) {
    const emit = infMDFe.emit || {};
    const tot = infMDFe.tot || {};
    let descargas = infMDFe.infDoc?.infMunDescarga;
    descargas = Array.isArray(descargas) ? descargas : descargas ? [descargas] : [];
    const docsVinculados: string[] = [];
    for (const d of descargas) {
      for (const campo of ["infNFe", "infCTe", "infMDFeTransp"]) {
        let itens = d?.[campo];
        itens = Array.isArray(itens) ? itens : itens ? [itens] : [];
        for (const it of itens) {
          const chave = it?.chNFe || it?.chCTe || it?.chMDFe;
          if (chave) docsVinculados.push(chave);
        }
      }
    }
    return {
      ...base,
      tipo: "mdfe",
      chaveAcesso: (infMDFe["@_Id"] || "").replace(/^MDFe/, "") || null,
      emitenteCnpj: emit.CNPJ || null,
      emitenteNome: emit.xNome || null,
      valorTotal: tot.vCarga != null ? Number(tot.vCarga) : null,
      dataEmissao: infMDFe.ide?.dhEmi || null,
      docsVinculados: docsVinculados.length ? docsVinculados : null,
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
      ...base,
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

// Lê os tributos da reforma (IBS/CBS) do TOTAL da NF-e/NFC-e completa — grupo <total><IBSCBSTot> da
// NT 2025.002. Retorna os valores quando o XML já traz o grupo (fase de transição da reforma); se a
// nota ainda não traz, retorna zeros (parseado, sem reforma). null só se não for uma NF-e completa
// (ex.: resumo/resNFe, evento, CT-e) — aí não dá pra saber e fica "não parseado" pra não travar.
export function extrairIbsCbs(
  xml: string
): { vIBS: number; vCBS: number; vBC: number; vICMS: number; vPIS: number; vCOFINS: number; vIPI: number; flags: string[]; qtdItens: number; crt: number | null } | null {
  let json: any;
  try {
    json = xmlParser.parse(xml);
  } catch {
    return null;
  }
  const infNFe = json?.nfeProc?.NFe?.infNFe || json?.NFe?.infNFe;
  if (!infNFe) return null; // não é NF-e completa (resumo/evento/CT-e) — sem total detalhado
  const num = (v: any) => (v != null && v !== "" ? Number(v) || 0 : 0);
  // Flags (marcadores) — grupos especiais por item + blocos da própria nota (pagamento, duplicatas).
  const dets = Array.isArray(infNFe.det) ? infNFe.det : infNFe.det ? [infNFe.det] : [];
  const qtdItens = dets.length;
  const flags: string[] = [];
  if (dets.some((d: any) => d?.prod?.comb)) flags.push("comb"); // combustível
  if (dets.some((d: any) => d?.prod?.med)) flags.push("med"); // medicamento
  if (dets.some((d: any) => d?.prod?.rastro)) flags.push("rastro"); // rastreável (lote/validade)
  if (dets.some((d: any) => d?.prod?.veicProd)) flags.push("veiculo"); // veículo
  if (dets.some((d: any) => d?.prod?.DI)) flags.push("importado"); // tem Declaração de Importação
  // Substituição tributária: algum item com campo de ST preenchido — o nome do campo muda conforme o
  // CST/CSOSN (vICMSST/pICMSST nos grupos que calculam ST agora: 10/30/70/201/202/203; vICMSSTRet/
  // vBCSTRet nos que só repassam ST retido antes: 60/500) — confirmado ao vivo (achado real tinha
  // vICMSSTRet, não vICMSST). Mais simples procurar a substring em qualquer campo dentro de <ICMS>, em
  // vez de listar cada CST com seu nome de campo específico.
  const temIcmsSt = dets.some((d: any) => {
    const icmsGrupo = d?.imposto?.ICMS;
    if (!icmsGrupo) return false;
    const cst = Object.values(icmsGrupo)[0] as any; // ICMS tem um único filho (ICMS00/10/20/.../500...), nome variável
    return cst && /ICMSST|BCST|MVAST/i.test(Object.keys(cst).join(" "));
  });
  if (temIcmsSt) flags.push("st"); // substituição tributária
  // Pagamento: grupo <pag> com uma ou mais formas (<detPag>). NFC-e sempre tem; NF-e normalmente.
  const pag = infNFe.pag || {};
  const detPag = Array.isArray(pag.detPag) ? pag.detPag : pag.detPag ? [pag.detPag] : [];
  if (detPag.length) flags.push("pag");
  // Duplicatas (parcelas): grupo <cobr><dup>.
  const dup = infNFe.cobr?.dup;
  const dups = Array.isArray(dup) ? dup : dup ? [dup] : [];
  if (dups.length) flags.push("dup");
  const tot = infNFe.total || {};
  const icms = tot.ICMSTot || {};
  const vICMS = num(icms.vICMS),
    vPIS = num(icms.vPIS),
    vCOFINS = num(icms.vCOFINS),
    vIPI = num(icms.vIPI);
  const ibscbs = tot.IBSCBSTot;
  let vIBS = 0,
    vCBS = 0,
    vBC = 0;
  if (ibscbs) {
    const gIBS = ibscbs.gIBS || {};
    vIBS = num(gIBS.vIBS) || num(gIBS.gIBSUF?.vIBSUF) + num(gIBS.gIBSMun?.vIBSMun);
    vCBS = num(ibscbs.gCBS?.vCBS);
    vBC = num(ibscbs.vBCIBSCBS);
  }
  // CRT do emitente (1=Simples Nacional, 2=SN excesso de sublimite, 3=Regime Normal) — mostrado como
  // selo "SN"/"RN" do lado do nome do emitente na listagem, estilo Espião.
  const crt = infNFe.emit?.CRT != null ? Number(infNFe.emit.CRT) : null;
  return { vIBS, vCBS, vBC, vICMS, vPIS, vCOFINS, vIPI, flags, qtdItens, crt };
}

// Resumo de um MDF-e completo (pro popup "Transportadora" — flag 🚚 estilo Espião, clicada a partir de
// uma NF-e/CT-e vinculada). null se não for MDF-e completo (resumo/evento).
export function resumoMdfe(xml: string): { numero: string | null; serie: string | null; uf: string | null; chave: string | null; emitenteNome: string | null; dataEmissao: string | null } | null {
  let json: any;
  try {
    json = xmlParser.parse(xml);
  } catch {
    return null;
  }
  const infMDFe = json?.mdfeProc?.MDFe?.infMDFe;
  if (!infMDFe) return null;
  const ide = infMDFe.ide || {};
  return {
    numero: ide.nMDF || null,
    serie: ide.serie || null,
    uf: ide.UFIni && ide.UFFim ? `${ide.UFIni} → ${ide.UFFim}` : null,
    chave: (infMDFe["@_Id"] || "").replace(/^MDFe/, "") || null,
    emitenteNome: infMDFe.emit?.xNome || null,
    dataEmissao: ide.dhEmi || null,
  };
}
// Detalhe completo da NF-e/NFC-e (pro painel de detalhe): cabeçalho, participantes, itens e totais
// de impostos (ICMS/PIS/COFINS/IPI + IBS/CBS da reforma). null se não for NF-e completa (resumo/
// evento/CT-e/NFS-e) — aí o painel mostra só a aba XML.
export function detalharNfe(xml: string): any | null {
  let json: any;
  try {
    json = xmlParser.parse(xml);
  } catch {
    return null;
  }
  const infNFe = json?.nfeProc?.NFe?.infNFe || json?.NFe?.infNFe;
  if (!infNFe) return null;
  const num = (v: any) => (v != null && v !== "" ? Number(v) || 0 : 0);
  const ide = infNFe.ide || {};
  const emit = infNFe.emit || {};
  const dest = infNFe.dest || {};
  const transp = infNFe.transp || {};
  const transporta = transp.transporta || {};
  const tot = infNFe.total || {};
  const icms = tot.ICMSTot || {};
  const ibscbs = tot.IBSCBSTot || {};
  const gIBS = ibscbs.gIBS || {};
  const dets = Array.isArray(infNFe.det) ? infNFe.det : infNFe.det ? [infNFe.det] : [];
  const itens = dets.map((d: any) => {
    const p = d.prod || {};
    return {
      n: String(d["@_nItem"] || ""),
      cProd: p.cProd || null,
      xProd: p.xProd || null,
      ncm: p.NCM || null,
      cfop: p.CFOP || null,
      un: p.uCom || null,
      qtd: num(p.qCom),
      vUnit: num(p.vUnCom),
      vProd: num(p.vProd),
    };
  });
  const vIBS = num(gIBS.vIBS) || num(gIBS.gIBSUF?.vIBSUF) + num(gIBS.gIBSMun?.vIBSMun);
  const vCBS = num(ibscbs.gCBS?.vCBS);
  return {
    tipo: ide.mod === "65" ? "nfce" : "nfe",
    chaveAcesso: (infNFe["@_Id"] || "").replace(/^NFe/, "") || null,
    natOp: ide.natOp || null,
    tpNF: ide.tpNF || null, // 0 = entrada, 1 = saída
    dataEmissao: ide.dhEmi || null,
    emit: { doc: emit.CNPJ || emit.CPF || null, nome: emit.xNome || null, fantasia: emit.xFant || null, crt: emit.CRT || null, uf: emit.enderEmit?.UF || null, municipio: emit.enderEmit?.xMun || null },
    dest: { doc: dest.CNPJ || dest.CPF || null, nome: dest.xNome || null, uf: dest.enderDest?.UF || null },
    transp: { doc: transporta.CNPJ || transporta.CPF || null, nome: transporta.xNome || null, modFrete: transp.modFrete || null },
    itens,
    totais: {
      vProd: num(icms.vProd),
      vNF: num(icms.vNF),
      vFrete: num(icms.vFrete),
      vDesc: num(icms.vDesc),
      vBCICMS: num(icms.vBC),
      vICMS: num(icms.vICMS),
      vPIS: num(icms.vPIS),
      vCOFINS: num(icms.vCOFINS),
      vIPI: num(icms.vIPI),
      vIBS,
      vCBS,
      vBCIBSCBS: num(ibscbs.vBCIBSCBS),
    },
    temReforma: !!tot.IBSCBSTot || vIBS > 0 || vCBS > 0,
    pagamentos: detalharNfePagamentos(infNFe),
    duplicatas: detalharNfeDuplicatas(infNFe),
    observacoes: detalharNfeObservacoes(infNFe, dets),
    referencias: detalharNfeReferencias(ide),
    especiais: detalharNfeEspeciais(dets),
    rastro: detalharNfeRastro(dets),
  };
}
const NFE_TPAG_LABEL: Record<string, string> = {
  "01": "Dinheiro", "02": "Cheque", "03": "Cartão de Crédito", "04": "Cartão de Débito", "05": "Crédito Loja",
  "10": "Vale Alimentação", "11": "Vale Refeição", "12": "Vale Presente", "13": "Vale Combustível",
  "14": "Duplicata Mercantil", "15": "Boleto Bancário", "16": "Depósito Bancário", "17": "PIX",
  "18": "Transferência bancária/Carteira Digital", "19": "Programa de fidelidade/Cashback", "90": "Sem pagamento", "99": "Outros",
};
function detalharNfePagamentos(infNFe: any): { indPag: string | null; tipo: string; vPag: number; cartao: { bandeira: string | null; autorizacao: string | null } | null }[] {
  const num = (v: any) => (v != null && v !== "" ? Number(v) || 0 : 0);
  const pag = infNFe.pag || {};
  const lista = Array.isArray(pag.detPag) ? pag.detPag : pag.detPag ? [pag.detPag] : [];
  return lista.map((p: any) => ({
    indPag: p.indPag != null ? String(p.indPag) : null,
    tipo: NFE_TPAG_LABEL[String(p.tPag)] || `Código ${p.tPag}`,
    vPag: num(p.vPag),
    cartao: p.card ? { bandeira: p.card.tBand || null, autorizacao: p.card.cAut || null } : null,
  }));
}
function detalharNfeDuplicatas(infNFe: any): { fatura: { nFat: string | null; vOrig: number; vDesc: number; vLiq: number } | null; parcelas: { nDup: string | null; dVenc: string | null; vDup: number }[] } {
  const num = (v: any) => (v != null && v !== "" ? Number(v) || 0 : 0);
  const cobr = infNFe.cobr || {};
  const fat = cobr.fat;
  const dup = cobr.dup;
  const parcelas = Array.isArray(dup) ? dup : dup ? [dup] : [];
  return {
    fatura: fat ? { nFat: fat.nFat || null, vOrig: num(fat.vOrig), vDesc: num(fat.vDesc), vLiq: num(fat.vLiq) } : null,
    parcelas: parcelas.map((d: any) => ({ nDup: d.nDup || null, dVenc: d.dVenc || null, vDup: num(d.vDup) })),
  };
}
// Observações/informações complementares — mesmo grupo que a Receita usa pra exibir no DANFE
// ("Informações Complementares"/"Informações de interesse do Fisco"), mais as observações por item
// (infAdProd), que costumam carregar nº de pedido/lote do comprador.
function detalharNfeObservacoes(infNFe: any, dets: any[]): { infCpl: string | null; infAdFisco: string | null; itens: { n: string; xProd: string | null; obs: string }[] } {
  const infAdic = infNFe.infAdic || {};
  const itens = dets
    .map((d: any) => ({ n: String(d["@_nItem"] || ""), xProd: d?.prod?.xProd || null, obs: d.infAdProd || "" }))
    .filter((i: any) => i.obs);
  return { infCpl: infAdic.infCpl || null, infAdFisco: infAdic.infAdFisco || null, itens };
}
// Notas/documentos referenciados (devolução, complementar, substituição) — grupo <ide><NFref>.
function detalharNfeReferencias(ide: any): { tipo: string; valor: string }[] {
  const nfref = ide.NFref;
  const lista = Array.isArray(nfref) ? nfref : nfref ? [nfref] : [];
  return lista
    .map((r: any) => {
      if (r.refNFe) return { tipo: "NF-e referenciada", valor: String(r.refNFe) };
      if (r.refNFeSig) return { tipo: "NF-e (SVC) referenciada", valor: String(r.refNFeSig) };
      if (r.refCTe) return { tipo: "CT-e referenciado", valor: String(r.refCTe) };
      if (r.refECF) return { tipo: "Cupom fiscal (ECF) referenciado", valor: `${r.refECF.mod || ""} ${r.refECF.nECF || ""} ${r.refECF.nCOO || ""}`.trim() };
      if (r.refNF) {
        const n = r.refNF;
        return { tipo: "NF modelo 1/1A referenciada", valor: `${n.UF || ""} ${n.AAMM || ""} ${n.CNPJ || ""} nº ${n.nNF || ""}`.trim() };
      }
      return null;
    })
    .filter(Boolean) as { tipo: string; valor: string }[];
}
// Produtos especiais por item (estilo Espião): medicamento/combustível/veículo/importado, com os campos
// próprios de cada grupo — mesmos grupos já usados pras flags med/comb/veiculo/importado, só que aqui
// mostrando o detalhe (não só "tem ou não tem").
function detalharNfeEspeciais(dets: any[]): { n: string; xProd: string | null; tipo: string; detalhe: string }[] {
  const out: { n: string; xProd: string | null; tipo: string; detalhe: string }[] = [];
  for (const d of dets) {
    const n = String(d["@_nItem"] || "");
    const xProd = d?.prod?.xProd || null;
    const med = d?.prod?.med;
    if (med) out.push({ n, xProd, tipo: "Medicamento", detalhe: [med.cProdANVISA ? `Registro ANVISA ${med.cProdANVISA}` : null, med.xMotivoIsencao || null].filter(Boolean).join(" — ") || "—" });
    const comb = d?.prod?.comb;
    if (comb) out.push({ n, xProd, tipo: "Combustível", detalhe: [comb.descANP || null, comb.cProdANP ? `cProdANP ${comb.cProdANP}` : null].filter(Boolean).join(" — ") || "—" });
    const veic = d?.prod?.veicProd;
    if (veic) out.push({ n, xProd, tipo: "Veículo", detalhe: [veic.chassi ? `Chassi ${veic.chassi}` : null, veic.cCor || null].filter(Boolean).join(" — ") || "—" });
    const di = d?.prod?.DI;
    const diLista = Array.isArray(di) ? di : di ? [di] : [];
    for (const dd of diLista) out.push({ n, xProd, tipo: "Importado (DI)", detalhe: [dd.nDI ? `DI ${dd.nDI}` : null, dd.xLocDesemb || null].filter(Boolean).join(" — ") || "—" });
  }
  return out;
}
// Rastreabilidade (lote/validade) por item — grupo <prod><rastro>, pode ter mais de um lote no mesmo item.
function detalharNfeRastro(dets: any[]): { n: string; xProd: string | null; lote: string | null; qtd: number; fabricacao: string | null; validade: string | null }[] {
  const num = (v: any) => (v != null && v !== "" ? Number(v) || 0 : 0);
  const out: { n: string; xProd: string | null; lote: string | null; qtd: number; fabricacao: string | null; validade: string | null }[] = [];
  for (const d of dets) {
    const rastro = d?.prod?.rastro;
    const lista = Array.isArray(rastro) ? rastro : rastro ? [rastro] : [];
    for (const r of lista) out.push({ n: String(d["@_nItem"] || ""), xProd: d?.prod?.xProd || null, lote: r.nLote || null, qtd: num(r.qLote), fabricacao: r.dFab || null, validade: r.dVal || null });
  }
  return out;
}
