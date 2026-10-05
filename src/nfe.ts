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
    `<CNPJ>${cnpjLimpo}</CNPJ><chNFe>${params.chave}</chNFe><dhEvento>${dhEvento}</dhEvento>` +
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
  // Confirmado ao vivo: a resposta vem embrulhada em <nfeResultMsg>, não em
  // nfeRecepcaoEventoResponse/nfeRecepcaoEventoResult (esse é o padrão .NET genérico que eu tinha
  // assumido por analogia com a Distribuição DFe — RecepcaoEvento4 usa outro).
  const retEnvEvento = json?.["soap:Envelope"]?.["soap:Body"]?.nfeResultMsg?.retEnvEvento;
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
  tipo: "nfe" | "nfce" | "cte" | "evento" | "outro";
  chaveAcesso: string | null;
  emitenteCnpj: string | null;
  emitenteNome: string | null;
  destinatarioCnpj: string | null;
  destinatarioNome: string | null;
  valorTotal: number | null;
  dataEmissao: string | null; // ISO
  eventoDescricao: string | null; // xEvento (só preenchido quando tipo === "evento") — ex.: "Cancelamento", "Registro de Passagem Autorização"
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
): { vIBS: number; vCBS: number; vBC: number; vICMS: number; vPIS: number; vCOFINS: number; vIPI: number; flags: string[]; qtdItens: number } | null {
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
  return { vIBS, vCBS, vBC, vICMS, vPIS, vCOFINS, vIPI, flags, qtdItens };
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
  };
}
