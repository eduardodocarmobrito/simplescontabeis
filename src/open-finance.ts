// Open Finance / Conciliação bancária — camada de provedor + geração de OFX + regras de conciliação.
//
// Desenho: o escritório NÃO é participante do Open Finance no BC. Consome um AGREGADOR já autorizado
// (Pluggy, Belvo, Klavi…) que, sob consentimento do cliente, entrega saldos e extratos por API. Aqui
// isolamos isso atrás de uma interface `OpenFinanceProvider`, com duas implementações:
//   - MockProvider (sandbox): gera extratos realistas de PJ, determinísticos por empresa+competência,
//     pra testar TODO o fluxo (conectar → puxar → conciliar → exportar) SEM credencial nem custo.
//   - PluggyProvider: adaptador real; ativa sozinho quando PLUGGY_CLIENT_ID/PLUGGY_CLIENT_SECRET
//     estiverem no ambiente. Enquanto não houver chave, cai no Mock — nada no resto do código muda.
//
// A conciliação casa cada transação do extrato com o que já temos no sistema (NF-e, honorários,
// lançamentos) — essa é a vantagem sobre o Open Finance "de fora": o dado de casamento já está aqui.

import type { OfxTransacao } from "./ofx";
export type { OfxTransacao };

export interface OFContaBancaria {
  idExterno: string; // id da conta no agregador (ou sintético no mock)
  banco: string; // nome do banco
  bankId: string; // código Febraban (ISPB/ção curta) — vai no OFX como BANKID
  numero: string; // agência/conta mascarada
  tipo: "CHECKING" | "SAVINGS";
}
export interface OFConsentimento {
  consentId: string;
  status: "ativo" | "revogado" | "expirado";
  validadeAte: string; // ISO date
  contas: OFContaBancaria[];
}
export interface OpenFinanceProvider {
  nome: string;
  modo: "sandbox" | "producao";
  // Cria (ou simula) um consentimento do cliente e devolve as contas autorizadas. opts.bancoId =
  // código Febraban do banco escolhido (BANCOS_OPEN_FINANCE); sem ele, demo com banco qualquer.
  criarConsentimento(empresa: { id: number; nome: string; cnpj: string | null }, opts?: { bancoId?: string }): Promise<OFConsentimento>;
  // Puxa as transações de uma conta num intervalo [dataDe, dataAte] (YYYY-MM-DD).
  listarTransacoes(args: { empresaId: number; conta: OFContaBancaria; dataDe: string; dataAte: string }): Promise<OfxTransacao[]>;
}

// ---------------------------------------------------------------------------------------------------
// Sandbox: gerador determinístico de extrato de PJ.
// ---------------------------------------------------------------------------------------------------
// Bancos oferecidos ao conectar (código Febraban = BANKID no OFX). No sandbox o usuário escolhe qual
// simular; em produção (Pluggy) o mesmo código mapeia o conector/instituição no Open Finance.
export const BANCOS_OPEN_FINANCE: { banco: string; bankId: string }[] = [
  { banco: "Banco do Brasil", bankId: "001" },
  { banco: "Caixa Econômica Federal", bankId: "104" },
  { banco: "Bradesco", bankId: "237" },
  { banco: "Itaú Unibanco", bankId: "341" },
  { banco: "Santander", bankId: "033" },
  { banco: "Sicoob", bankId: "756" },
  { banco: "Sicredi", bankId: "748" },
  { banco: "Cresol", bankId: "133" },
  { banco: "Banco Inter", bankId: "077" },
  { banco: "Banrisul", bankId: "041" },
  { banco: "Nubank", bankId: "260" },
  { banco: "BTG Pactual", bankId: "208" },
];
const BANCOS_MOCK = BANCOS_OPEN_FINANCE;
// PRNG determinístico (mulberry32) a partir de uma semente numérica — mesmo extrato toda vez.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function semente(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function diasNoMes(ano: number, mes: number): number { return new Date(ano, mes, 0).getDate(); }

const CONTRAPARTES_RECEITA = ["COMERCIAL BOA IDEIA LTDA", "AGRO FORTE DISTRIBUIDORA", "SUPERMERCADO UNIAO", "TRANSPORTES RAPIDO SA", "POSTO CENTRAL COMBUSTIVEIS", "CLIENTE PESSOA FISICA"];
const CONTRAPARTES_DESPESA = ["ENERGISA PARA", "CLARO S.A.", "SANEAMENTO MUNICIPAL", "FORNECEDOR INSUMOS LTDA", "ALUGUEL IMOVEL COMERCIAL", "FOLHA DE PAGAMENTO"];

// Gera um extrato realista de PJ pra (empresa, mês). Mistura PIX/TED de entrada, pagamentos (DARF,
// FGTS, boletos, folha), tarifas e uma transferência entre contas. Valores e datas pseudo-aleatórios
// mas estáveis por semente (empresaId + conta + competência).
export function gerarExtratoSandbox(args: { empresaId: number; conta: OFContaBancaria; dataDe: string; dataAte: string }): OfxTransacao[] {
  const { empresaId, conta, dataDe, dataAte } = args;
  const ano = Number(dataDe.slice(0, 4)), mes = Number(dataDe.slice(5, 7));
  const rnd = prng(semente(`${empresaId}|${conta.idExterno}|${dataDe}`));
  const dim = diasNoMes(ano, mes);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
  const valor = (min: number, max: number) => Math.round((min + rnd() * (max - min)) * 100) / 100;
  const dia = () => String(Math.min(dim, 1 + Math.floor(rnd() * dim))).padStart(2, "0");
  const dataAleatoria = () => `${ano}-${String(mes).padStart(2, "0")}-${dia()}`;
  const tx: OfxTransacao[] = [];
  let seq = 0;
  const add = (v: number, descricao: string, tipoOfx: string, data?: string) => {
    const d = data || dataAleatoria();
    tx.push({ fitid: `MOCK${empresaId}${conta.idExterno}${dataDe.replace(/-/g, "")}${String(++seq).padStart(3, "0")}`, data: d, valor: v, descricao, tipoOfx });
  };
  const nReceitas = 4 + Math.floor(rnd() * 6);
  for (let i = 0; i < nReceitas; i++) add(valor(250, 9800), `PIX RECEBIDO - ${pick(CONTRAPARTES_RECEITA)}`, "PIX");
  const nDespesas = 3 + Math.floor(rnd() * 5);
  for (let i = 0; i < nDespesas; i++) add(-valor(120, 4200), `PAGAMENTO - ${pick(CONTRAPARTES_DESPESA)}`, "XFER");
  // Tributos e encargos típicos do mês.
  add(-valor(300, 2500), "PAGAMENTO DARF", "DEBIT");
  add(-valor(200, 1800), "FGTS DIGITAL - GUIA", "DEBIT");
  if (rnd() > 0.4) add(-valor(90, 900), "DAS SIMPLES NACIONAL", "DEBIT");
  // Tarifas bancárias.
  add(-valor(8, 65), "TARIFA PACOTE DE SERVICOS", "FEE");
  if (rnd() > 0.5) add(-valor(2, 15), "TARIFA PIX", "FEE");
  // Transferência entre contas da mesma empresa (pra testar a detecção).
  const t = valor(1000, 5000);
  add(-t, "TRANSFERENCIA ENTRE CONTAS PROPRIAS", "XFER");
  tx.sort((a, b) => a.data.localeCompare(b.data));
  // Respeita o intervalo pedido.
  return tx.filter((x) => x.data >= dataDe && x.data <= dataAte);
}

export class MockProvider implements OpenFinanceProvider {
  nome = "Sandbox (dados de teste)";
  modo = "sandbox" as const;
  async criarConsentimento(empresa: { id: number; nome: string; cnpj: string | null }, opts?: { bancoId?: string }): Promise<OFConsentimento> {
    const escolhido = opts?.bancoId ? BANCOS_OPEN_FINANCE.find((b) => b.bankId === opts.bancoId) : null;
    const validade = new Date(); validade.setMonth(validade.getMonth() + 12);
    const validadeAte = validade.toISOString().slice(0, 10);
    // Banco escolhido: UMA conexão/conta nesse banco (o usuário pode conectar vários, um por vez).
    if (escolhido) {
      const rnd = prng(semente(`consent|${empresa.id}|${escolhido.bankId}`));
      const n = 10000 + Math.floor(rnd() * 89999);
      const contas: OFContaBancaria[] = [
        { idExterno: `acc${empresa.id}-${escolhido.bankId}`, banco: escolhido.banco, bankId: escolhido.bankId, numero: `0001 / ${n}-${empresa.id % 10}`, tipo: "CHECKING" },
      ];
      return { consentId: `mock-consent-${empresa.id}-${escolhido.bankId}-${Date.now()}`, status: "ativo", validadeAte, contas };
    }
    // Sem banco escolhido (demo): 1–2 contas num banco qualquer.
    const rnd = prng(semente(`consent|${empresa.id}`));
    const b1 = BANCOS_MOCK[Math.floor(rnd() * BANCOS_MOCK.length)];
    const contas: OFContaBancaria[] = [
      { idExterno: `acc${empresa.id}a`, banco: b1.banco, bankId: b1.bankId, numero: `0001 / ${10000 + (empresa.id % 90000)}-${empresa.id % 10}`, tipo: "CHECKING" },
    ];
    if (rnd() > 0.5) {
      const b2 = BANCOS_MOCK[(Math.floor(rnd() * BANCOS_MOCK.length) + 1) % BANCOS_MOCK.length];
      contas.push({ idExterno: `acc${empresa.id}b`, banco: b2.banco, bankId: b2.bankId, numero: `0001 / ${20000 + (empresa.id % 90000)}-${(empresa.id + 1) % 10}`, tipo: "CHECKING" });
    }
    return { consentId: `mock-consent-${empresa.id}-${Date.now()}`, status: "ativo", validadeAte, contas };
  }
  async listarTransacoes(args: { empresaId: number; conta: OFContaBancaria; dataDe: string; dataAte: string }): Promise<OfxTransacao[]> {
    return gerarExtratoSandbox(args);
  }
}

// ---------------------------------------------------------------------------------------------------
// Adaptador Pluggy (produção). Ativa quando houver credenciais no ambiente. Mantido como esqueleto
// funcional: a estrutura das chamadas está aqui; ao colocar as chaves e validar os endpoints exatos
// na doc da Pluggy, vira dado real sem mexer no resto do sistema.
// ---------------------------------------------------------------------------------------------------
export function pluggyConfigurado(): boolean {
  return !!(process.env.PLUGGY_CLIENT_ID && process.env.PLUGGY_CLIENT_SECRET);
}
export class PluggyProvider implements OpenFinanceProvider {
  nome = "Pluggy (Open Finance)";
  modo = "producao" as const;
  async criarConsentimento(): Promise<OFConsentimento> {
    throw new Error("Integração Pluggy ainda não finalizada: configure PLUGGY_CLIENT_ID/PLUGGY_CLIENT_SECRET e conclua o fluxo de Connect Token + Item. Enquanto isso, use o modo Sandbox.");
  }
  async listarTransacoes(): Promise<OfxTransacao[]> {
    throw new Error("Integração Pluggy ainda não finalizada. Use o modo Sandbox.");
  }
}

// Provedor ativo: Pluggy quando configurado, senão Sandbox. Deixa o resto do código agnóstico.
export function getProvider(): OpenFinanceProvider {
  return pluggyConfigurado() ? new PluggyProvider() : new MockProvider();
}

// ---------------------------------------------------------------------------------------------------
// Geração de OFX (pra importar no Domínio). Formato OFX 1.0.2 (SGML) — o mais aceito por bancos e
// sistemas contábeis brasileiros, inclusive o módulo de Conciliação Bancária do Domínio.
// ---------------------------------------------------------------------------------------------------
function ofxData(yyyymmdd: string): string { return yyyymmdd.replace(/-/g, "") + "120000[-03:BRT]"; }
function ofxMoney(v: number): string { return v.toFixed(2); }
function ofxEsc(s: string): string { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

export function gerarOfx(args: { bankId: string; acctId: string; dataInicio: string; dataFim: string; transacoes: OfxTransacao[] }): string {
  const { bankId, acctId, dataInicio, dataFim, transacoes } = args;
  const agora = new Date().toISOString().slice(0, 10);
  const trns = transacoes
    .slice()
    .sort((a, b) => a.data.localeCompare(b.data))
    .map((t) => {
      const tipo = t.valor >= 0 ? "CREDIT" : "DEBIT";
      return `<STMTTRN><TRNTYPE>${tipo}<DTPOSTED>${ofxData(t.data)}<TRNAMT>${ofxMoney(t.valor)}<FITID>${ofxEsc(t.fitid)}<MEMO>${ofxEsc(t.descricao)}</STMTTRN>`;
    })
    .join("\n");
  const saldo = transacoes.reduce((a, t) => a + t.valor, 0);
  // Cabeçalho SGML do OFX 1.0.2 + um único extrato bancário (BANKMSGSRSV1).
  return [
    "OFXHEADER:100",
    "DATA:OFXSGML",
    "VERSION:102",
    "SECURITY:NONE",
    "ENCODING:USASCII",
    "CHARSET:1252",
    "COMPRESSION:NONE",
    "OLDFILEUID:NONE",
    "NEWFILEUID:NONE",
    "",
    "<OFX>",
    "<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS>",
    `<DTSERVER>${ofxData(agora)}<LANGUAGE>POR</SONRS></SIGNONMSGSRSV1>`,
    "<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>",
    "<STMTRS><CURDEF>BRL>",
    `<BANKACCTFROM><BANKID>${ofxEsc(bankId)}<ACCTID>${ofxEsc(acctId)}<ACCTTYPE>CHECKING</BANKACCTFROM>`,
    `<BANKTRANLIST><DTSTART>${ofxData(dataInicio)}<DTEND>${ofxData(dataFim)}`,
    trns,
    "</BANKTRANLIST>",
    `<LEDGERBAL><BALAMT>${ofxMoney(saldo)}<DTASOF>${ofxData(dataFim)}</LEDGERBAL>`,
    "</STMTRS></STMTTRNRS></BANKMSGSRSV1>",
    "</OFX>",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------
// Arquivo de LANÇAMENTOS CONTÁBEIS pra importar na Domínio ("Leiaute Domínio Sistemas com Separador").
// Registro 0000 = identificação da empresa + período; registro 6000 = lançamentos em lote (partida
// dobrada: data | conta débito | conta crédito | valor | cód. histórico | complemento). Campos
// separados por "|", data dd/mm/aaaa, valor com vírgula decimal, CRLF por linha.
// OBS: a ordem dos campos do 6000 segue o leiaute com separador da Domínio; validar com 1 importação
// de teste no Domínio do escritório (se recusar, ajusto pela amostra exportada de lá).
// ---------------------------------------------------------------------------------------------------
export interface LancamentoContabil {
  data: string; // ISO AAAA-MM-DD
  contaDebito: string;
  contaCredito: string;
  valor: number; // sempre positivo no arquivo
  historico: string; // complemento do histórico (texto)
  codHistorico?: string; // código de histórico padrão da Domínio (opcional)
}
export function gerarLancamentosDominio(empresa: { codigo?: string; cnpj?: string }, periodo: { inicio: string; fim: string }, lancs: LancamentoContabil[]): string {
  const dt = (iso: string) => { const [a, m, d] = iso.slice(0, 10).split("-"); return `${d}/${m}/${a}`; };
  const money = (v: number) => Math.abs(v).toFixed(2).replace(".", ",");
  const campo = (s: string) => String(s == null ? "" : s).replace(/[|\r\n]+/g, " ").trim();
  const linhas: string[] = [];
  linhas.push(["0000", campo(empresa.codigo || empresa.cnpj || ""), dt(periodo.inicio), dt(periodo.fim)].join("|"));
  for (const l of lancs) {
    linhas.push(["6000", dt(l.data), campo(l.contaDebito), campo(l.contaCredito), money(l.valor), campo(l.codHistorico || ""), campo(l.historico)].join("|"));
  }
  return linhas.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------------------------------
// Classificação e regras de conciliação (puras — o server faz o acesso ao banco).
// ---------------------------------------------------------------------------------------------------
export type TipoMovimento = "pix" | "ted" | "transferencia_propria" | "tarifa" | "tributo" | "boleto" | "outro";
export function classificarMovimento(descricao: string, tipoOfx: string): TipoMovimento {
  const d = (descricao || "").toUpperCase();
  const t = (tipoOfx || "").toUpperCase();
  if (/ENTRE CONTAS PROPRIAS|TRANSFERENCIA PROPRIA|MESMA TITULARIDADE/.test(d)) return "transferencia_propria";
  if (/TARIFA|CESTA|PACOTE DE SERVICOS|IOF/.test(d)) return "tarifa";
  if (/DARF|DAS |DAS\b|FGTS|GPS|GUIA|INSS|ICMS|ISS /.test(d)) return "tributo";
  if (t === "PIX" || /PIX/.test(d)) return "pix";
  if (/BOLETO|TITULO|COBRANCA/.test(d)) return "boleto";
  if (t === "XFER" || /TED|DOC|TRANSFER/.test(d)) return "ted";
  return "outro";
}

export interface RegraConciliacao {
  padrao: string; // texto/regex procurado no descritivo (case-insensitive)
  contaContabil: string; // conta ou código a lançar
  historico: string; // histórico padrão
}
// Aplica as regras do cliente (primeira que casar vence). Retorna a sugestão de conta/histórico.
export function aplicarRegras(descricao: string, regras: RegraConciliacao[]): RegraConciliacao | null {
  const d = (descricao || "").toLowerCase();
  for (const r of regras) {
    const p = (r.padrao || "").trim().toLowerCase();
    if (!p) continue;
    try { if (new RegExp(p, "i").test(descricao)) return r; } catch { if (d.includes(p)) return r; }
  }
  return null;
}

// Casamento exato contra candidatos do próprio sistema (NF-e, honorários, lançamentos): mesmo valor
// (tolerância de centavos) e data próxima (janela de dias). Retorna o candidato casado ou null.
export interface CandidatoCasamento { id: string; origem: string; valor: number; data: string; descricao: string }
export function casarExato(tx: OfxTransacao, candidatos: CandidatoCasamento[], janelaDias = 2): CandidatoCasamento | null {
  const alvo = Math.abs(tx.valor);
  const tData = Date.parse(tx.data);
  let melhor: { c: CandidatoCasamento; dist: number } | null = null;
  for (const c of candidatos) {
    if (Math.abs(Math.abs(c.valor) - alvo) > 0.01) continue;
    const dist = Math.abs((Date.parse(c.data) - tData) / 86400000);
    if (dist > janelaDias) continue;
    if (!melhor || dist < melhor.dist) melhor = { c, dist };
  }
  return melhor ? melhor.c : null;
}
