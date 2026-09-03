import https from "https";
import * as nfse from "./nfse";

/**
 * Integração com o "Integra Contador" (Receita Federal + SERPRO) — DAS, Declaração do Simples
 * Nacional (PGDAS-D), Situação Fiscal (SITFIS) e DCTFWeb.
 *
 * IMPORTANTE — diferente de NF-e/NFS-e/OneDrive: este é um serviço PAGO (cobrança por uso, ex.:
 * R$0,80 por DAS emitido em 01/2025), contratado pelo próprio escritório na Loja SERPRO
 * (loja.serpro.gov.br) com o e-CNPJ dele — não é o certificado da empresa-cliente. Cada
 * empresa-cliente precisa dar "autorização de acesso" pro CNPJ do escritório no e-CAC dela, E o
 * escritório precisa aceitar essa autorização manualmente (até 30 dias) — isso não dá pra
 * automatizar por API, é um passo humano no e-CAC.
 *
 * Construído a partir da documentação oficial (apicenter.estaleiro.serpro.gov.br/documentacao/
 * api-integra-contador) — a autenticação e o fluxo do PGDASD/SITFIS foram confirmados contra a
 * documentação real (exemplos literais de request/response). O DCTFWeb (consultarDctfWeb) tem a
 * estrutura pronta mas os idServico exatos NÃO foram confirmados — só usar depois de checar contra
 * o Swagger real (só acessível com uma conta contratada). NUNCA testado contra uma conta real (o
 * escritório ainda não contratou) — é bem possível que algum campo precise de ajuste no primeiro
 * uso de verdade, do mesmo jeito que aconteceu com nfse.ts e asaas.ts antes de funcionarem.
 */

const AUTH_URL = "https://autenticacao.sapi.serpro.gov.br/authenticate";
const GATEWAY_BASE = "https://gateway.apiserpro.serpro.gov.br/integra-contador/v1";

export interface TokenIntegraContador {
  accessToken: string;
  jwtToken: string;
  expiresIn: number;
  obtidoEm: number; // Date.now() no momento da obtenção, pra saber quando renovar
}

type RespostaHttps = { status: number; corpo: string; headers: Record<string, string | string[] | undefined> };
// Retry automático pra falha de conexão (não pra erro de negócio — HTTP 4xx/5xx já vem como
// resposta normal, resolvida, não como rejeição; só timeout/conexão encerrada chegam aqui). Achado
// ao vivo: o gateway do SERPRO fecha a conexão sem aviso de vez em quando — chamadas isoladas logo
// em seguida sempre funcionaram na hora, então vale muito a pena tentar de novo automaticamente em
// vez de deixar a busca inteira falhar (ou pior, ficar presa até o timeout externo de 3 minutos).
async function chamarHttps(opts: {
  hostname: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  cert?: string;
  key?: string;
  corpo?: Buffer;
}): Promise<RespostaHttps> {
  const TENTATIVAS = 3;
  let ultimoErro: Error = new Error("Falha desconhecida ao chamar o Integra Contador.");
  for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
    try {
      return await chamarHttpsUmaVez(opts);
    } catch (e: any) {
      ultimoErro = e;
      if (tentativa < TENTATIVAS) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw ultimoErro;
}
function chamarHttpsUmaVez(opts: {
  hostname: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  cert?: string;
  key?: string;
  corpo?: Buffer;
}): Promise<RespostaHttps> {
  return new Promise((resolve, reject) => {
    let finalizado = false;
    // Achado ao vivo (2ª rodada): a opção "timeout" do https.request é um timeout de INATIVIDADE do
    // socket — se o SERPRO for mandando dados aos poucos (mesmo bem devagar), cada byte reinicia a
    // contagem e o timeout nunca dispara, mesmo a chamada toda demorando minutos. Por isso troca por
    // um prazo explícito (setTimeout comum), que sempre dispara no tempo certo, não importa o que
    // aconteça na conexão — junto com o fix anterior de "close" sem "end" (conexão fechada cedo sem
    // avisar), fecha as duas formas encontradas de a Promise nunca resolver nem rejeitar sozinha.
    const PRAZO_MS = 25000;
    const prazoTimer = setTimeout(() => {
      if (finalizado) return;
      finalizado = true;
      req.destroy();
      reject(new Error("Tempo esgotado ao conectar no Integra Contador (SERPRO)."));
    }, PRAZO_MS);
    const req = https.request({ hostname: opts.hostname, path: opts.path, method: opts.method, headers: opts.headers, cert: opts.cert, key: opts.key }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (finalizado) return;
        finalizado = true;
        clearTimeout(prazoTimer);
        resolve({ status: res.statusCode || 0, corpo: Buffer.concat(chunks).toString("utf8"), headers: res.headers as any });
      });
      // "close" dispara tanto no fim normal (depois de "end", quando finalizado já é true — não faz
      // nada) quanto quando a conexão é encerrada prematuramente pelo servidor (finalizado ainda
      // false — rejeita na hora, sem esperar o prazo inteiro).
      res.on("close", () => {
        if (finalizado) return;
        finalizado = true;
        clearTimeout(prazoTimer);
        reject(new Error("A conexão com o Integra Contador (SERPRO) foi encerrada antes da resposta terminar — tente de novo."));
      });
    });
    req.on("error", (e) => {
      if (finalizado) return;
      finalizado = true;
      clearTimeout(prazoTimer);
      reject(e);
    });
    if (opts.corpo) req.write(opts.corpo);
    req.end();
  });
}
// No cache do SITFIS, uma resposta 304 (protocolo já solicitado antes, ainda não consumido no
// /emitir) não tem corpo — o protocolo vem dentro do header ETag, no formato
// `"protocoloRelatorio:<valor>"` (com aspas, padrão HTTP de ETag). Ver documentação oficial:
// apicenter.estaleiro.serpro.gov.br/documentacao/api-integra-contador/pt/solucoes/integra-sitfis/sitfis/cache/
function extrairProtocoloDoETag(etag: string | string[] | undefined): string | null {
  const valor = Array.isArray(etag) ? etag[0] : etag;
  if (!valor) return null;
  const semAspas = valor.replace(/^W\//, "").replace(/^"|"$/g, "");
  const m = semAspas.match(/^protocoloRelatorio:(.+)$/);
  return m ? m[1] : null;
}

// Autenticação: mTLS com o e-CNPJ do escritório + Basic auth (consumerKey:consumerSecret, da Loja
// SERPRO) → devolve um par de tokens (access_token curto, ~33min) usado nas chamadas seguintes.
export async function autenticar(cert: nfse.CertificadoInfo, consumerKey: string, consumerSecret: string): Promise<TokenIntegraContador> {
  const basic = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
  const corpo = Buffer.from("grant_type=client_credentials", "utf8");
  const url = new URL(AUTH_URL);
  const { status, corpo: resposta } = await chamarHttps({
    hostname: url.hostname,
    path: url.pathname,
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Role-Type": "TERCEIROS",
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": String(corpo.length),
    },
    cert: cert.certPem,
    key: cert.privateKeyPem,
    corpo,
  });
  let json: any;
  try {
    json = JSON.parse(resposta);
  } catch {
    throw new Error(`Resposta inesperada do Integra Contador ao autenticar (HTTP ${status}): ${resposta.slice(0, 300)}`);
  }
  if (status !== 200 || !json.access_token) {
    throw new Error(json.mensagem || json.message || `Falha ao autenticar no Integra Contador (HTTP ${status}).`);
  }
  return { accessToken: json.access_token, jwtToken: json.jwt_token, expiresIn: json.expires_in || 1800, obtidoEm: Date.now() };
}
export function tokenValido(token: TokenIntegraContador | null): boolean {
  if (!token) return false;
  // Renova um pouco antes de expirar de verdade (30s de folga), pra não arriscar usar um token
  // que expira no meio da chamada seguinte.
  return Date.now() - token.obtidoEm < (token.expiresIn - 30) * 1000;
}

export interface PedidoIntegraContador {
  base: "Emitir" | "Consultar" | "Declarar" | "Apoiar" | "Monitorar";
  contratanteCnpj: string; // CNPJ do escritório (quem contratou o serviço)
  contribuinteDocumento: string; // CNPJ ou CPF da empresa-cliente sendo consultada
  idSistema: string;
  idServico: string;
  versaoSistema: string;
  dados: object;
}
interface RespostaIntegraContador {
  status: number;
  mensagens: { codigo: string; texto: string }[];
  dados: any; // já decodificado de JSON, se a Receita mandar string JSON escapada dentro de "dados"
  etagProtocolo: string | null; // só preenchido quando status===304 no SITFIS — ver extrairProtocoloDoETag
}
export async function chamarServico(token: TokenIntegraContador, pedido: PedidoIntegraContador): Promise<RespostaIntegraContador> {
  const documentoLimpo = pedido.contribuinteDocumento.replace(/\D/g, "");
  const cnpjContratanteLimpo = pedido.contratanteCnpj.replace(/\D/g, "");
  const corpoObj = {
    contratante: { numero: cnpjContratanteLimpo, tipo: 2 },
    autorPedidoDados: { numero: cnpjContratanteLimpo, tipo: 2 },
    contribuinte: { numero: documentoLimpo, tipo: documentoLimpo.length === 11 ? 1 : 2 },
    pedidoDados: {
      idSistema: pedido.idSistema,
      idServico: pedido.idServico,
      versaoSistema: pedido.versaoSistema,
      dados: JSON.stringify(pedido.dados),
    },
  };
  const corpo = Buffer.from(JSON.stringify(corpoObj), "utf8");
  const url = new URL(`${GATEWAY_BASE}/${pedido.base}`);
  const { status, corpo: resposta, headers: respHeaders } = await chamarHttps({
    hostname: url.hostname,
    path: url.pathname,
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      jwt_token: token.jwtToken,
      "Content-Type": "application/json",
      "Content-Length": String(corpo.length),
    },
    corpo,
  });
  // 304 (Not Modified) no SITFIS não é erro — é o mecanismo de cache deles: o protocolo (pedido
  // anterior, ainda não consumido no /emitir) vem no header ETag em vez do corpo, que fica vazio.
  if (status === 304) return { status, mensagens: [], dados: null, etagProtocolo: extrairProtocoloDoETag(respHeaders.etag) };
  let json: any;
  try {
    json = JSON.parse(resposta);
  } catch {
    throw new Error(`Resposta inesperada do Integra Contador (HTTP ${status}): ${resposta.slice(0, 300)}`);
  }
  if (status === 401) throw new Error("TOKEN_EXPIRADO"); // sinal especial — quem chama deve reautenticar e tentar de novo uma vez
  const mensagens = Array.isArray(json.mensagens) ? json.mensagens.map((m: any) => ({ codigo: m.codigo || m.Codigo, texto: m.texto || m.Texto })) : [];
  if (status < 200 || status >= 300) {
    const texto = mensagens.map((m: any) => `${m.codigo}: ${m.texto}`).join(" | ") || `HTTP ${status}`;
    throw new Error(texto);
  }
  let dados = json.dados;
  if (typeof dados === "string") {
    try {
      dados = JSON.parse(dados);
    } catch {
      /* alguns serviços devolvem "dados" já como objeto, outros como string JSON escapada — mantém como veio se não for parseável */
    }
  }
  return { status: json.status ?? status, mensagens, dados, etagProtocolo: null };
}

// ===================== PGDASD (DAS + Declaração do Simples Nacional) — confirmado na doc oficial =====================
export interface DasEmitido {
  numeroDocumento: string | null;
  periodoApuracao: string | null;
  dataVencimento: string | null;
  dataLimiteAcolhimento: string | null;
  valores: any;
  pdfBase64: string | null;
}
// Resposta real confirmada contra conta de produção (bem diferente do que a doc oficial sozinha
// sugeria): "dados" vem como array com 1 item — { pdf, cnpjCompleto, detalhamentoDas: { ... } } —
// não como um objeto plano com pdf/numeroDocumento direto na raiz.
function extrairDasEmitido(dadosResposta: any): DasEmitido {
  const item = Array.isArray(dadosResposta) ? dadosResposta[0] : dadosResposta?.["0"] || dadosResposta;
  const det = item?.detalhamentoDas || {};
  return {
    numeroDocumento: det.numeroDocumento || null,
    periodoApuracao: det.periodoApuracao || null,
    dataVencimento: det.dataVencimento || null,
    dataLimiteAcolhimento: det.dataLimiteAcolhimento || null,
    valores: det.valores || null,
    pdfBase64: item?.pdf || null,
  };
}
// Gera o DAS a partir de uma declaração PGDAS-D já transmitida (o que a maioria dos escritórios
// quer: "o DAS de tal competência"), usando os valores já apurados/declarados — não pede pra
// informar tributo/valor na mão. Rodar de novo pro mesmo período recalcula o DAS (útil se a
// declaração daquela competência foi retificada depois da primeira busca).
export async function gerarDas(token: TokenIntegraContador, contratanteCnpj: string, cnpjEmpresa: string, periodoApuracao: string): Promise<DasEmitido> {
  const r = await chamarServico(token, {
    base: "Emitir",
    contratanteCnpj,
    contribuinteDocumento: cnpjEmpresa,
    idSistema: "PGDASD",
    idServico: "GERARDAS12",
    versaoSistema: "1.0",
    dados: { periodoApuracao: String(periodoApuracao) },
  });
  return extrairDasEmitido(r.dados);
}
// Gera um DAS avulso informando os tributos/valores na mão (idServico GERARDASAVULSO19) — diferente
// do gerarDas acima, esse NÃO usa uma declaração já transmitida; exige montar ListaTributos
// (Codigo/Valor/CodMunicipio/uf) por fora, então não é chamado automaticamente na busca — deixado
// pronto pra um caso de uso futuro que realmente precise montar um DAS do zero.
export async function gerarDasAvulso(token: TokenIntegraContador, contratanteCnpj: string, cnpjEmpresa: string, periodoApuracao: string, listaTributos: object[]): Promise<DasEmitido> {
  const r = await chamarServico(token, {
    base: "Emitir",
    contratanteCnpj,
    contribuinteDocumento: cnpjEmpresa,
    idSistema: "PGDASD",
    idServico: "GERARDASAVULSO19",
    versaoSistema: "1.0",
    dados: { periodoApuracao: Number(periodoApuracao), listaTributos },
  });
  return extrairDasEmitido(r.dados);
}
export interface DeclaracaoSimplesNacional {
  numeroDeclaracao: string | null;
  periodoApuracao: string; // AAAAMM
  dataTransmissao: string | null;
  numeroDasGerado: string | null; // último DAS já gerado no histórico do SERPRO pra esse período, se houver (só o número — não vem PDF aqui)
  dasPago: boolean | null;
}
// Lista as declarações do Simples Nacional já entregues (não transmite uma nova — só consulta o
// que já existe). Transmitir uma declaração nova exige todos os dados de apuração de receita por
// atividade/período, que este sistema ainda não coleta — fica pra uma etapa futura.
//
// Resposta real da Receita (confirmado contra conta de produção, bem diferente do que a doc oficial
// sozinha sugeria): dados.periodos[] — cada item tem periodoApuracao e uma lista "operacoes" com
// tipoOperacao "Original" (a declaração em si, dentro de indiceDeclaracao) ou "Geração de DAS" /
// "DAS de Cobrança" (dentro de indiceDas) — não vem um array plano de declarações como o nome do
// serviço sugere.
export async function consultarDeclaracoesPorAno(token: TokenIntegraContador, contratanteCnpj: string, cnpjEmpresa: string, ano: string): Promise<DeclaracaoSimplesNacional[]> {
  const r = await chamarServico(token, {
    base: "Consultar",
    contratanteCnpj,
    contribuinteDocumento: cnpjEmpresa,
    idSistema: "PGDASD",
    idServico: "CONSDECLARACAO13",
    versaoSistema: "1.0",
    dados: { anoCalendario: String(ano) },
  });
  const periodos = Array.isArray(r.dados?.periodos) ? r.dados.periodos : [];
  const resultado: DeclaracaoSimplesNacional[] = [];
  for (const p of periodos) {
    const operacoes = Array.isArray(p.operacoes) ? p.operacoes : [];
    const original = operacoes.find((o: any) => o.tipoOperacao === "Original" && o.indiceDeclaracao);
    if (!original) continue; // período sem declaração transmitida ainda (ex.: mês corrente) — nada a mostrar
    const dasOperacoes = operacoes.filter((o: any) => o.indiceDas).map((o: any) => o.indiceDas);
    const ultimoDas = dasOperacoes[dasOperacoes.length - 1] || null;
    resultado.push({
      numeroDeclaracao: original.indiceDeclaracao.numeroDeclaracao || null,
      periodoApuracao: String(p.periodoApuracao),
      dataTransmissao: original.indiceDeclaracao.dataHoraTransmissao || null,
      numeroDasGerado: ultimoDas?.numeroDas || null,
      dasPago: ultimoDas ? !!ultimoDas.dasPago : null,
    });
  }
  return resultado;
}

// ===================== SITFIS (Situação Fiscal) — confirmado na doc oficial, fluxo em 2 passos =====================
// Passo 1: pede um "protocolo" (a Receita processa em segundo plano). Passo 2: usa o protocolo pra
// pegar o relatório em PDF — pode vir "ainda processando" (202, espera X segundos) antes do PDF
// ficar pronto (200).
export async function solicitarProtocoloSitfis(token: TokenIntegraContador, contratanteCnpj: string, documentoEmpresa: string): Promise<string | null> {
  const r = await chamarServico(token, {
    base: "Apoiar",
    contratanteCnpj,
    contribuinteDocumento: documentoEmpresa,
    idSistema: "SITFIS",
    idServico: "SOLICITARPROTOCOLO91",
    versaoSistema: "2.0",
    dados: {},
  });
  // 304 aqui é o cache do SITFIS: já existe um protocolo pedido antes pra esse contribuinte, ainda
  // não consumido no /emitir — vem no header ETag (extraído em chamarServico), não no corpo.
  if (r.status === 304) return r.etagProtocolo;
  const protocolo = r.dados?.protocoloRelatorio || r.dados?.protocolo;
  if (!protocolo) throw new Error("A Receita não devolveu um protocolo de relatório.");
  return protocolo;
}
export async function emitirRelatorioSitfis(token: TokenIntegraContador, contratanteCnpj: string, documentoEmpresa: string, protocoloRelatorio: string): Promise<{ pronto: boolean; pdfBase64: string | null; tempoEsperaSegundos: number | null }> {
  const r = await chamarServico(token, {
    base: "Emitir",
    contratanteCnpj,
    contribuinteDocumento: documentoEmpresa,
    idSistema: "SITFIS",
    idServico: "RELATORIOSITFIS92",
    versaoSistema: "2.0",
    dados: { protocoloRelatorio },
  });
  if (r.status === 202 || r.status === 304) return { pronto: false, pdfBase64: null, tempoEsperaSegundos: r.dados?.tempoEspera ?? 5 };
  return { pronto: true, pdfBase64: r.dados?.pdf || null, tempoEsperaSegundos: null };
}
// Junta os dois passos — pede o protocolo e espera o relatório ficar pronto (poll respeitando o
// tempoEspera que a própria Receita manda), com um teto de tentativas pra não esperar pra sempre.
export async function obterRelatorioSitfisCompleto(token: TokenIntegraContador, contratanteCnpj: string, documentoEmpresa: string): Promise<string> {
  let protocolo: string | null = null;
  for (let tentativa = 0; tentativa < 10 && !protocolo; tentativa++) {
    protocolo = await solicitarProtocoloSitfis(token, contratanteCnpj, documentoEmpresa);
    if (!protocolo) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (!protocolo) throw new Error("A Receita não devolveu um protocolo de relatório a tempo — tente de novo em alguns minutos.");
  for (let tentativa = 0; tentativa < 10; tentativa++) {
    const r = await emitirRelatorioSitfis(token, contratanteCnpj, documentoEmpresa, protocolo);
    if (r.pronto && r.pdfBase64) return r.pdfBase64;
    await new Promise((resolve) => setTimeout(resolve, (r.tempoEsperaSegundos || 5) * 1000));
  }
  throw new Error("O relatório de situação fiscal não ficou pronto a tempo — tente de novo em alguns minutos.");
}

// ===================== DCTFWeb — estrutura pronta, idServico NÃO confirmado ainda =====================
// Diferente do PGDASD/SITFIS acima, não consegui confirmar os idServico exatos do DCTFWeb contra a
// documentação oficial (só o nome do módulo — "DCTFWEB" — e que existem operações de consulta de
// declaração/débito). Os valores abaixo são um palpite razoável baseado no padrão dos outros
// serviços (Consultar + sufixo numérico), mas PRECISAM ser confirmados contra o Swagger real antes
// de usar — só é possível acessá-lo com uma conta já contratada. Não chamar em produção sem
// confirmar antes.
export async function consultarDctfWeb(token: TokenIntegraContador, contratanteCnpj: string, cnpjEmpresa: string, periodoApuracao: string): Promise<any> {
  const r = await chamarServico(token, {
    base: "Consultar",
    contratanteCnpj,
    contribuinteDocumento: cnpjEmpresa,
    idSistema: "DCTFWEB",
    idServico: "CONSRECIBO32", // não confirmado — ver comentário acima
    versaoSistema: "1.0",
    dados: { periodoApuracao },
  });
  return r.dados;
}

// ===================== PARCSN (Integra Parcelamento — Simples Nacional ordinário) — confirmado na
// documentação oficial (apicenter.estaleiro.serpro.gov.br/documentacao/api-integra-contador/pt/
// solucoes/integra-parcelamento/parcsn/), lançado pela SERPRO em nov/2024.
//
// IMPORTANTE — diferente do que o nome "Integra Parcelamento" sugere, NÃO existe serviço de
// simulação nem de adesão a um parcelamento novo por API — a Receita não expõe isso. A adesão em si
// (aceitar entrada, escolher quantidade de parcelas) só existe no e-CAC, é feita pelo escritório fora
// deste sistema. O que a API oferece é só CONSULTA de um parcelamento que já existe + EMISSÃO da guia
// de uma parcela específica — por isso o fluxo aqui é "vincular um parcelamento já concedido", não
// "solicitar/simular um parcelamento novo".
export interface ParcelamentoResumo {
  numero: number;
  dataDoPedido: string | null; // AAAAMMDD
  situacao: string | null;
  dataDaSituacao: string | null;
}
// Lista os parcelamentos (de qualquer situação, inclusive já encerrados) que já existem pra essa
// empresa na Receita — usado só pra o escritório escolher qual número vincular, sem precisar digitar
// às cegas.
export async function consultarPedidosParcelamento(token: TokenIntegraContador, contratanteCnpj: string, cnpjEmpresa: string): Promise<ParcelamentoResumo[]> {
  const r = await chamarServico(token, {
    base: "Consultar",
    contratanteCnpj,
    contribuinteDocumento: cnpjEmpresa,
    idSistema: "PARCSN",
    idServico: "PEDIDOSPARC163",
    versaoSistema: "1.0",
    dados: {},
  });
  const lista = r.dados?.parcelamentos || r.dados?.listaParcelamentos || [];
  return (Array.isArray(lista) ? lista : []).map((p: any) => ({
    numero: p.numero,
    dataDoPedido: p.dataDoPedido || null,
    situacao: p.situacao || null,
    dataDaSituacao: p.dataDaSituacao || null,
  }));
}
export interface ParcelamentoDetalhado extends ParcelamentoResumo {
  valorTotalConsolidado: number | null;
  quantidadeParcelas: number | null;
  valorPrimeiraParcela: number | null;
  valorParcelaBasica: number | null;
  detalhesJson: any; // payload cru da Receita (detalhesConsolidacao, demonstrativoPagamentos etc.) — guardado sem perder nada, mesmo o que este código ainda não usa pra decidir nada
}
// Detalhes completos de UM parcelamento específico (já concedido) — usado tanto pra vincular quanto
// pra atualizar o resumo mostrado ao escritório/cliente.
export async function consultarParcelamentoEspecifico(token: TokenIntegraContador, contratanteCnpj: string, cnpjEmpresa: string, numeroParcelamento: number): Promise<ParcelamentoDetalhado> {
  const r = await chamarServico(token, {
    base: "Consultar",
    contratanteCnpj,
    contribuinteDocumento: cnpjEmpresa,
    idSistema: "PARCSN",
    idServico: "OBTERPARC164",
    versaoSistema: "1.0",
    dados: { numeroParcelamento },
  });
  const d = r.dados || {};
  const cons = d.consolidacaoOriginal || d.consolidacao || {};
  return {
    numero: d.numero ?? numeroParcelamento,
    dataDoPedido: d.dataDoPedido || null,
    situacao: d.situacao || null,
    dataDaSituacao: d.dataDaSituacao || null,
    valorTotalConsolidado: cons.valorTotalConsolidado ?? null,
    quantidadeParcelas: cons.quantidadeParcelas ?? null,
    valorPrimeiraParcela: cons.primeiraParcela ?? null,
    valorParcelaBasica: cons.parcelaBasica ?? null,
    detalhesJson: d,
  };
}
// Emite a guia (DAS) de UMA parcela específica (mês AAAAMM) de um parcelamento já concedido — mesmo
// mecanismo usado pra "gerar a parcela de entrada" (é só a parcela do mês em que o parcelamento foi
// vinculado) quanto pras parcelas seguintes, buscadas pela mesma rotina automática mensal que já
// busca o DAS normal.
export async function emitirParcelaParcelamento(token: TokenIntegraContador, contratanteCnpj: string, cnpjEmpresa: string, anoMesParcela: number): Promise<{ pdfBase64: string | null }> {
  const r = await chamarServico(token, {
    base: "Emitir",
    contratanteCnpj,
    contribuinteDocumento: cnpjEmpresa,
    idSistema: "PARCSN",
    idServico: "GERARDAS161",
    versaoSistema: "1.0",
    dados: { parcelaParaEmitir: anoMesParcela },
  });
  return { pdfBase64: r.dados?.docArrecadacaoPdfB64 || null };
}
