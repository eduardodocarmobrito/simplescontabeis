// Teste do gerador do LCDPR contra os exemplos de preenchimento do próprio manual da Receita
// (ADE COPES 1/2020). Roda com: npx tsx src/lcdpr-teste.ts
//
// Os registros de cadastro (0000, 0030, 0040, 0045, 0050) são comparados caractere a caractere com
// as linhas publicadas no manual — é o jeito mais direto de garantir que a ordem dos campos, o
// preenchimento dos vazios e o formato dos percentuais estão certos.
//
// O Q100/Q200 do manual tem o saldo começando em R$ 1.000 (o exemplo da página 27 mostra entrada de
// 10.000 fechando com saldo 11.000), o que contraria a regra escrita na própria página 25 — "o saldo
// inicial a ser registrado é zero no início de cada ano". Aqui vale a regra escrita, então esses dois
// registros são conferidos com números próprios.

import { gerarLcdpr, validarLcdpr, type LcdprParams } from "./lcdpr";

let falhas = 0;
function conferir(nome: string, obtido: string | number, esperado: string | number) {
  if (String(obtido) === String(esperado)) {
    console.log(`  ok   ${nome}`);
  } else {
    falhas++;
    console.log(`  FALHA ${nome}`);
    console.log(`        esperado: ${esperado}`);
    console.log(`        obtido:   ${obtido}`);
  }
}

// ---------------------------------------------------------------------------
// Caso 1: cadastros idênticos aos exemplos do manual
// ---------------------------------------------------------------------------
const paramsManual: LcdprParams = {
  anoCalendario: 2019,
  declarante: {
    cpf: "111.111.111-91",
    nome: "JOSÉ DA SILVA",
    endereco: "RUA TESTE",
    numero: "1234",
    complemento: "BLOCO Z SALA 301",
    bairro: "BAIRRO LCDPR",
    uf: "DF",
    codMunicipio: "5300108",
    cep: "71000-000",
    telefone: "(61) 3333-3333",
    email: "testeLCDPR@LCDPR.com.br",
  },
  formaApuracao: 1,
  indicadorInicioPeriodo: 0,
  situacaoEspecial: 0,
  dataSituacaoEspecial: null,
  dataInicio: "2019-01-01",
  dataFim: "2019-12-31",
  imoveis: [
    {
      codImovel: 1,
      pais: "BR",
      moeda: "BRL",
      cadItr: "12345678",
      caepf: "12345678901234",
      inscricaoEstadual: "12345678901234",
      nome: "Fazenda Tudo Certo",
      endereco: "Rodovia BR 999, Km 3000",
      numero: null,
      complemento: null,
      bairro: "Distrito do Meio",
      uf: "DF",
      codMunicipio: "5300108",
      cep: "71000000",
      tipoExploracao: 2,
      participacao: 50,
    },
    {
      codImovel: 2,
      pais: "BR",
      moeda: "BRL",
      cadItr: "87654321",
      caepf: null,
      inscricaoEstadual: null,
      nome: "Fazenda Dois",
      endereco: "Estrada Vicinal",
      numero: null,
      complemento: null,
      bairro: "Zona Rural",
      uf: "DF",
      codMunicipio: "5300108",
      cep: "71000000",
      tipoExploracao: 4,
      participacao: 94.8,
    },
  ],
  terceiros: [{ codImovel: 2, tipoContraparte: 3, idContraparte: "123.456.789-12", nome: "JOÃO DE SOUSA", percentual: 5.2 }],
  contas: [{ codConta: 1, pais: "BR", banco: "999", nomeBanco: "Banco LCDPR", agencia: "1234", numeroConta: "0000000123456789" }],
  lancamentos: [],
  signatario: { nome: "JOSE DE SOUZA", cpfCnpj: "123.456.789-12", crc: "AL123456O", email: "testeLCDPR@LCDPR.com.br", telefone: "(61) 3333-3333" },
};

console.log("\nCaso 1 — registros de cadastro conferidos com os exemplos do manual:");
const r1 = gerarLcdpr(paramsManual);
const linhas1 = r1.conteudo.split("\r\n").filter(Boolean);

conferir("0000 (abertura)", linhas1[0], "0000|LCDPR|0013|11111111191|JOSÉ DA SILVA|0|0||01012019|31122019");
conferir("0010 (forma de apuração)", linhas1[1], "0010|1");
conferir(
  "0030 (dados cadastrais)",
  linhas1[2],
  "0030|RUA TESTE|1234|BLOCO Z SALA 301|BAIRRO LCDPR|DF|5300108|71000000|6133333333|testeLCDPR@LCDPR.com.br"
);
conferir(
  "0040 (imóvel, campos vazios no meio)",
  linhas1[3],
  "0040|001|BR|BRL|12345678|12345678901234|12345678901234|Fazenda Tudo Certo|Rodovia BR 999, Km 3000|||Distrito do Meio|DF|5300108|71000000|2|05000"
);
// 0045 é filho do 0040 e tem que vir logo DEPOIS do imóvel a que se refere — aqui, o segundo.
conferir("0045 vem depois do 0040 do imóvel 002", linhas1[5], "0045|002|3|12345678912|JOÃO DE SOUSA|00520");
conferir("0050 (conta bancária)", linhas1[6], "0050|001|BR|999|Banco LCDPR|1234|0000000123456789");
conferir("9999 (encerramento) é a última linha", linhas1[linhas1.length - 1], "9999|JOSE DE SOUZA|12345678912|AL123456O|testeLCDPR@LCDPR.com.br|6133333333|8");
conferir("QTD_LIN conta todas as linhas, inclusive a própria", linhas1.length, 8);
conferir("participação 94,8% sai com 2 casas e 5 dígitos", linhas1[4].split("|")[16], "09480");
conferir("arquivo termina com CRLF", JSON.stringify(r1.conteudo.slice(-2)), JSON.stringify("\r\n"));
conferir("nenhuma linha termina com pipe", linhas1.some((l) => l.endsWith("|")) ? "alguma termina" : "nenhuma", "nenhuma");

// ---------------------------------------------------------------------------
// Caso 2: bloco Q — saldo acumulado, natureza do saldo e resumo mensal
// ---------------------------------------------------------------------------
console.log("\nCaso 2 — bloco Q (saldo acumulado começando em zero, conforme a regra do manual):");
const paramsQ: LcdprParams = {
  ...paramsManual,
  imoveis: [paramsManual.imoveis[0]],
  terceiros: [],
  lancamentos: [
    // Janeiro: entra 10.000 de venda, sai 8.500 de insumo -> saldo 1.500
    { data: "2019-01-02", codImovel: 1, codConta: 1, numDoc: "123", tipoDoc: 1, historico: "Venda de 100 sacas de milho", idParticipante: "12345678912", natureza: "receita", valor: 10000 },
    { data: "2019-01-15", codImovel: 1, codConta: 1, numDoc: "456", tipoDoc: 1, historico: "Sementes e outros insumos", idParticipante: "12345678000121", natureza: "custeio", valor: 8500 },
    // Fevereiro: entra 9.000, sai 9.300 -> mês negativo em 300, acumulado 1.200
    { data: "2019-02-10", codImovel: 1, codConta: 1, numDoc: "789", tipoDoc: 1, historico: "Venda de bezerros", idParticipante: "12345678912", natureza: "receita", valor: 9000 },
    { data: "2019-02-20", codImovel: 1, codConta: 0, numDoc: null, tipoDoc: 6, historico: "Taxa de emissao de GTA", idParticipante: "12345678000121", natureza: "custeio", valor: 9300 },
    // Março: investimento de 5.000 derruba o acumulado pra -3.800 (testa o NAT_SLD_FIN = N)
    { data: "2019-03-05", codImovel: 1, codConta: 999, numDoc: "900", tipoDoc: 1, historico: "Aquisicao de trator", idParticipante: "98765432000199", natureza: "investimento", valor: 5000 },
  ],
};
const r2 = gerarLcdpr(paramsQ);
const q100 = r2.conteudo.split("\r\n").filter((l) => l.startsWith("Q100"));
const q200 = r2.conteudo.split("\r\n").filter((l) => l.startsWith("Q200"));

conferir("Q100 nº 1 (receita: entrada, saldo 1.000.000 centavos)", q100[0], "Q100|02012019|001|001|123|1|Venda de 100 sacas de milho|12345678912|1|1000000|0|1000000|P");
conferir("Q100 nº 2 (custeio: saída, saldo acumulado 1.500,00)", q100[1], "Q100|15012019|001|001|456|1|Sementes e outros insumos|12345678000121|2|0|850000|150000|P");
conferir("Q100 pago em espécie usa conta 000", q100[3].split("|")[3], "000");
conferir("Q100 por numerário em trânsito usa conta 999", q100[4].split("|")[3], "999");
conferir("Q100 com saldo negativo marca NAT_SLD_FIN = N", q100[4].split("|")[12], "N");
conferir("Q100 saldo negativo vai em módulo (sem sinal)", q100[4].split("|")[11], "380000");
conferir("Q200 janeiro (10.000 entrada, 8.500 saída, acumulado 1.500)", q200[0], "Q200|012019|1000000|850000|150000|P");
conferir("Q200 fevereiro traz o acumulado, não o saldo do mês", q200[1], "Q200|022019|900000|930000|120000|P");
conferir("Q200 março fecha negativo", q200[2], "Q200|032019|0|500000|380000|N");
conferir("total de entradas", r2.totalEntradas.toFixed(2), "19000.00");
conferir("total de saídas", r2.totalSaidas.toFixed(2), "22800.00");
conferir("saldo final", r2.saldoFinal.toFixed(2), "-3800.00");

// ---------------------------------------------------------------------------
// Caso 3: formatação de valores e sanitização de campos
// ---------------------------------------------------------------------------
console.log("\nCaso 3 — formatação de valores e campos que não podem quebrar o arquivo:");
const r3 = gerarLcdpr({
  ...paramsQ,
  lancamentos: [
    // Pipe e quebra de linha no histórico quebrariam o arquivo inteiro; centavos têm que arredondar.
    { data: "2019-05-07", codImovel: 1, codConta: 1, numDoc: "A|1", tipoDoc: 3, historico: "Frete | boiada\nsegunda viagem", idParticipante: "12345678912", natureza: "custeio", valor: 1129998.994 },
  ],
});
const q3 = r3.conteudo.split("\r\n").filter((l) => l.startsWith("Q100"))[0];
conferir("pipe no histórico foi trocado por barra", q3.split("|")[6], "Frete / boiada segunda viagem");
conferir("pipe no número do documento também", q3.split("|")[4], "A/1");
conferir("R$ 1.129.998,99 -> 112999899 centavos", q3.split("|")[10], "112999899");
conferir("histórico não contém quebra de linha", /[\r\n]/.test(q3.split("|")[6]) ? "contém" : "não contém", "não contém");
// 1,005 é o caso que o float estraga: em double ele é 1.00499999999999989, e um round direto
// devolveria 100 (R$ 1,00) em vez de 101 (R$ 1,01).
const q100Centavo = (valor: number) =>
  gerarLcdpr({ ...paramsQ, lancamentos: [{ ...paramsQ.lancamentos[0], valor }] }).conteudo
    .split("\r\n")
    .filter((l) => l.startsWith("Q100"))[0]
    .split("|")[9];
conferir("1,005 arredonda pro centavo mais próximo (R$ 1,01)", q100Centavo(1.005), "101");
conferir("2,675 arredonda pro centavo mais próximo (R$ 2,68)", q100Centavo(2.675), "268");
conferir("8,165 arredonda pro centavo mais próximo (R$ 8,17)", q100Centavo(8.165), "817");
conferir("234,567 -> 23457 (exemplo do manual)", q100Centavo(234.567), "23457");
conferir("1.123,453 -> 112345 (exemplo do manual)", q100Centavo(1123.453), "112345");
conferir("10.000,00 -> 1000000 (exemplo do manual)", q100Centavo(10000), "1000000");
conferir("0,010 -> 1 centavo (exemplo do manual)", q100Centavo(0.01), "1");

// ---------------------------------------------------------------------------
// Caso 4: validação que impede gerar arquivo recusado pelo e-CAC
// ---------------------------------------------------------------------------
console.log("\nCaso 4 — validação das pendências:");
const semNada = validarLcdpr({
  ...paramsManual,
  declarante: { ...paramsManual.declarante, cpf: "123", codMunicipio: "" },
  imoveis: [],
  terceiros: [],
  lancamentos: [],
});
conferir("CPF inválido vira erro", semNada.some((x) => x.gravidade === "erro" && /CPF do produtor/.test(x.mensagem)) ? "sim" : "não", "sim");
conferir("sem imóvel vira erro", semNada.some((x) => x.gravidade === "erro" && /Nenhum imóvel/.test(x.mensagem)) ? "sim" : "não", "sim");
conferir("sem lançamento é só aviso", semNada.some((x) => x.gravidade === "aviso" && /Nenhum lançamento/.test(x.mensagem)) ? "sim" : "não", "sim");

const lancamentoRuim = validarLcdpr({
  ...paramsQ,
  lancamentos: [
    { data: "2018-12-31", codImovel: 1, codConta: 1, numDoc: null, tipoDoc: 1, historico: "Fora do ano", idParticipante: "12345678912", natureza: "receita", valor: 100 },
    { data: "2019-06-01", codImovel: 77, codConta: 1, numDoc: null, tipoDoc: 1, historico: "Imóvel inexistente", idParticipante: "12345678912", natureza: "receita", valor: 100 },
    { data: "2019-06-02", codImovel: 1, codConta: 55, numDoc: null, tipoDoc: 1, historico: "Conta inexistente", idParticipante: "12345678912", natureza: "receita", valor: 100 },
    { data: "2019-06-03", codImovel: 1, codConta: 1, numDoc: null, tipoDoc: 1, historico: "Participante faltando", idParticipante: "", natureza: "receita", valor: 100 },
  ],
});
conferir("data fora do ano-calendário vira erro", lancamentoRuim.some((x) => /fora do ano-calendário/.test(x.mensagem)) ? "sim" : "não", "sim");
conferir("imóvel não cadastrado vira erro", lancamentoRuim.some((x) => /imóvel que não está cadastrado/.test(x.mensagem)) ? "sim" : "não", "sim");
conferir("conta não cadastrada vira erro", lancamentoRuim.some((x) => /conta bancária que não está cadastrada/.test(x.mensagem)) ? "sim" : "não", "sim");
conferir("participante sem CPF/CNPJ vira erro", lancamentoRuim.some((x) => /CPF\/CNPJ do participante/.test(x.mensagem)) ? "sim" : "não", "sim");
// Conta 000/999 são do leiaute e nunca podem ser cadastradas como conta de banco.
conferir(
  "cadastrar conta com código reservado vira erro",
  validarLcdpr({ ...paramsQ, contas: [{ codConta: 999, pais: "BR", banco: "001", nomeBanco: "X", agencia: "1", numeroConta: "1" }] }).some((x) => /reservado pelo leiaute/.test(x.mensagem)) ? "sim" : "não",
  "sim"
);
conferir("lançamento válido não gera erro", validarLcdpr(paramsQ).filter((x) => x.gravidade === "erro").length, 0);

console.log(falhas === 0 ? `\n✅ Todos os testes passaram.\n` : `\n❌ ${falhas} teste(s) falharam.\n`);
process.exit(falhas === 0 ? 0 : 1);
