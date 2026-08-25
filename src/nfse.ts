import crypto from "crypto";
import fs from "fs";
import path from "path";
import https from "https";
import zlib from "zlib";
import forge from "node-forge";
import { SignedXml } from "xml-crypto";

/**
 * Módulo de emissão de NFS-e via Sistema Nacional NFS-e (ADN — Ambiente de Dados Nacional).
 *
 * Baseado na documentação oficial (gov.br/nfse): "Manual dos Contribuintes - Sistema Nacional
 * NFS-e — Guia para utilização das API's do Emissor Público Nacional" e no leiaute oficial da
 * DPS (ANEXO_I-SEFIN_ADN-DPS_NFSe-SNNFSe.xlsx). Cobre o caso comum: prestador brasileiro,
 * operação tributável, sem comércio exterior, obra, evento ou deduções — esses casos mais
 * específicos não estão implementados ainda.
 *
 * Autenticação: o ADN exige mTLS (certificado digital ICP-Brasil na própria conexão TLS) — não
 * existe login por usuário/senha para as APIs. Por isso todo certificado usado aqui (do
 * escritório ou de uma empresa-cliente) fica guardado criptografado em repouso (AES-256-GCM) e só
 * é decifrado em memória, no momento da chamada.
 *
 * A recepção de DPS (emissão síncrona da NFS-e) é atendida pela "Sefin Nacional NFS-e", que fica
 * num host diferente do ADN de distribuição/consulta (adn.*.nfse.gov.br/contribuintes/...) — foi
 * confirmado com teste real (certificado do escritório): GET em .../contribuintes/nfse devolve 404
 * (rota não existe), enquanto GET em sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse devolve
 * 405 Method Not Allowed (rota existe, só aceita POST).
 */

const ADN_BASE_URL = {
  producaorestrita: "https://sefin.producaorestrita.nfse.gov.br/SefinNacional",
  producao: "https://sefin.nfse.gov.br/SefinNacional",
} as const;
export type AmbienteNfse = keyof typeof ADN_BASE_URL;

const CERT_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, "..", "data"), "nfse-certificados");
fs.mkdirSync(CERT_DIR, { recursive: true });

// ===================== Criptografia em repouso (certificado .pfx e senha) =====================
function chaveCifra(): Buffer {
  const hex = process.env.NFSE_CERT_ENCRYPTION_KEY || "";
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error(
      "NFSE_CERT_ENCRYPTION_KEY não configurada corretamente (precisa de 32 bytes em hex) — defina no .env antes de usar o módulo NFS-e."
    );
  }
  return key;
}
function cifrar(dados: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", chaveCifra(), iv);
  const cifrado = Buffer.concat([cipher.update(dados), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), cifrado]);
}
function decifrar(dados: Buffer): Buffer {
  const iv = dados.subarray(0, 12);
  const tag = dados.subarray(12, 28);
  const cifrado = dados.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", chaveCifra(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(cifrado), decipher.final()]);
}
export function cifrarTexto(s: string): string {
  return cifrar(Buffer.from(s, "utf8")).toString("hex");
}
export function decifrarTexto(hex: string): string {
  return decifrar(Buffer.from(hex, "hex")).toString("utf8");
}

// ===================== Certificado digital (.pfx / PKCS12) =====================
export interface CertificadoInfo {
  privateKeyPem: string;
  certPem: string;
  titular: string | null;
  cnpjCertificado: string | null;
  validadeAte: Date | null;
}
// Lê o .pfx (PKCS12) e extrai a chave privada + certificado em PEM, prontos pra assinar.
// Lança erro claro se a senha estiver errada ou o arquivo não for um .pfx válido.
export function lerCertificadoPfx(pfxBuffer: Buffer, senha: string): CertificadoInfo {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const p12Der = forge.util.createBuffer(pfxBuffer.toString("binary"));
    const p12Asn1 = forge.asn1.fromDer(p12Der);
    p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, senha);
  } catch (e: any) {
    throw new Error("Não consegui abrir o certificado .pfx — verifique se o arquivo e a senha estão corretos.");
  }
  const keyBags = { ...p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag }), ...p12.getBags({ bagType: forge.pki.oids.keyBag }) };
  const keyBag =
    (keyBags[forge.pki.oids.pkcs8ShroudedKeyBag] || [])[0] || (keyBags[forge.pki.oids.keyBag] || [])[0];
  if (!keyBag || !keyBag.key) throw new Error("Não encontrei a chave privada dentro do certificado .pfx.");
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certBag = (certBags[forge.pki.oids.certBag] || [])[0];
  if (!certBag || !certBag.cert) throw new Error("Não encontrei o certificado (X.509) dentro do arquivo .pfx.");

  const privateKeyPem = forge.pki.privateKeyToPem(keyBag.key as forge.pki.PrivateKey);
  const certPem = forge.pki.certificateToPem(certBag.cert);
  const cnField = certBag.cert.subject.getField("CN");
  const cn = cnField ? String(cnField.value) : null;
  // Certificados e-CNPJ ICP-Brasil trazem o CNPJ embutido no CN, no formato "RAZAO SOCIAL:CNPJNNNNNNNNNNNNNN".
  const cnpjMatch = cn ? cn.match(/(\d{14})\D*$/) : null;
  return {
    privateKeyPem,
    certPem,
    titular: cn,
    cnpjCertificado: cnpjMatch ? cnpjMatch[1] : null,
    validadeAte: certBag.cert.validity.notAfter,
  };
}

// Salva o .pfx criptografado em disco e devolve o caminho relativo (guardado no banco).
export function salvarCertificadoCifrado(pfxBuffer: Buffer, nomeArquivo: string): string {
  const nome = `${Date.now()}_${crypto.randomBytes(6).toString("hex")}_${nomeArquivo.replace(/[^a-zA-Z0-9.\-_]/g, "_")}.enc`;
  const destino = path.join(CERT_DIR, nome);
  fs.writeFileSync(destino, cifrar(pfxBuffer));
  return destino;
}
export function lerCertificadoCifradoDoDisco(arquivoPath: string): Buffer {
  return decifrar(fs.readFileSync(arquivoPath));
}
export function excluirCertificadoDoDisco(arquivoPath: string) {
  try {
    fs.unlinkSync(arquivoPath);
  } catch {
    // já não existia — sem problema
  }
}

// ===================== Montagem e assinatura do XML da DPS =====================
export interface DadosPrestador {
  cnpj: string;
  inscricaoMunicipal?: string | null; // opcional — confirmado em XML real de MEI sem IM cadastrada
  codigoMunicipio: string; // IBGE, 7 dígitos
  opcaoSimplesNacional: boolean;
  regimeEspecialTrib: number; // 0 = Nenhum
  telefone?: string | null;
  email?: string | null;
}
export interface DadosTomador {
  documento: string; // só dígitos — 11 (CPF) ou 14 (CNPJ)
  nome: string;
  email?: string | null;
  cep?: string | null;
  logradouro?: string | null;
  numero?: string | null;
  complemento?: string | null;
  bairro?: string | null;
  codigoMunicipio?: string | null; // se omitido, assume o mesmo do prestador
}
export interface DadosServico {
  codigoTributacaoNacional: string; // cTribNac, 6 dígitos
  codigoTributacaoMunicipal?: string | null; // cTribMun, opcional — nem todo município usa
  codigoNbs?: string | null; // cNBS, 9 dígitos — o próprio portal do governo trata como obrigatório na prática
  descricao: string;
  valor: number;
  competencia: string; // 'YYYY-MM-DD'
  tribIssqn?: number; // 1=Tributável 2=Imunidade 3=Exportação 4=Não incidência (default 1)
  tipoRetencaoIssqn?: number; // 1=Não retido 2=Retido pelo tomador 3=Retido pelo intermediário (default 1)
  aliquotaIssqn?: number | null; // % — quando o município não retornar via API de parâmetros
  tipoRetencaoPisCofins?: number | null; // 1-4, ver nfse_modelos — null = não informar o grupo
  // Exigibilidade suspensa do ISSQN (decisão judicial/processo administrativo)
  issqnExigibilidadeSuspensa?: boolean;
  issqnMotivoSuspensao?: number | null; // 1=Decisão Judicial 2=Processo Administrativo
  issqnNumeroProcesso?: string | null;
  // Benefício municipal do ISSQN
  beneficioMunicipalCodigo?: string | null; // nBM
  // Tributação Federal — CST do PIS/COFINS e valores retidos (calculados a partir do % do modelo × valor do serviço)
  pisCofinsCst?: string | null; // default "00"
  valorIrrf?: number | null;
  valorCsll?: number | null;
  valorCofinsRetido?: number | null;
  valorPisRetido?: number | null;
  valorContribPrevidenciaria?: number | null;
  // IBS/CBS (Reforma Tributária) — só obrigatório a partir de out/2026 (jan/2027 Simples Nacional)
  ibscbsPreencher?: boolean;
  ibscbsCst?: string | null; // default "000"
  ibscbsCclasstrib?: string | null; // default "000001"
  // Informações complementares
  docResponsabilidadeTecnica?: string | null;
  docReferencia?: string | null;
  informacoesComplementares?: string | null;
}
export interface MontarDpsInput {
  ambiente: AmbienteNfse;
  serie: number;
  numeroDps: number;
  prestador: DadosPrestador;
  tomador: DadosTomador;
  servico: DadosServico;
}

function so2(n: number): string {
  return String(n).padStart(2, "0");
}
function xmlEscape(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
}
// dhEmi exige hora local com o offset real (TZD +hh:mm/-hh:mm) — testado com certificado real: a
// ADN rejeita (E0008) um horário UTC relabelado como "-00:00", mesmo representando o mesmo
// instante. Brasil não tem mais horário de verão desde 2019, então -03:00 (Brasília) é fixo pra
// praticamente todos os municípios emissores.
function dataHoraBrasilia(deslocamentoMs = 0): string {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000 + deslocamentoMs);
  return d.toISOString().replace(/\.\d{3}Z$/, "-03:00");
}

// Monta o XML da DPS (sem assinatura ainda) seguindo o leiaute oficial (ANEXO_I-SEFIN_ADN-DPS_NFSe-SNNFSe).
// Cobre só o caso comum — serviço nacional, tributável, sem obra/evento/comércio exterior/dedução.
export function montarXmlDps(input: MontarDpsInput): { xml: string; idDps: string } {
  const { ambiente, serie, numeroDps, prestador, tomador, servico } = input;
  const tpAmb = ambiente === "producao" ? "1" : "2";
  const tpInsc = "2"; // 2 = CNPJ (prestador sempre pessoa jurídica no nosso caso)
  const inscFederal = prestador.cnpj.padStart(14, "0");
  const idDps = `DPS${prestador.codigoMunicipio}${tpInsc}${inscFederal}${String(serie).padStart(5, "0")}${String(numeroDps).padStart(15, "0")}`;
  const dhEmi = dataHoraBrasilia(-60_000); // 60s de folga pra latência de rede/desvio de relógio

  const tomadorTpInsc = tomador.documento.length === 14 ? "CNPJ" : "CPF";
  const tomadorMun = tomador.codigoMunicipio || prestador.codigoMunicipio;

  const versaoDps = servico.ibscbsPreencher ? "1.01" : "1.00"; // 1.01 = layout com o grupo IBSCBS; 1.00 = sem
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="${versaoDps}"><infDPS Id="${idDps}">
<tpAmb>${tpAmb}</tpAmb>
<dhEmi>${xmlEscape(dhEmi)}</dhEmi>
<verAplic>simplescontabeis-1.0</verAplic>
<serie>${String(serie).padStart(5, "0")}</serie>
<nDPS>${numeroDps}</nDPS>
<dCompet>${servico.competencia}</dCompet>
<tpEmit>1</tpEmit>
<cLocEmi>${prestador.codigoMunicipio}</cLocEmi>
<prest>
<CNPJ>${prestador.cnpj}</CNPJ>
${prestador.inscricaoMunicipal ? `<IM>${xmlEscape(prestador.inscricaoMunicipal)}</IM>` : ""}
${prestador.telefone ? `<fone>${xmlEscape(prestador.telefone.replace(/\D/g, ""))}</fone>` : ""}
${prestador.email ? `<email>${xmlEscape(prestador.email)}</email>` : ""}
<regTrib>
<opSimpNac>${prestador.opcaoSimplesNacional ? "2" : "1"}</opSimpNac>
<regEspTrib>${prestador.regimeEspecialTrib}</regEspTrib>
</regTrib>
</prest>
<toma>
<${tomadorTpInsc}>${tomador.documento}</${tomadorTpInsc}>
<xNome>${xmlEscape(tomador.nome)}</xNome>
${
  // O grupo <end> só entra se tivermos os campos obrigatórios completos (CEP/logradouro/número/
  // bairro) — o leiaute exige todos ou nenhum, não dá pra mandar endereço pela metade.
  tomador.cep && tomador.logradouro && tomador.numero && tomador.bairro
    ? `<end>
<endNac>
<cMun>${tomadorMun}</cMun>
<CEP>${String(tomador.cep).replace(/\D/g, "")}</CEP>
</endNac>
<xLgr>${xmlEscape(tomador.logradouro)}</xLgr>
<nro>${xmlEscape(tomador.numero)}</nro>
${tomador.complemento ? `<xCpl>${xmlEscape(tomador.complemento)}</xCpl>` : ""}
<xBairro>${xmlEscape(tomador.bairro)}</xBairro>
</end>`
    : ""
}
${tomador.email ? `<email>${xmlEscape(tomador.email)}</email>` : ""}
</toma>
<serv>
<locPrest>
<cLocPrestacao>${tomadorMun}</cLocPrestacao>
</locPrest>
<cServ>
<cTribNac>${servico.codigoTributacaoNacional}</cTribNac>
${servico.codigoTributacaoMunicipal ? `<cTribMun>${xmlEscape(servico.codigoTributacaoMunicipal)}</cTribMun>` : ""}
<xDescServ>${xmlEscape(servico.descricao)}</xDescServ>
${servico.codigoNbs ? `<cNBS>${xmlEscape(servico.codigoNbs)}</cNBS>` : ""}
</cServ>
${
  servico.docResponsabilidadeTecnica || servico.docReferencia || servico.informacoesComplementares
    ? `<infoCompl>
${servico.docResponsabilidadeTecnica ? `<idDocTec>${xmlEscape(servico.docResponsabilidadeTecnica)}</idDocTec>` : ""}
${servico.docReferencia ? `<docRef>${xmlEscape(servico.docReferencia)}</docRef>` : ""}
${servico.informacoesComplementares ? `<xInfComp>${xmlEscape(servico.informacoesComplementares)}</xInfComp>` : ""}
</infoCompl>`
    : ""
}
</serv>
<valores>
<vServPrest>
<vServ>${servico.valor.toFixed(2)}</vServ>
</vServPrest>
<trib>
<tribMun>
<tribISSQN>${servico.tribIssqn ?? 1}</tribISSQN>
${
  servico.issqnExigibilidadeSuspensa
    ? `<exigSusp>\n<tpSusp>${servico.issqnMotivoSuspensao ?? 1}</tpSusp>\n<nProcesso>${xmlEscape(servico.issqnNumeroProcesso || "")}</nProcesso>\n</exigSusp>`
    : ""
}
${servico.beneficioMunicipalCodigo ? `<BM>\n<nBM>${xmlEscape(servico.beneficioMunicipalCodigo)}</nBM>\n</BM>` : ""}
<tpRetISSQN>${servico.tipoRetencaoIssqn ?? 1}</tpRetISSQN>
${servico.aliquotaIssqn != null ? `<pAliq>${servico.aliquotaIssqn.toFixed(2)}</pAliq>` : ""}
</tribMun>
${
  // O grupo tribFed entra se houver qualquer retenção federal configurada no modelo (PIS/COFINS,
  // IRRF, CSLL ou contribuição previdenciária) — senão fica de fora, já que é opcional (0-1).
  servico.tipoRetencaoPisCofins != null ||
  servico.valorIrrf != null ||
  servico.valorCsll != null ||
  servico.valorContribPrevidenciaria != null
    ? `<tribFed>
${
  servico.tipoRetencaoPisCofins != null || servico.valorPisRetido != null || servico.valorCofinsRetido != null
    ? `<piscofins>
<CST>${xmlEscape(servico.pisCofinsCst || "00")}</CST>
${servico.valorPisRetido != null ? `<vPis>${servico.valorPisRetido.toFixed(2)}</vPis>` : ""}
${servico.valorCofinsRetido != null ? `<vCofins>${servico.valorCofinsRetido.toFixed(2)}</vCofins>` : ""}
${servico.tipoRetencaoPisCofins != null ? `<tpRetPisCofins>${servico.tipoRetencaoPisCofins}</tpRetPisCofins>` : ""}
</piscofins>`
    : ""
}
${servico.valorContribPrevidenciaria != null ? `<vRetCP>${servico.valorContribPrevidenciaria.toFixed(2)}</vRetCP>` : ""}
${servico.valorIrrf != null ? `<vRetIRRF>${servico.valorIrrf.toFixed(2)}</vRetIRRF>` : ""}
${servico.valorCsll != null ? `<vRetCSLL>${servico.valorCsll.toFixed(2)}</vRetCSLL>` : ""}
</tribFed>`
    : ""
}
<totTrib>
<indTotTrib>0</indTotTrib>
</totTrib>
</trib>
</valores>
${
  // IBS/CBS (Reforma Tributária) — só obrigatório a partir de out/2026 (jan/2027 pro Simples
  // Nacional). Usa os mesmos valores padrão observados numa DPS real já emitida (cIndOp/finNFSe/
  // indFinal/indDest fixos — só CST e cClassTrib são configuráveis por modelo).
  servico.ibscbsPreencher
    ? `<IBSCBS>
<finNFSe>0</finNFSe>
<indFinal>0</indFinal>
<cIndOp>100601</cIndOp>
<indDest>0</indDest>
<valores>
<trib>
<gIBSCBS>
<CST>${xmlEscape(servico.ibscbsCst || "000")}</CST>
<cClassTrib>${xmlEscape(servico.ibscbsCclasstrib || "000001")}</cClassTrib>
</gIBSCBS>
</trib>
</valores>
</IBSCBS>`
    : ""
}
</infDPS></DPS>`;

  return { xml, idDps };
}

// Assina a DPS com o certificado informado (enveloped signature, RSA-SHA256), pronta pra POST.
export function assinarXmlDps(xml: string, idDps: string, cert: CertificadoInfo): string {
  const sig = new SignedXml({ privateKey: cert.privateKeyPem, publicCert: cert.certPem, getKeyInfoContent: SignedXml.getKeyInfoContent });
  sig.addReference({
    xpath: "//*[local-name(.)='infDPS']",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    uri: `#${idDps}`,
  });
  sig.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  sig.canonicalizationAlgorithm = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='infDPS']", action: "after" } });
  return sig.getSignedXml();
}

// ===================== Envio ao ADN (mTLS) =====================
export interface RespostaAdn {
  ok: boolean;
  status: number;
  corpo: string;
}
// POST genérico à Sefin Nacional NFS-e autenticado com o certificado (mTLS) — usado tanto para
// /nfse quanto para consultas. O corpo pode ser JSON (emissão) ou vazio (GET).
export function chamarAdn(
  ambiente: AmbienteNfse,
  metodo: "GET" | "POST",
  caminho: string,
  cert: CertificadoInfo,
  corpo?: string,
  contentType: string = "application/json"
): Promise<RespostaAdn> {
  return new Promise((resolve, reject) => {
    const base = new URL(ADN_BASE_URL[ambiente] + caminho);
    const agent = new https.Agent({ cert: cert.certPem, key: cert.privateKeyPem });
    const bodyBuffer = corpo ? Buffer.from(corpo, "utf8") : undefined;
    const req = https.request(
      {
        hostname: base.hostname,
        path: base.pathname + base.search,
        method: metodo,
        agent,
        headers: {
          "Content-Type": contentType,
          ...(bodyBuffer ? { "Content-Length": String(bodyBuffer.length) } : {}),
        },
        timeout: 30000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const texto = Buffer.concat(chunks).toString("utf8");
          resolve({ ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, status: res.statusCode || 0, corpo: texto });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Tempo esgotado ao conectar no Sistema Nacional NFS-e (ADN).")));
    req.on("error", (e) => reject(e));
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

// A Sefin Nacional NFS-e espera/devolve o XML comprimido (gzip) e em base64 dentro de um envelope
// JSON — não o XML cru. Sucesso (2xx): {chaveAcesso, nfseXmlGZipB64}. Erro: {erros:[{Codigo,Descricao}]}.
function interpretarRespostaEmissao(resposta: RespostaAdn): { chaveAcesso: string | null; xmlNfse: string | null; mensagemErro: string | null } {
  let json: any;
  try {
    json = JSON.parse(resposta.corpo);
  } catch {
    return { chaveAcesso: null, xmlNfse: null, mensagemErro: resposta.corpo || `HTTP ${resposta.status}` };
  }
  if (resposta.ok) {
    const xmlNfse = json.nfseXmlGZipB64 ? zlib.gunzipSync(Buffer.from(json.nfseXmlGZipB64, "base64")).toString("utf8") : null;
    return { chaveAcesso: json.chaveAcesso || null, xmlNfse, mensagemErro: null };
  }
  const erros = Array.isArray(json.erros) ? json.erros.map((e: any) => `${e.Codigo || ""}: ${e.Descricao || ""}`.trim()).join(" | ") : null;
  return { chaveAcesso: null, xmlNfse: null, mensagemErro: erros || resposta.corpo };
}

// Fluxo completo: monta, assina e envia a DPS; devolve o XML assinado (pra guardar) e o resultado interpretado.
export async function emitirDps(
  input: MontarDpsInput,
  cert: CertificadoInfo
): Promise<{ xmlAssinado: string; resposta: RespostaAdn; chaveAcesso: string | null; xmlNfse: string | null; mensagemErro: string | null }> {
  const { xml, idDps } = montarXmlDps(input);
  const xmlAssinado = assinarXmlDps(xml, idDps, cert);
  const corpoRequisicao = JSON.stringify({ dpsXmlGZipB64: zlib.gzipSync(Buffer.from(xmlAssinado, "utf8")).toString("base64") });
  const resposta = await chamarAdn(input.ambiente, "POST", "/nfse", cert, corpoRequisicao, "application/json");
  const { chaveAcesso, xmlNfse, mensagemErro } = interpretarRespostaEmissao(resposta);
  return { xmlAssinado, resposta, chaveAcesso, xmlNfse, mensagemErro };
}
