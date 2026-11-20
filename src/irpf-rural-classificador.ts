// Classificação dos documentos que caem na caixa de entrada do módulo IRPF / Atividade Rural.
//
// Estratégia híbrida, nesta ordem (a primeira que resolve, resolve — IA só no que sobra):
//   1. XML de NF-e/NFC-e  -> determinístico. Emitente/destinatário, CFOP, finNFe e NCM dizem tudo:
//      quem vendeu pra quem, se é devolução e se a compra é insumo (custeio) ou bem (investimento).
//      Zero chute e zero custo.
//   2. OFX de extrato     -> determinístico (o parser já existe em ofx.ts). Vira candidato a
//      conciliação, não lançamento direto: extrato é a contraprova do livro caixa, não a fonte dele.
//   3. Texto do PDF       -> regras. Cobre o que tem forma fixa e aparece todo mês: DANFE com chave
//      de acesso de 44 dígitos, guia/taxa de GTA (ADEPARÁ e congêneres), DARF/GPS, boleto de energia.
//   4. O que sobrou       -> Claude. Recibo torto, nota de um emissor estranho, foto de documento.
//
// A regra de ouro do módulo: nada disso lança nada sozinho no livro caixa definitivo. Tudo vira
// PRÉVIA, com a confiança e o motor que decidiram, pro contador aprovar ou corrigir. Correção vira
// regra aprendida (tabela rural_regras), então o mesmo fornecedor não erra duas vezes.

import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { XMLParser } from "fast-xml-parser";
import type { NaturezaLancamento } from "./lcdpr";

const xmlParser = new XMLParser({ attributeNamePrefix: "@_", textNodeName: "value", ignoreAttributes: false, parseAttributeValue: false, parseTagValue: false, trimValues: true });

// Tipos de documento que o módulo reconhece na v1 (foco em atividade rural).
export type TipoDocumentoRural =
  | "nfe_venda" // NF-e emitida pelo produtor: receita
  | "nfe_compra_insumo" // NF-e recebida, insumo/serviço: despesa de custeio
  | "nfe_compra_bem" // NF-e recebida, bem do ativo: investimento
  | "nfe_devolucao_venda" // devolução de venda que o produtor fez: abate receita
  | "nfe_devolucao_compra" // devolução de compra: abate despesa
  | "taxa_gta" // taxa de emissão de GTA / guia de trânsito animal
  | "guia_tributo" // DARF, GPS, ITR, FUNRURAL, INSS rural
  | "recibo_despesa" // recibo de serviço, frete, diária
  | "folha_pagamento"
  | "extrato_bancario"
  | "contrato" // arrendamento, parceria, comodato
  | "outro";

export interface ClassificacaoDocumento {
  tipo: TipoDocumentoRural;
  natureza: NaturezaLancamento | null; // null = não vira lançamento (extrato, contrato)
  data: string | null; // "YYYY-MM-DD"
  valor: number | null; // reais, sempre positivo
  numDoc: string | null;
  tipoDoc: number | null; // TIPO_DOC do LCDPR: 1 NF, 2 fatura, 3 recibo, 4 contrato, 5 folha, 6 outros
  participanteDoc: string | null; // CPF/CNPJ da contraparte
  participanteNome: string | null;
  historico: string | null;
  confianca: number; // 0..1 — abaixo de CONFIANCA_MINIMA o documento fica na aba "Conferir"
  motor: "xml" | "ofx" | "regra" | "ia" | "regra_aprendida";
  observacao: string | null; // o que o contador precisa olhar (ex.: "compra de gado: confirmar se é matriz")
  chaveAcesso?: string | null;
}

// Prévia com confiança abaixo disto não se mistura com as que estão prontas pra aprovar em lote.
export const CONFIANCA_MINIMA = 0.75;

const soDigitos = (v: unknown) => String(v ?? "").replace(/\D+/g, "");

// ---------------------------------------------------------------------------
// 1. XML de NF-e
// ---------------------------------------------------------------------------

// CFOPs de devolução/retorno. Lista em vez de heurística porque a família "x.2xx" tem exceções
// (5.209 é devolução, mas 5.251 é venda de energia) e errar aqui inverte o sinal do lançamento.
const CFOP_DEVOLUCAO = new Set([
  // entradas: devolução de venda que o produtor fez
  "1201", "1202", "1203", "1204", "1208", "1209", "1410", "1411", "1503", "1504", "1505", "1506", "1553", "1660", "1661", "1662",
  "2201", "2202", "2203", "2204", "2208", "2209", "2410", "2411", "2503", "2504", "2505", "2506", "2553", "2660", "2661", "2662",
  // saídas: devolução de compra que o produtor fez
  "5201", "5202", "5205", "5206", "5207", "5208", "5209", "5210", "5410", "5411", "5412", "5413", "5503", "5553", "5555", "5556", "5660", "5661", "5662",
  "6201", "6202", "6205", "6206", "6207", "6208", "6209", "6210", "6410", "6411", "6412", "6413", "6503", "6553", "6555", "6556", "6660", "6661", "6662",
]);
// CFOPs de entrada que indicam bem do ativo imobilizado (investimento, não custeio).
const CFOP_ATIVO_IMOBILIZADO = new Set(["1551", "2551", "3551", "1552", "2552", "1553", "2553"]);
// NCM cujo capítulo indica bem durável (trator, implemento, veículo, benfeitoria metálica).
const NCM_CAPITULO_BEM = new Set(["84", "85", "87", "73", "94"]);

interface NfeResumo {
  chave: string | null;
  numero: string | null;
  serie: string | null;
  dataEmissao: string | null;
  natOp: string | null;
  tpNF: string | null; // 0 entrada, 1 saída
  finNFe: string | null; // 1 normal, 2 complementar, 3 ajuste, 4 devolução/retorno
  emitDoc: string | null;
  emitNome: string | null;
  destDoc: string | null;
  destNome: string | null;
  valorTotal: number;
  cfops: string[];
  ncms: string[];
  descricoes: string[];
}

export function lerXmlNfe(xml: string): NfeResumo | null {
  let json: any;
  try {
    json = xmlParser.parse(xml);
  } catch {
    return null;
  }
  const infNFe = json?.nfeProc?.NFe?.infNFe || json?.NFe?.infNFe;
  if (!infNFe) return null;
  const ide = infNFe.ide || {};
  const emit = infNFe.emit || {};
  const dest = infNFe.dest || {};
  const dets = Array.isArray(infNFe.det) ? infNFe.det : infNFe.det ? [infNFe.det] : [];
  const chave = String(infNFe["@_Id"] || "").replace(/^NFe/, "") || null;
  const dh = String(ide.dhEmi || ide.dEmi || "");
  return {
    chave,
    // O número da nota está na própria chave (posições 26 a 34), então sai certo mesmo em XML
    // de resumo que não traz o grupo <ide> completo.
    numero: ide.nNF ? String(ide.nNF) : chave && chave.length === 44 ? String(Number(chave.slice(25, 34))) : null,
    serie: ide.serie != null ? String(ide.serie) : null,
    dataEmissao: /^\d{4}-\d{2}-\d{2}/.test(dh) ? dh.slice(0, 10) : null,
    natOp: ide.natOp ? String(ide.natOp) : null,
    tpNF: ide.tpNF != null ? String(ide.tpNF) : null,
    finNFe: ide.finNFe != null ? String(ide.finNFe) : null,
    emitDoc: soDigitos(emit.CNPJ || emit.CPF) || null,
    emitNome: emit.xNome ? String(emit.xNome) : null,
    destDoc: soDigitos(dest.CNPJ || dest.CPF) || null,
    destNome: dest.xNome ? String(dest.xNome) : null,
    valorTotal: Number(infNFe.total?.ICMSTot?.vNF || 0) || 0,
    cfops: dets.map((d: any) => String(d?.prod?.CFOP || "")).filter(Boolean),
    ncms: dets.map((d: any) => String(d?.prod?.NCM || "")).filter(Boolean),
    descricoes: dets.map((d: any) => String(d?.prod?.xProd || "")).filter(Boolean),
  };
}

/**
 * Classifica uma NF-e em relação ao produtor (identificado pelo CPF/CNPJ). Determinístico.
 * `docsDoProdutor` aceita vários documentos porque produtor rural costuma ter o mesmo CPF com uma
 * inscrição estadual por fazenda, e às vezes um CNPJ de pessoa jurídica rural no meio.
 */
export function classificarNfe(n: NfeResumo, docsDoProdutor: string[]): ClassificacaoDocumento {
  const meus = new Set(docsDoProdutor.map(soDigitos).filter(Boolean));
  const souEmitente = !!n.emitDoc && meus.has(n.emitDoc);
  const souDestinatario = !!n.destDoc && meus.has(n.destDoc);
  const ehDevolucao = n.finNFe === "4" || n.cfops.some((c) => CFOP_DEVOLUCAO.has(c)) || /devolu/i.test(n.natOp || "");

  const contraparteDoc = souEmitente ? n.destDoc : n.emitDoc;
  const contraparteNome = souEmitente ? n.destNome : n.emitNome;
  const descricao = n.descricoes.slice(0, 3).join(", ").slice(0, 160);
  const base = {
    data: n.dataEmissao,
    valor: n.valorTotal || null,
    numDoc: n.numero,
    tipoDoc: 1, // NF-e é sempre "1 - Nota Fiscal" no TIPO_DOC do LCDPR
    participanteDoc: contraparteDoc,
    participanteNome: contraparteNome,
    motor: "xml" as const,
    chaveAcesso: n.chave,
  };

  // Nenhum dos lados é o produtor: a nota chegou aqui por engano (ou o cadastro está incompleto).
  if (!souEmitente && !souDestinatario) {
    return {
      ...base,
      tipo: "outro",
      natureza: null,
      historico: `NF-e ${n.numero || ""} - ${n.natOp || descricao}`.trim(),
      confianca: 0.3,
      observacao: `Esta NF-e não tem o produtor nem como emitente nem como destinatário (emitente ${n.emitDoc || "?"}, destinatário ${n.destDoc || "?"}). Confira se o CPF/CNPJ do produtor está completo no cadastro.`,
    };
  }

  if (ehDevolucao) {
    const devolucaoDeVenda = souDestinatario; // a mercadoria que eu vendi está voltando pra mim
    return {
      ...base,
      tipo: devolucaoDeVenda ? "nfe_devolucao_venda" : "nfe_devolucao_compra",
      natureza: devolucaoDeVenda ? "devolucao" : "receita",
      historico: `Devolução ${devolucaoDeVenda ? "de venda" : "de compra"} - NF-e ${n.numero || ""} ${contraparteNome || ""}`.trim(),
      confianca: 0.9,
      observacao: devolucaoDeVenda
        ? "Devolução de venda: entra como saída no livro caixa e é destacada no demonstrativo pra abater da receita bruta."
        : "Devolução de compra: o dinheiro volta, então entra como receita. Confira se a despesa original já foi lançada.",
    };
  }

  if (souEmitente) {
    return {
      ...base,
      tipo: "nfe_venda",
      natureza: "receita",
      historico: `Venda - NF-e ${n.numero || ""} ${descricao || n.natOp || ""}`.trim(),
      confianca: 0.95,
      observacao: null,
    };
  }

  // Compra: insumo (custeio) ou bem do ativo (investimento)?
  const ehBemPorCfop = n.cfops.some((c) => CFOP_ATIVO_IMOBILIZADO.has(c));
  const ehBemPorNcm = n.ncms.some((ncm) => NCM_CAPITULO_BEM.has(soDigitos(ncm).slice(0, 2)));
  const ehBem = ehBemPorCfop || ehBemPorNcm;
  // Gado vivo (NCM 0102) comprado pode ser custeio (recria/engorda) ou investimento (matriz/
  // reprodutor) — o XML não diz, e a diferença muda a ficha do IRPF. Marca pro contador olhar.
  const temGado = n.ncms.some((ncm) => soDigitos(ncm).startsWith("0102"));
  return {
    ...base,
    tipo: ehBem ? "nfe_compra_bem" : "nfe_compra_insumo",
    natureza: ehBem ? "investimento" : "custeio",
    historico: `${ehBem ? "Aquisição de bem" : "Compra"} - NF-e ${n.numero || ""} ${descricao || ""}`.trim(),
    confianca: ehBemPorCfop ? 0.9 : ehBem ? 0.8 : 0.88,
    observacao: temGado
      ? "Compra de animais: confirme se é recria/engorda (despesa de custeio) ou matriz/reprodutor (investimento) — o XML não distingue."
      : ehBemPorNcm && !ehBemPorCfop
        ? "Classificado como investimento pelo NCM (máquina/veículo/estrutura). Se for peça de reposição ou manutenção, mude para custeio."
        : null,
  };
}

// ---------------------------------------------------------------------------
// 3. Regras sobre o texto do documento
// ---------------------------------------------------------------------------

const RE_CNPJ = /\b(\d{2})[.\s]?(\d{3})[.\s]?(\d{3})[/\s]?(\d{4})[-\s]?(\d{2})\b/;
const RE_CPF = /\b(\d{3})[.\s]?(\d{3})[.\s]?(\d{3})[-\s]?(\d{2})\b/;
const RE_CHAVE_44 = /\b(\d[\s.]?){44}\b/;
// "R$ 1.234,56" ou "1.234,56" — pega o maior valor do documento como candidato a total.
const RE_VALOR = /(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*,\d{2})\b/g;
const RE_DATA = /\b(\d{2})[/.-](\d{2})[/.-](\d{4})\b/;

function maiorValorNoTexto(texto: string): number | null {
  const achados = [...texto.matchAll(RE_VALOR)].map((m) => Number(m[1].replace(/\./g, "").replace(",", ".")));
  const validos = achados.filter((v) => Number.isFinite(v) && v > 0);
  return validos.length ? Math.max(...validos) : null;
}
function primeiraDataNoTexto(texto: string): string | null {
  const m = RE_DATA.exec(texto);
  if (!m) return null;
  const [, dia, mes, ano] = m;
  const n = Number(ano);
  if (n < 2000 || n > 2100) return null;
  return `${ano}-${mes}-${dia}`;
}

/**
 * Regras sobre texto puro. Só devolve resultado quando tem certeza razoável — o resto vai pra IA.
 */
export function classificarPorRegra(texto: string): ClassificacaoDocumento | null {
  const t = texto.replace(/\s+/g, " ");
  const tn = t.toLowerCase();
  const cnpj = RE_CNPJ.exec(t);
  const cpf = RE_CPF.exec(t);
  const docContraparte = cnpj ? soDigitos(cnpj[0]) : cpf ? soDigitos(cpf[0]) : null;
  const valor = maiorValorNoTexto(t);
  const data = primeiraDataNoTexto(t);

  // GTA (Guia de Trânsito Animal) e a taxa cobrada pelo órgão estadual pra emitir — despesa de
  // custeio clássica de pecuária, e some no meio de um monte de recibo parecido. No Pará o órgão é
  // a ADEPARÁ; os nomes dos congêneres de outros estados entram na mesma regra.
  const ehGta =
    /\bgta\b/.test(tn) ||
    /gui[ao] de tr[âa]nsito animal/.test(tn) ||
    (/(adepar[áa]|adapec|iagro|idaron|agrodefesa|indea|adab|adaf|adaperj|idaf|seapa|defesa agropecu[áa]ria)/.test(tn) &&
      /(taxa|guia|emiss[ãa]o|\bdae\b|documento de arrecada)/.test(tn));
  if (ehGta) {
    return {
      tipo: "taxa_gta",
      natureza: "custeio",
      data,
      valor,
      numDoc: null,
      tipoDoc: 6, // "6 - Outros": guia de arrecadação não é NF, fatura nem recibo
      participanteDoc: docContraparte,
      participanteNome: null,
      historico: "Taxa de emissão de GTA - defesa agropecuária",
      confianca: valor && data ? 0.85 : 0.6,
      motor: "regra",
      observacao: valor && data ? null : "Não consegui ler o valor e/ou a data com segurança — confira no documento.",
    };
  }

  // DARF / GPS / FUNRURAL / ITR — tributo. O manual do LCDPR manda usar no participante o CPF/CNPJ
  // do contribuinte sujeito passivo do tributo (ou seja, o próprio produtor), não o do órgão.
  if (/\b(darf|documento de arrecada[çc][ãa]o de receitas federais|gps|guia da previd[êe]ncia|funrural|senar|itr\b|imposto sobre a propriedade territorial rural)/.test(tn)) {
    return {
      tipo: "guia_tributo",
      natureza: "custeio",
      data,
      valor,
      numDoc: null,
      tipoDoc: 6,
      participanteDoc: null, // preenchido depois com o CPF do próprio produtor
      participanteNome: null,
      historico: /funrural|senar/.test(tn) ? "FUNRURAL/SENAR sobre a receita rural" : /itr/.test(tn) ? "ITR - imposto territorial rural" : "Tributo sobre a atividade rural",
      confianca: valor && data ? 0.8 : 0.55,
      motor: "regra",
      observacao: "No LCDPR o participante de um pagamento de tributo é o próprio contribuinte — preenchi com o CPF do produtor.",
    };
  }

  // DANFE: tem chave de acesso de 44 dígitos. Sem o XML não dá pra saber o sentido da operação com
  // segurança, então devolve o que deu e deixa a IA/contador fechar.
  const chave = RE_CHAVE_44.exec(t);
  if (chave && /danfe|documento auxiliar da nota fiscal/.test(tn)) {
    return {
      tipo: "outro",
      natureza: null,
      data,
      valor,
      numDoc: null,
      tipoDoc: 1,
      participanteDoc: docContraparte,
      participanteNome: null,
      historico: "DANFE (espelho de NF-e)",
      confianca: 0.5,
      motor: "regra",
      observacao: "É o espelho em PDF de uma NF-e. Se puder, suba o XML no lugar — aí a classificação fica exata (emitente, CFOP, devolução e tipo de item).",
      chaveAcesso: soDigitos(chave[0]).slice(0, 44),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// 4. Claude: o que a regra não resolveu
// ---------------------------------------------------------------------------

const MODELO_IA = "claude-opus-5-5";

const SCHEMA_CLASSIFICACAO = {
  type: "object",
  additionalProperties: false,
  properties: {
    tipo: {
      type: "string",
      enum: [
        "nfe_venda",
        "nfe_compra_insumo",
        "nfe_compra_bem",
        "nfe_devolucao_venda",
        "nfe_devolucao_compra",
        "taxa_gta",
        "guia_tributo",
        "recibo_despesa",
        "folha_pagamento",
        "extrato_bancario",
        "contrato",
        "outro",
      ],
      description: "O que o documento é.",
    },
    natureza: {
      type: ["string", "null"],
      enum: ["receita", "receita_adiantamento", "custeio", "investimento", "devolucao", null],
      description:
        "Como entra no livro caixa da atividade rural. 'receita' = dinheiro que entrou pela venda da produção. 'custeio' = despesa corrente (insumo, combustível, mão de obra, frete, taxa, energia, manutenção). 'investimento' = aquisição de bem durável ou benfeitoria (trator, implemento, veículo, cerca, curral, matriz/reprodutor). 'devolucao' = devolução de venda. null quando o documento não vira lançamento (extrato, contrato).",
    },
    data: { type: ["string", "null"], description: "Data do documento no formato YYYY-MM-DD. null se não achar." },
    valor: { type: ["number", "null"], description: "Valor total em reais, positivo, com centavos. null se não achar." },
    num_doc: { type: ["string", "null"], description: "Número do documento (nota, recibo, guia). null se não houver." },
    tipo_doc: {
      type: ["integer", "null"],
      description: "Tipo de documento no leiaute do LCDPR: 1 nota fiscal, 2 fatura, 3 recibo, 4 contrato, 5 folha de pagamento, 6 outros.",
    },
    participante_doc: { type: ["string", "null"], description: "CPF (11 dígitos) ou CNPJ (14 dígitos) da contraparte, só dígitos. null se não achar." },
    participante_nome: { type: ["string", "null"], description: "Nome ou razão social da contraparte." },
    historico: { type: "string", description: "Histórico curto do lançamento, em português, até 120 caracteres. Descreva o que foi comprado/vendido/pago." },
    confianca: { type: "number", description: "De 0 a 1: o quanto você confia nesta classificação. Use abaixo de 0.7 quando o documento estiver ilegível, ambíguo ou faltando dados." },
    observacao: { type: ["string", "null"], description: "O que o contador precisa conferir à mão. null se não houver nada a apontar." },
  },
  required: ["tipo", "natureza", "data", "valor", "num_doc", "tipo_doc", "participante_doc", "participante_nome", "historico", "confianca", "observacao"],
} as const;

const PROMPT_SISTEMA = `Você classifica documentos de um produtor rural brasileiro para a escrituração do Livro Caixa da Atividade Rural (IRPF / LCDPR). Trabalha num escritório de contabilidade.

Contexto do que costuma aparecer:
- Notas fiscais de venda de gado, bezerro, boi gordo, grãos, leite — receita.
- Notas de compra de insumo: ração, sal mineral, vacina, semente, adubo, defensivo, combustível, peça, arame — despesa de custeio.
- Notas de compra de bem durável: trator, implemento, caminhonete, motor, bomba, estrutura de curral, cerca — investimento.
- Taxa de emissão de GTA (Guia de Trânsito Animal) cobrada pelo órgão estadual de defesa agropecuária (ADEPARÁ no Pará, e congêneres) — custeio.
- Guias de tributo: DARF, GPS, FUNRURAL, SENAR, ITR — custeio.
- Recibos de frete, diária de vaqueiro, serviço de máquina, assistência veterinária — custeio.
- Notas de devolução — devolução.
- Extratos bancários e contratos de arrendamento/parceria/comodato — não viram lançamento (natureza null).

Regras que importam:
- O valor é o total do documento, em reais, sempre positivo.
- A data é a data de emissão/pagamento do documento.
- A contraparte é a outra parte da operação, nunca o próprio produtor.
- Quando a compra for de animais, não decida sozinho entre custeio e investimento: classifique como custeio e diga na observação que o contador precisa confirmar se é matriz/reprodutor.
- Se o documento estiver ilegível, cortado ou faltando o valor, use confiança baixa e explique na observação. É melhor devolver confiança baixa do que inventar um número.
- Nunca invente CPF, CNPJ, valor ou data que não estejam no documento. Quando não achar, devolva null.`;

let clienteIa: Anthropic | null = null;
function obterCliente(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!clienteIa) clienteIa = new Anthropic();
  return clienteIa;
}
export function iaDisponivel(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export interface EntradaIa {
  texto: string | null; // texto extraído do PDF (quando tem camada de texto ou OCR deu certo)
  arquivo: { buffer: Buffer; mime: string } | null; // usado quando o texto não serve (scan ruim, foto)
  nomeArquivo: string;
}

/**
 * Última etapa: manda o documento pro Claude e recebe a classificação estruturada.
 * Devolve null quando não há chave de API configurada ou quando a chamada falha — nesse caso o
 * documento fica em "Não identificado" pro contador resolver à mão, nunca travando a importação.
 */
export async function classificarComIa(entrada: EntradaIa): Promise<ClassificacaoDocumento | null> {
  const client = obterCliente();
  if (!client) return null;

  // Texto curto demais = PDF escaneado sem camada de texto e com OCR ruim. Aí vale mais mandar o
  // arquivo e deixar o modelo olhar a imagem do que mandar um texto picotado.
  const textoUtil = (entrada.texto || "").replace(/\s+/g, " ").trim();
  const conteudo: Anthropic.ContentBlockParam[] = [];
  if (textoUtil.length >= 80) {
    conteudo.push({
      type: "text",
      text: `Arquivo: ${entrada.nomeArquivo}\n\nTexto extraído do documento:\n\n${textoUtil.slice(0, 60000)}`,
    });
  } else if (entrada.arquivo) {
    const dados = entrada.arquivo.buffer.toString("base64");
    if (entrada.arquivo.mime === "application/pdf") {
      conteudo.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: dados } });
    } else if (/^image\/(png|jpe?g|gif|webp)$/.test(entrada.arquivo.mime)) {
      conteudo.push({
        type: "image",
        source: { type: "base64", media_type: entrada.arquivo.mime as "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: dados },
      });
    } else {
      return null;
    }
    conteudo.push({ type: "text", text: `Arquivo: ${entrada.nomeArquivo}` });
  } else {
    return null;
  }
  conteudo.push({ type: "text", text: "Classifique este documento para o livro caixa da atividade rural." });

  try {
    const resposta = await client.messages.parse({
      model: MODELO_IA,
      max_tokens: 4000,
      // Classificação é tarefa de volume e não ganha com raciocínio longo — esforço baixo mantém
      // o custo por documento no chão sem perder qualidade nesse tipo de extração.
      output_config: { effort: "low", format: jsonSchemaOutputFormat(SCHEMA_CLASSIFICACAO) },
      system: PROMPT_SISTEMA,
      messages: [{ role: "user", content: conteudo }],
    });
    if (resposta.stop_reason === "refusal") return null;
    const r = resposta.parsed_output;
    if (!r) return null;
    const valor = typeof r.valor === "number" && Number.isFinite(r.valor) && r.valor > 0 ? Math.abs(r.valor) : null;
    const data = typeof r.data === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.data) ? r.data : null;
    const participante = r.participante_doc ? soDigitos(r.participante_doc) : null;
    return {
      tipo: r.tipo as TipoDocumentoRural,
      natureza: (r.natureza as NaturezaLancamento | null) ?? null,
      data,
      valor,
      numDoc: r.num_doc ? String(r.num_doc).slice(0, 60) : null,
      tipoDoc: typeof r.tipo_doc === "number" && r.tipo_doc >= 1 && r.tipo_doc <= 6 ? r.tipo_doc : 6,
      participanteDoc: participante && (participante.length === 11 || participante.length === 14) ? participante : null,
      participanteNome: r.participante_nome ? String(r.participante_nome).slice(0, 120) : null,
      historico: String(r.historico || "").slice(0, 200) || null,
      // Falta de valor ou data derruba a confiança seja qual for a nota que o modelo deu: sem esses
      // dois campos o lançamento não fecha, e não adianta a classificação estar certa.
      confianca: Math.max(0, Math.min(1, Number(r.confianca) || 0)) * (valor && data ? 1 : 0.5),
      motor: "ia",
      observacao: r.observacao ? String(r.observacao).slice(0, 400) : null,
    };
  } catch {
    return null;
  }
}
