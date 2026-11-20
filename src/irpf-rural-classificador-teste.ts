// Teste do classificador determinístico (XML de NF-e e regras de texto).
// Roda com: npx tsx src/irpf-rural-classificador-teste.ts
// Não chama a API da Claude — só a parte determinística, que é a que decide a maioria dos documentos.

import { lerXmlNfe, classificarNfe, classificarPorRegra } from "./irpf-rural-classificador";

let falhas = 0;
function conferir(nome: string, obtido: unknown, esperado: unknown) {
  if (String(obtido) === String(esperado)) console.log(`  ok   ${nome}`);
  else {
    falhas++;
    console.log(`  FALHA ${nome}\n        esperado: ${esperado}\n        obtido:   ${obtido}`);
  }
}

const CPF_PRODUTOR = "11111111191";
const MEUS = [CPF_PRODUTOR];

// Monta um XML de NF-e com o mínimo que o classificador lê.
function xmlNfe(o: {
  chave?: string;
  natOp: string;
  tpNF: string;
  finNFe?: string;
  emitDoc: string;
  emitTag?: "CNPJ" | "CPF";
  emitNome: string;
  destDoc: string;
  destTag?: "CNPJ" | "CPF";
  destNome: string;
  vNF: string;
  itens: { cfop: string; ncm: string; xProd: string }[];
}) {
  const chave = o.chave || "15190111111111191155001000001234550000012341";
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe${chave}" versao="4.00">
  <ide><nNF>1234</nNF><serie>1</serie><natOp>${o.natOp}</natOp><tpNF>${o.tpNF}</tpNF>${o.finNFe ? `<finNFe>${o.finNFe}</finNFe>` : ""}<dhEmi>2026-03-14T10:22:00-03:00</dhEmi></ide>
  <emit><${o.emitTag || "CNPJ"}>${o.emitDoc}</${o.emitTag || "CNPJ"}><xNome>${o.emitNome}</xNome></emit>
  <dest><${o.destTag || "CNPJ"}>${o.destDoc}</${o.destTag || "CNPJ"}><xNome>${o.destNome}</xNome></dest>
  ${o.itens.map((i, n) => `<det nItem="${n + 1}"><prod><cProd>${n}</cProd><xProd>${i.xProd}</xProd><NCM>${i.ncm}</NCM><CFOP>${i.cfop}</CFOP><qCom>1</qCom><vUnCom>1</vUnCom><vProd>1</vProd></prod></det>`).join("")}
  <total><ICMSTot><vNF>${o.vNF}</vNF></ICMSTot></total>
</infNFe></NFe></nfeProc>`;
}

console.log("\nLeitura do XML:");
const venda = lerXmlNfe(
  xmlNfe({
    natOp: "VENDA DE GADO BOVINO",
    tpNF: "1",
    emitDoc: CPF_PRODUTOR,
    emitTag: "CPF",
    emitNome: "JOSE DA SILVA",
    destDoc: "12345678000121",
    destNome: "FRIGORIFICO BOI FORTE LTDA",
    vNF: "87450.00",
    itens: [{ cfop: "5102", ncm: "01022110", xProd: "BOI GORDO" }],
  })
)!;
conferir("lê o CPF do emitente (produtor é pessoa física)", venda.emitDoc, CPF_PRODUTOR);
conferir("lê o valor total da nota", venda.valorTotal, 87450);
conferir("lê a data de emissão em ISO", venda.dataEmissao, "2026-03-14");
conferir("extrai o número da nota", venda.numero, "1234");
conferir("XML inválido devolve null", lerXmlNfe("não é xml nenhum"), "null");

console.log("\nVenda (produtor é o emitente) -> receita:");
const cVenda = classificarNfe(venda, MEUS);
conferir("tipo", cVenda.tipo, "nfe_venda");
conferir("natureza", cVenda.natureza, "receita");
conferir("participante é o comprador", cVenda.participanteDoc, "12345678000121");
conferir("TIPO_DOC = 1 (nota fiscal)", cVenda.tipoDoc, 1);
conferir("confiança alta", cVenda.confianca >= 0.9 ? "sim" : "não", "sim");
conferir("motor determinístico", cVenda.motor, "xml");

console.log("\nCompra de insumo (produtor é o destinatário) -> custeio:");
const cInsumo = classificarNfe(
  lerXmlNfe(
    xmlNfe({
      natOp: "VENDA DE MERCADORIA",
      tpNF: "1",
      emitDoc: "98765432000199",
      emitNome: "AGROPECUARIA CENTRAL LTDA",
      destDoc: CPF_PRODUTOR,
      destTag: "CPF",
      destNome: "JOSE DA SILVA",
      vNF: "4200.50",
      itens: [{ cfop: "5102", ncm: "23099090", xProd: "RACAO BOVINOS 40KG" }],
    })
  )!,
  MEUS
);
conferir("tipo", cInsumo.tipo, "nfe_compra_insumo");
conferir("natureza", cInsumo.natureza, "custeio");
conferir("participante é o fornecedor", cInsumo.participanteDoc, "98765432000199");

console.log("\nCompra de trator (CFOP de ativo imobilizado) -> investimento:");
const cBem = classificarNfe(
  lerXmlNfe(
    xmlNfe({
      natOp: "VENDA DE ATIVO IMOBILIZADO",
      tpNF: "1",
      emitDoc: "11222333000144",
      emitNome: "MAQUINAS AGRICOLAS SA",
      destDoc: CPF_PRODUTOR,
      destTag: "CPF",
      destNome: "JOSE DA SILVA",
      vNF: "285000.00",
      itens: [{ cfop: "1551", ncm: "87019100", xProd: "TRATOR AGRICOLA 75CV" }],
    })
  )!,
  MEUS
);
conferir("tipo", cBem.tipo, "nfe_compra_bem");
conferir("natureza", cBem.natureza, "investimento");

console.log("\nCompra de peça com NCM de máquina (só o NCM indica bem):");
const cPeca = classificarNfe(
  lerXmlNfe(
    xmlNfe({
      natOp: "VENDA",
      tpNF: "1",
      emitDoc: "11222333000144",
      emitNome: "PECAS E MOTORES LTDA",
      destDoc: CPF_PRODUTOR,
      destTag: "CPF",
      destNome: "JOSE DA SILVA",
      vNF: "1800.00",
      itens: [{ cfop: "1102", ncm: "84139100", xProd: "BOMBA DAGUA PECA" }],
    })
  )!,
  MEUS
);
conferir("natureza (NCM de máquina)", cPeca.natureza, "investimento");
conferir("avisa que pode ser manutenção", /peça de reposição ou manutenção/.test(cPeca.observacao || "") ? "sim" : "não", "sim");

console.log("\nCompra de gado -> custeio, mas com aviso (o XML não distingue matriz de engorda):");
const cGado = classificarNfe(
  lerXmlNfe(
    xmlNfe({
      natOp: "VENDA DE BEZERROS",
      tpNF: "1",
      emitDoc: "22333444000155",
      emitNome: "FAZENDA VIZINHA LTDA",
      destDoc: CPF_PRODUTOR,
      destTag: "CPF",
      destNome: "JOSE DA SILVA",
      vNF: "52000.00",
      itens: [{ cfop: "1102", ncm: "01022190", xProd: "BEZERROS NELORE" }],
    })
  )!,
  MEUS
);
conferir("natureza", cGado.natureza, "custeio");
conferir("aviso sobre matriz/reprodutor", /matriz\/reprodutor/.test(cGado.observacao || "") ? "sim" : "não", "sim");

console.log("\nDevolução de venda (finNFe = 4, produtor é destinatário) -> abate receita:");
const cDevVenda = classificarNfe(
  lerXmlNfe(
    xmlNfe({
      natOp: "DEVOLUCAO DE VENDA",
      tpNF: "0",
      finNFe: "4",
      emitDoc: "12345678000121",
      emitNome: "FRIGORIFICO BOI FORTE LTDA",
      destDoc: CPF_PRODUTOR,
      destTag: "CPF",
      destNome: "JOSE DA SILVA",
      vNF: "9800.00",
      itens: [{ cfop: "1201", ncm: "01022110", xProd: "BOI GORDO - DEVOLUCAO" }],
    })
  )!,
  MEUS
);
conferir("tipo", cDevVenda.tipo, "nfe_devolucao_venda");
conferir("natureza", cDevVenda.natureza, "devolucao");

console.log("\nDevolução de compra (produtor devolve o que comprou) -> dinheiro volta:");
const cDevCompra = classificarNfe(
  lerXmlNfe(
    xmlNfe({
      natOp: "DEVOLUCAO DE COMPRA",
      tpNF: "1",
      finNFe: "4",
      emitDoc: CPF_PRODUTOR,
      emitTag: "CPF",
      emitNome: "JOSE DA SILVA",
      destDoc: "98765432000199",
      destNome: "AGROPECUARIA CENTRAL LTDA",
      vNF: "1200.00",
      itens: [{ cfop: "5202", ncm: "23099090", xProd: "RACAO - DEVOLUCAO" }],
    })
  )!,
  MEUS
);
conferir("tipo", cDevCompra.tipo, "nfe_devolucao_compra");
conferir("natureza", cDevCompra.natureza, "receita");

console.log("\nNota que não é do produtor (cadastro incompleto ou arquivo errado):");
const cAlheia = classificarNfe(
  lerXmlNfe(
    xmlNfe({
      natOp: "VENDA",
      tpNF: "1",
      emitDoc: "55666777000188",
      emitNome: "OUTRA EMPRESA",
      destDoc: "99888777000166",
      destNome: "TERCEIRO QUALQUER",
      vNF: "500.00",
      itens: [{ cfop: "5102", ncm: "10059010", xProd: "MILHO" }],
    })
  )!,
  MEUS
);
conferir("não vira lançamento", cAlheia.natureza, "null");
conferir("confiança baixa", cAlheia.confianca < 0.5 ? "sim" : "não", "sim");
conferir("explica o motivo", /nem como emitente nem como destinatário/.test(cAlheia.observacao || "") ? "sim" : "não", "sim");

console.log("\nProdutor com CPF em várias fazendas e um CNPJ junto:");
const cMulti = classificarNfe(venda, ["00000000000", "11111111191", "33444555000177"]);
conferir("reconhece o CPF entre vários documentos", cMulti.tipo, "nfe_venda");

console.log("\nRegras de texto:");
const gta = classificarPorRegra(
  "ADEPARA - AGENCIA DE DEFESA AGROPECUARIA DO ESTADO DO PARA\nTAXA DE EMISSAO DE GTA - GUIA DE TRANSITO ANIMAL\nCNPJ 05.059.981/0001-80\nData: 14/03/2026\nValor: R$ 42,50"
);
conferir("GTA é reconhecida", gta?.tipo, "taxa_gta");
conferir("GTA é despesa de custeio", gta?.natureza, "custeio");
conferir("lê o valor da taxa", gta?.valor, 42.5);
conferir("lê a data", gta?.data, "2026-03-14");
conferir("TIPO_DOC = 6 (outros, não é NF nem recibo)", gta?.tipoDoc, 6);

const gtaSemAdepara = classificarPorRegra("GUIA DE TRANSITO ANIMAL\nFINALIDADE: ABATE\nEMISSAO: 02/05/2026\nTOTAL R$ 15,00");
conferir("GTA sem o nome do órgão também é reconhecida", gtaSemAdepara?.tipo, "taxa_gta");

const darf = classificarPorRegra("DARF - DOCUMENTO DE ARRECADACAO DE RECEITAS FEDERAIS\nCODIGO 0211\nVENCIMENTO 20/04/2026\nVALOR TOTAL R$ 1.284,37");
conferir("DARF é reconhecido", darf?.tipo, "guia_tributo");
conferir("DARF é custeio", darf?.natureza, "custeio");
conferir("DARF: valor lido", darf?.valor, 1284.37);
conferir("DARF deixa o participante em branco (é o próprio produtor)", darf?.participanteDoc, "null");

const funrural = classificarPorRegra("GUIA DA PREVIDENCIA SOCIAL - GPS\nFUNRURAL E SENAR\nCOMPETENCIA 03/2026\nPAGO EM 15/04/2026\nR$ 2.310,80");
conferir("FUNRURAL/SENAR tem histórico próprio", /FUNRURAL\/SENAR/.test(funrural?.historico || "") ? "sim" : "não", "sim");

const danfe = classificarPorRegra(
  "DANFE - Documento Auxiliar da Nota Fiscal Eletronica\nCHAVE DE ACESSO 1519 0111 1111 1119 1155 0010 0000 1234 5500 0001 2341\nEMISSAO 14/03/2026\nVALOR TOTAL DA NOTA 87.450,00"
);
conferir("DANFE é identificado", /espelho de NF-e/.test(danfe?.historico || "") ? "sim" : "não", "sim");
conferir("DANFE pede o XML (classificação exata)", /suba o XML/.test(danfe?.observacao || "") ? "sim" : "não", "sim");
conferir("DANFE guarda a chave de 44 dígitos", danfe?.chaveAcesso?.length, 44);
conferir("DANFE não vira lançamento sozinho", danfe?.natureza, "null");

conferir("texto sem padrão conhecido devolve null (vai pra IA)", classificarPorRegra("bom dia, segue o combinado. abraço"), "null");

console.log(falhas === 0 ? `\n✅ Todos os testes passaram.\n` : `\n❌ ${falhas} teste(s) falharam.\n`);
process.exit(falhas === 0 ? 0 : 1);
