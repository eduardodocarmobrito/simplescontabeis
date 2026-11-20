// Gerador do arquivo digital do LCDPR (Livro Caixa Digital do Produtor Rural) — leiaute 1.3.
//
// Fonte: Manual de Preenchimento do LCDPR, anexo ao Ato Declaratório Executivo COPES nº 1/2020
// (https://www.gov.br/receitafederal/pt-br/assuntos/orientacao-tributaria/declaracoes-e-demonstrativos/
//  lcdpr-livro-caixa-digital-do-produtor-rural/manual-de-preenchimento-do-lcdpr-1-3) — lido campo a
// campo em nov/2026 pra escrever este arquivo. O leiaute 1.3 vale pro ano-calendário 2019 em diante
// (ADE Copes 1/2020) e, até a data desta implementação, não houve versão posterior publicada.
//
// Pontos do manual que ditam o formato (e que são fáceis de errar):
//  - Texto puro em UTF-8, campos separados por "|" (pipe), SEM pipe no fim da linha, e cada linha
//    termina com CRLF (\r\n). Campo vazio = dois pipes seguidos.
//  - Valores monetários: inteiro em centavos, sem separador de milhar, sem vírgula e sem sinal
//    (R$ 11.299,98 -> 1129998). Percentual com 2 casas no mesmo esquema (50% -> 05000).
//  - Datas: ddmmaaaa. Períodos (Q200): mmaaaa.
//  - 0000.COD_VER = "0013" (versão 1.3).
//  - Q100.SLD_FIN é o saldo ACUMULADO do livro (começa em zero a cada ano) e NAT_SLD_FIN é "P"/"N".
//    Como o campo não aceita sinal, o valor vai em módulo e o sinal mora no NAT_SLD_FIN.
//  - Q200.SLD_FIN é o acumulado ATÉ o mês (não o saldo do mês isolado).
//  - 9999.QTD_LIN conta TODAS as linhas do arquivo, inclusive o próprio 9999 e os repetidos.
//
// Importante (checado no FAQ oficial da Receita antes de construir isto): o LCDPR é entregue pelo
// e-CAC e NÃO é importado pelo programa do IRPF — a resposta nº 9 do FAQ diz textualmente que "ainda
// não é possível a importação dos dados de um arquivo LCDPR diretamente para a Declaração de Ajuste
// Anual". O programa que o IRPF importa é outro (LCAR), e a Receita não publica leiaute dele. Por
// isso este módulo gera o arquivo do e-CAC e o resto do sistema gera o demonstrativo pra conferência
// e digitação na ficha Atividade Rural.

export type NaturezaLancamento = "receita" | "receita_adiantamento" | "custeio" | "investimento" | "devolucao";

export interface LcdprImovel {
  codImovel: number; // sequencial 1..999 (vai pro arquivo com 3 dígitos)
  pais: string; // "BR"
  moeda: string; // "BRL"
  cadItr: string | null; // CAFIR/NIRF com DV (8 dígitos)
  caepf: string | null; // 14 dígitos
  inscricaoEstadual: string | null;
  nome: string;
  endereco: string;
  numero: string | null;
  complemento: string | null;
  bairro: string;
  uf: string;
  codMunicipio: string; // 7 dígitos (IBGE)
  cep: string;
  tipoExploracao: number; // 1 individual, 2 condomínio, 3 arrendado, 4 parceria, 5 comodato, 6 outros
  participacao: number; // percentual, ex. 100 ou 50.5
}

export interface LcdprTerceiro {
  codImovel: number;
  tipoContraparte: number; // 1 condômino, 2 arrendador, 3 parceiro, 4 comodante, 5 outro
  idContraparte: string; // CPF (11) ou CNPJ (14)
  nome: string;
  percentual: number;
}

export interface LcdprConta {
  codConta: number; // sequencial 1..998 — 0 e 999 são reservados (espécie / numerário em trânsito)
  pais: string; // "BR"
  banco: string | null; // código de compensação (3 dígitos)
  nomeBanco: string;
  agencia: string; // sem dígito
  numeroConta: string; // com dígito
}

export interface LcdprLancamento {
  data: string; // "YYYY-MM-DD"
  codImovel: number; // 0 = despesa de condomínio/parceria que afeta vários imóveis (manual permite "000")
  codConta: number; // 0 = espécie, 999 = numerário em trânsito
  numDoc: string | null;
  tipoDoc: number; // 1 NF, 2 fatura, 3 recibo, 4 contrato, 5 folha, 6 outros
  historico: string;
  idParticipante: string; // CPF/CNPJ
  natureza: NaturezaLancamento;
  valor: number; // sempre positivo, em reais; a natureza decide se é entrada ou saída
}

export interface LcdprDeclarante {
  cpf: string;
  nome: string;
  endereco: string;
  numero: string;
  complemento: string | null;
  bairro: string;
  uf: string;
  codMunicipio: string;
  cep: string;
  telefone: string | null;
  email: string;
}

export interface LcdprSignatario {
  nome: string | null;
  cpfCnpj: string | null;
  crc: string | null;
  email: string | null;
  telefone: string | null;
}

export interface LcdprParams {
  anoCalendario: number;
  declarante: LcdprDeclarante;
  // 1 = resultado apurado pelo livro caixa; 2 = presunção de 20% da receita bruta (art. 5º da Lei 8.023/1990)
  formaApuracao: 1 | 2;
  indicadorInicioPeriodo: 0 | 1 | 2; // 0 regular, 1 abertura, 2 início de obrigatoriedade no curso do ano
  situacaoEspecial: 0 | 1 | 2 | 3; // 0 normal, 1 falecimento, 2 espólio, 3 saída definitiva
  dataSituacaoEspecial: string | null; // "YYYY-MM-DD"
  dataInicio: string; // "YYYY-MM-DD" — normalmente 01/01 do ano
  dataFim: string; // "YYYY-MM-DD" — normalmente 31/12 do ano
  imoveis: LcdprImovel[];
  terceiros: LcdprTerceiro[];
  contas: LcdprConta[];
  lancamentos: LcdprLancamento[];
  signatario: LcdprSignatario;
}

// Natureza interna -> TIPO_LANC do Q100. O leiaute só tem três valores e não prevê "devolução":
//  1 = Receita da atividade rural
//  2 = Despesas de custeio e investimentos  (o leiaute junta os dois; a separação custeio x
//      investimento existe só na ficha Atividade Rural do IRPF, e é mantida fora daqui)
//  3 = Receita de produtos entregues no ano referente a adiantamento de recursos financeiros
// Devolução de venda é saída de recurso, então vai como 2 com o histórico explicando — e o
// demonstrativo do IRPF (fora deste arquivo) destaca o valor pra abater da receita bruta.
const TIPO_LANC: Record<NaturezaLancamento, number> = {
  receita: 1,
  receita_adiantamento: 3,
  custeio: 2,
  investimento: 2,
  devolucao: 2,
};
// Natureza que entra dinheiro (VL_ENTRADA) x natureza que sai (VL_SAIDA).
export function naturezaEhEntrada(n: NaturezaLancamento): boolean {
  return n === "receita" || n === "receita_adiantamento";
}

// ---- Formatação dos campos ----

// Arredonda pro centavo mais próximo, em duas etapas de propósito.
//
// `Math.round(valor * 100)` sozinho erra um centavo quando o número não tem representação binária
// exata: 1,005 vira 1.00499999999999989 em double, e o round devolve 100 (R$ 1,00) em vez de 101
// (R$ 1,01). Multiplicar por 100.000, arredondar, dividir por 1.000 e arredondar de novo descola do
// ruído do float antes da decisão do meio, e o resultado bate com o manual (234,567 -> 23457).
// Num arquivo fiscal, um centavo a menos no Q100 desencontra o saldo acumulado de todas as linhas
// seguintes — então vale a conta a mais.
function centavos(valor: number): number {
  return Math.round(Math.round(Math.abs(valor) * 100000) / 1000);
}
// Inteiro em centavos, sem sinal (regra 2.3.3 do manual).
function valorLcdpr(reais: number): string {
  return String(centavos(reais));
}
// Percentual com 2 casas, sem o símbolo: 50% -> "05000", 5,2% -> "00520", 94,8% -> "09480".
function percentualLcdpr(p: number): string {
  return String(centavos(p)).padStart(5, "0");
}
// "YYYY-MM-DD" -> "ddmmaaaa"
function dataLcdpr(iso: string | null): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}${m[2]}${m[1]}` : "";
}
// "YYYY-MM" ou "YYYY-MM-DD" -> "mmaaaa"
function periodoLcdpr(iso: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  return m ? `${m[2]}${m[1]}` : "";
}
// Só os dígitos (CPF/CNPJ/CEP/telefone vêm do cadastro com máscara).
function digitos(v: string | null | undefined): string {
  return String(v || "").replace(/\D+/g, "");
}
// O pipe é o delimitador e o manual proíbe que ele apareça dentro de qualquer campo. Caracteres de
// controle (0 a 31 da tabela ASCII) também são proibidos em campo alfanumérico — e uma quebra de
// linha no meio de um histórico quebraria o arquivo inteiro, então vira espaço.
//
// Pontuação tipográfica (travessão, aspas curvas, apóstrofo curvo, reticências) é trocada pelo
// equivalente ASCII. O manual define campo alfanumérico como "todos os caracteres das posições da
// Tabela ASCII", e esses caracteres estão fora dela — mas acento fica, porque o próprio exemplo
// oficial do registro 0000 traz "JOSÉ DA SILVA". Esse texto chega de duas fontes que podem trazer
// pontuação tipográfica sem ninguém notar: o histórico que o classificador monta e o nome que vem
// no XML da nota.
function texto(v: string | null | undefined, tamanhoMax?: number): string {
  let s = String(v ?? "")
    .replace(/\|/g, "/")
    .replace(/[‐-―−]/g, "-") // travessões e meia-risca -> hífen
    .replace(/[‘’‛′]/g, "'") // apóstrofos curvos
    .replace(/[“”‟″]/g, '"') // aspas curvas
    .replace(/…/g, "...") // reticências
    .replace(/[  -​  　]/g, " ") // espaços não quebráveis e finos
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (tamanhoMax && s.length > tamanhoMax) s = s.slice(0, tamanhoMax);
  return s;
}

function linha(campos: (string | number | null | undefined)[]): string {
  return campos.map((c) => (c == null ? "" : String(c))).join("|");
}

export interface LcdprResultado {
  conteudo: string; // o arquivo inteiro (UTF-8, linhas com CRLF)
  qtdLinhas: number;
  totalEntradas: number; // em reais
  totalSaidas: number;
  saldoFinal: number; // entradas - saídas (pode ser negativo)
  resumoMensal: { mes: string; entradas: number; saidas: number; saldoAcumulado: number }[];
}

/**
 * Monta o arquivo do LCDPR 1.3 inteiro. Os lançamentos são ordenados por data (e, dentro do mesmo
 * dia, pela ordem em que chegaram) porque o saldo acumulado de cada Q100 depende dessa ordem.
 */
export function gerarLcdpr(p: LcdprParams): LcdprResultado {
  const linhas: string[] = [];
  const d = p.declarante;

  // ---- Registro 0000: abertura e identificação ----
  linhas.push(
    linha([
      "0000",
      "LCDPR",
      "0013",
      digitos(d.cpf),
      texto(d.nome),
      p.indicadorInicioPeriodo,
      p.situacaoEspecial,
      dataLcdpr(p.dataSituacaoEspecial),
      dataLcdpr(p.dataInicio),
      dataLcdpr(p.dataFim),
    ])
  );

  // ---- Registro 0010: forma de apuração ----
  linhas.push(linha(["0010", p.formaApuracao]));

  // ---- Registro 0030: dados cadastrais do declarante ----
  linhas.push(
    linha([
      "0030",
      texto(d.endereco, 150),
      texto(d.numero, 6),
      texto(d.complemento, 50),
      texto(d.bairro, 50),
      texto(d.uf, 2).toUpperCase(),
      digitos(d.codMunicipio),
      digitos(d.cep),
      digitos(d.telefone),
      texto(d.email, 115),
    ])
  );

  // ---- Registro 0040 (imóveis) com seus 0045 (terceiros) logo abaixo ----
  // O 0045 é "filho" do 0040 e o manual manda apresentá-lo logo após o 0040 a que se refere.
  for (const im of p.imoveis) {
    linhas.push(
      linha([
        "0040",
        String(im.codImovel).padStart(3, "0"),
        texto(im.pais || "BR", 2).toUpperCase(),
        texto(im.moeda || "BRL", 3).toUpperCase(),
        digitos(im.cadItr),
        digitos(im.caepf),
        digitos(im.inscricaoEstadual),
        texto(im.nome, 50),
        texto(im.endereco, 150),
        texto(im.numero, 6),
        texto(im.complemento, 50),
        texto(im.bairro, 50),
        texto(im.uf, 2).toUpperCase(),
        digitos(im.codMunicipio),
        digitos(im.cep),
        im.tipoExploracao,
        percentualLcdpr(im.participacao),
      ])
    );
    for (const t of p.terceiros.filter((x) => x.codImovel === im.codImovel)) {
      linhas.push(
        linha([
          "0045",
          String(t.codImovel).padStart(3, "0"),
          t.tipoContraparte,
          digitos(t.idContraparte),
          texto(t.nome, 50),
          percentualLcdpr(t.percentual),
        ])
      );
    }
  }

  // ---- Registro 0050: contas bancárias ----
  for (const c of p.contas) {
    linhas.push(
      linha([
        "0050",
        String(c.codConta).padStart(3, "0"),
        texto(c.pais || "BR", 3).toUpperCase(),
        digitos(c.banco).padStart(3, "0"),
        texto(c.nomeBanco, 30),
        digitos(c.agencia),
        digitos(c.numeroConta),
      ])
    );
  }

  // ---- Bloco Q: Q100 (lançamento a lançamento) e Q200 (resumo mensal) ----
  const ordenados = [...p.lancamentos].sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  let saldo = 0; // acumulado do ano; começa em zero (regra do manual)
  let totalEntradas = 0;
  let totalSaidas = 0;
  // Resumo por mês, na ordem cronológica em que os meses aparecem.
  const meses = new Map<string, { entradas: number; saidas: number }>();

  for (const l of ordenados) {
    const entrada = naturezaEhEntrada(l.natureza) ? Math.abs(l.valor) : 0;
    const saida = naturezaEhEntrada(l.natureza) ? 0 : Math.abs(l.valor);
    saldo += entrada - saida;
    totalEntradas += entrada;
    totalSaidas += saida;
    const mes = l.data.slice(0, 7);
    const acc = meses.get(mes) || { entradas: 0, saidas: 0 };
    acc.entradas += entrada;
    acc.saidas += saida;
    meses.set(mes, acc);
    linhas.push(
      linha([
        "Q100",
        dataLcdpr(l.data),
        String(l.codImovel).padStart(3, "0"),
        String(l.codConta).padStart(3, "0"),
        texto(l.numDoc),
        l.tipoDoc,
        texto(l.historico),
        digitos(l.idParticipante),
        TIPO_LANC[l.natureza],
        valorLcdpr(entrada),
        valorLcdpr(saida),
        valorLcdpr(saldo),
        saldo < 0 ? "N" : "P",
      ])
    );
  }

  // Q200 vai em ordem de mês, com o saldo ACUMULADO até aquele mês (não o saldo do mês isolado).
  const resumoMensal: LcdprResultado["resumoMensal"] = [];
  let acumulado = 0;
  for (const mes of [...meses.keys()].sort()) {
    const v = meses.get(mes)!;
    acumulado += v.entradas - v.saidas;
    resumoMensal.push({ mes, entradas: v.entradas, saidas: v.saidas, saldoAcumulado: acumulado });
    linhas.push(
      linha(["Q200", periodoLcdpr(mes), valorLcdpr(v.entradas), valorLcdpr(v.saidas), valorLcdpr(acumulado), acumulado < 0 ? "N" : "P"])
    );
  }

  // ---- Registro 9999: signatário e encerramento ----
  // QTD_LIN conta todas as linhas do arquivo, incluindo esta própria — daí o +1.
  const s = p.signatario;
  linhas.push(
    linha([
      "9999",
      texto(s.nome),
      digitos(s.cpfCnpj),
      texto(s.crc),
      texto(s.email, 115),
      digitos(s.telefone),
      linhas.length + 1,
    ])
  );

  return {
    conteudo: linhas.join("\r\n") + "\r\n",
    qtdLinhas: linhas.length,
    totalEntradas,
    totalSaidas,
    saldoFinal: totalEntradas - totalSaidas,
    resumoMensal,
  };
}

export interface LcdprPendencia {
  gravidade: "erro" | "aviso";
  mensagem: string;
}

/**
 * Confere o que a Receita exige ANTES de gerar o arquivo, pra o erro aparecer na tela do contador e
 * não na validação do e-CAC depois do upload. "erro" impede a geração; "aviso" deixa gerar.
 */
export function validarLcdpr(p: LcdprParams): LcdprPendencia[] {
  const out: LcdprPendencia[] = [];
  const erro = (mensagem: string) => out.push({ gravidade: "erro", mensagem });
  const aviso = (mensagem: string) => out.push({ gravidade: "aviso", mensagem });
  const d = p.declarante;

  if (digitos(d.cpf).length !== 11) erro("CPF do produtor inválido ou não informado (o registro 0000 exige 11 dígitos).");
  if (!texto(d.nome)) erro("Nome do produtor não informado (registro 0000).");
  for (const [campo, rotulo] of [
    ["endereco", "Endereço"],
    ["numero", "Número"],
    ["bairro", "Bairro"],
    ["uf", "UF"],
    ["codMunicipio", "Código do município"],
    ["cep", "CEP"],
    ["email", "E-mail"],
  ] as const) {
    if (!texto(d[campo] as string)) erro(`${rotulo} do produtor não informado — o registro 0030 exige esse campo.`);
  }
  if (digitos(d.codMunicipio) && digitos(d.codMunicipio).length !== 7)
    erro("Código do município do produtor precisa ter 7 dígitos (tabela do IBGE).");

  if (!p.imoveis.length) erro("Nenhum imóvel rural cadastrado — sem o registro 0040 não há como vincular os lançamentos.");
  const codsImovel = new Set<number>();
  for (const im of p.imoveis) {
    if (codsImovel.has(im.codImovel)) erro(`Código de imóvel ${im.codImovel} repetido — cada imóvel precisa de um código próprio.`);
    codsImovel.add(im.codImovel);
    if (!texto(im.nome)) erro(`Imóvel ${im.codImovel}: nome não informado.`);
    if ((im.pais || "BR").toUpperCase() === "BR") {
      if (!digitos(im.cadItr)) erro(`Imóvel "${im.nome || im.codImovel}": NIRF/CAFIR (cadastro do ITR) é obrigatório para imóvel no Brasil.`);
      if (!texto(im.uf) || !digitos(im.codMunicipio) || !digitos(im.cep))
        erro(`Imóvel "${im.nome || im.codImovel}": UF, código do município e CEP são obrigatórios.`);
    }
    if (!(im.participacao > 0)) erro(`Imóvel "${im.nome || im.codImovel}": percentual de participação na exploração precisa ser maior que zero.`);
    if (im.tipoExploracao === 1 && !digitos(im.caepf))
      aviso(`Imóvel "${im.nome || im.codImovel}": exploração individual sem CAEPF — o manual exige o CAEPF nesse caso.`);
    if (im.tipoExploracao !== 1 && !p.terceiros.some((t) => t.codImovel === im.codImovel))
      aviso(`Imóvel "${im.nome || im.codImovel}": exploração coletiva (condomínio/parceria/arrendamento) sem nenhuma contraparte cadastrada no registro 0045.`);
  }

  const codsConta = new Set<number>();
  for (const c of p.contas) {
    if (c.codConta === 0 || c.codConta === 999)
      erro(`Código de conta ${c.codConta} é reservado pelo leiaute (000 = espécie, 999 = numerário em trânsito) e não pode ser usado por uma conta cadastrada.`);
    if (codsConta.has(c.codConta)) erro(`Código de conta ${c.codConta} repetido.`);
    codsConta.add(c.codConta);
    if (!digitos(c.banco)) erro(`Conta ${c.codConta} (${c.nomeBanco || "sem nome"}): código de compensação do banco não informado.`);
    if (!digitos(c.agencia) || !digitos(c.numeroConta)) erro(`Conta ${c.codConta} (${c.nomeBanco || "sem nome"}): agência e número da conta são obrigatórios.`);
  }

  if (!p.lancamentos.length) aviso("Nenhum lançamento no período — o arquivo sairia só com os cadastros.");
  const ano = String(p.anoCalendario);
  for (const l of p.lancamentos) {
    const ref = `${l.data} · ${texto(l.historico).slice(0, 40) || "sem histórico"}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(l.data)) erro(`Lançamento (${ref}): data inválida.`);
    else if (l.data.slice(0, 4) !== ano) erro(`Lançamento (${ref}): a data está fora do ano-calendário ${ano}.`);
    if (l.codImovel !== 0 && !codsImovel.has(l.codImovel)) erro(`Lançamento (${ref}): aponta um imóvel que não está cadastrado.`);
    if (l.codConta !== 0 && l.codConta !== 999 && !codsConta.has(l.codConta))
      erro(`Lançamento (${ref}): aponta uma conta bancária que não está cadastrada.`);
    const idp = digitos(l.idParticipante);
    if (idp.length !== 11 && idp.length !== 14) erro(`Lançamento (${ref}): CPF/CNPJ do participante é obrigatório e precisa ter 11 ou 14 dígitos.`);
    if (!texto(l.historico)) erro(`Lançamento (${ref}): histórico é obrigatório.`);
    if (!(Math.abs(l.valor) > 0)) erro(`Lançamento (${ref}): valor zerado.`);
    if (![1, 2, 3, 4, 5, 6].includes(l.tipoDoc)) erro(`Lançamento (${ref}): tipo de documento inválido.`);
  }

  if (!texto(p.signatario.nome) || !digitos(p.signatario.cpfCnpj))
    aviso("Signatário (contador) não informado no registro 9999 — os campos são opcionais no leiaute, mas o e-CAC costuma cobrar.");

  return out;
}
