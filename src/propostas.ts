// Propostas comerciais do pacote "Busca de XML + Auditoria da Reforma Tributária" (Contratos › Propostas).
// O servidor roda a auditoria real das notas de entrada do cliente (reformaCalcularAuditoria) e levanta
// alguns números extras (NFS-e tomadas, exportação, cancelamentos); aqui ficam: a consolidação disso
// numa análise de economia, a sugestão de preço, o cálculo do retorno com desconto/implantação e o
// PDF no papel timbrado (mesmo padrão de reforma-relatorio.ts: img .bg + table.layout).
// Modelo validado com o cliente Grupo Raízes em 2026-11-23 (PDF feito à mão, depois automatizado).

export interface EmpresaEntrada {
  empresa: { id: number; nome: string; cnpj: string; regime: string; regimeLabel: string; tomaCredito: boolean; cidade?: string | null; uf?: string | null; cnae?: string | null };
  auditoria: any; // retorno de reformaCalcularAuditoria(..., semLimite = true, "entrada")
  extras: { nfseTomadas12m: number; nfseTomadasValor12m: number; cteTomados: number; cancelamentos: number; exportacoes12m: number; exportacoesValor12m: number; documentosPeriodo: number };
}

export interface ConfigProposta {
  buscaMensal: number; reformaMensal: number; descontoPct: number; implantacao: number;
  // Desconto próprio (%) e isenção de cada cobrança; descontoPct é o desconto geral, por cima.
  buscaDescontoPct: number; buscaIsento: boolean; reformaDescontoPct: number; reformaIsento: boolean; implantacaoDescontoPct: number; implantacaoIsenta: boolean;
  salarioAnalista: number; dedicacaoPct: number; validadeDias: number; observacoes: string;
}

// ---- Parâmetros de preço e de custo (sugestão; tudo é editável na proposta) ----
export const PRECO_BUSCA_POR_CNPJ = 99;
// Faixas da auditoria pelo volume de NF-e de entrada por mês (somando todos os CNPJs da proposta).
export const FAIXAS_REFORMA: [number, number][] = [[20, 395], [60, 795], [150, 1395], [300, 1995], [Infinity, 2795]];
export const IMPLANTACAO_BASE = 1000, IMPLANTACAO_POR_CNPJ = 500;
export const SALARIO_ANALISTA_PADRAO = 3200;
// Encargos do empregador no Lucro Presumido sobre o salário: INSS patronal + RAT + terceiros 28,8%,
// FGTS 8%, provisão de 13º/férias+1/3 com encargos ≈ 25,7% → fator 1,625; + R$ 600 de benefícios/posto.
export const FATOR_ENCARGOS = 1.625, BENEFICIOS_ANALISTA = 600;
// Tempo de uma conferência manual bem feita (minutos): por item (NCM/vigência, CST×cClassTrib, base pela
// fórmula oficial, alíquota, redução), por nota (baixar/organizar/escriturar), por NFS-e tomada, por
// fornecedor com falha (notificar, cobrar, reconferir) e o relatório do mês. 120 h/mês = analista inteiro
// (o resto da jornada vai em retrabalho, atendimento e rotina).
const MIN_ITEM = 7, MIN_NOTA = 5, MIN_NFSE = 5, MIN_FORNECEDOR = 60, MIN_RELATORIO = 240, HORAS_ANALISTA = 120;

const r2 = (v: number) => Math.round(v * 100) / 100;
const raizCnpj = (c: string) => String(c || "").replace(/\D/g, "").slice(0, 8);

function categoriaNcm(ncm: string | null): string | null {
  const n = String(ncm || "");
  if (!n) return null;
  if (n.startsWith("2710")) return n.startsWith("2710193") ? "lubrificantes" : "combustivel";
  if (/^401[123]/.test(n)) return "pneus";
  if (/^(8708|8409|8413|8421|8483|8482|8481|8511|8512|4016|7318|4010|8714|9026|8544|8536|8507)/.test(n)) return "pecas";
  if (/^(31|3808|1201|1005|2309)/.test(n)) return "insumosAgro";
  if (/^(8432|8433|8701|8429|8424|8436|8704|8716)/.test(n)) return "maquinas";
  return null;
}

const REGRA_EXPLICA: Record<string, { titulo: string; consequencia: string }> = {
  BASE_DIVERGENTE: { titulo: "Base de cálculo do IBS/CBS fora da fórmula oficial", consequencia: "Com a base a menor, o crédito encolhe. Com a base a maior, há crédito inflado e <b>risco de glosa e multa</b> na fiscalização. A SEFAZ ainda não rejeita esse erro na emissão, então a nota passa e o problema fica com o comprador." },
  SEM_INCIDENCIA_EM_VENDA: { titulo: "Venda classificada como \"sem incidência\"", consequencia: "O fornecedor não destacou IBS/CBS numa venda comum. <b>Sem destaque não existe crédito.</b> Em 2027, com a CBS cheia, cada nota assim é dinheiro perdido." },
  GRUPO_AUSENTE: { titulo: "Nota sem o grupo IBS/CBS", consequencia: "O grupo é obrigatório para fornecedor do regime normal desde 03/08/2026. <b>Sem destaque, o crédito de 2027 não tem documento.</b>" },
  SN_SEM_REGIME: { titulo: "Fornecedor do Simples sem informar o regime de IBS/CBS", consequencia: "O crédito fica limitado ao que o fornecedor paga no DAS. Vale negociar a opção pelo regime regular ou um <b>desconto no preço</b>." },
  NCM_NAO_VIGENTE: { titulo: "Produto com NCM vencido na data da emissão", consequencia: "Sem NCM vigente, a tributação do item fica sem amparo: <b>risco de glosa</b> do crédito." },
  NCM_INVALIDO: { titulo: "NCM inexistente", consequencia: "A classificação do produto não existe na tabela oficial: <b>risco de glosa</b> do crédito." },
  NCM_FORA_ANEXO: { titulo: "Redução de alíquota aplicada a NCM fora do anexo", consequencia: "O fornecedor reduziu o imposto sem amparo legal. O crédito destacado fica <b>sujeito a glosa</b>." },
  REDUCAO_ESQUECIDA: { titulo: "Produto com direito a redução tributado integralmente", consequencia: "O imposto cheio vai embutido no preço: <b>o cliente paga mais caro</b> do que deveria." },
  ALIQUOTA_DIVERGENTE: { titulo: "Alíquota de IBS/CBS diferente da oficial", consequencia: "O crédito destacado não confere com a lei: <b>risco de glosa</b> ou crédito a menor." },
  VALOR_DIVERGENTE: { titulo: "Valor do IBS/CBS não confere com base × alíquota", consequencia: "O crédito destacado está errado: <b>risco de glosa</b> ou crédito a menor." },
  CST_X_CCLASSTRIB: { titulo: "CST incompatível com a classificação tributária", consequencia: "Enquadramento inconsistente: o crédito fica <b>em risco</b>." },
  CCLASSTRIB_INEXISTENTE: { titulo: "Classificação tributária (cClassTrib) inexistente", consequencia: "Código que não existe na tabela oficial: o crédito fica <b>em risco</b>." },
};
const REGRA_CURTA: Record<string, string> = {
  BASE_DIVERGENTE: "base divergente", SEM_INCIDENCIA_EM_VENDA: "venda \"sem incidência\"", GRUPO_AUSENTE: "sem grupo IBS/CBS",
  SN_SEM_REGIME: "Simples sem regime de IBS/CBS", NCM_NAO_VIGENTE: "NCM vencido", NCM_INVALIDO: "NCM inexistente", NCM_FORA_ANEXO: "redução fora do anexo",
  REDUCAO_ESQUECIDA: "redução esquecida", ALIQUOTA_DIVERGENTE: "alíquota divergente", VALOR_DIVERGENTE: "valor divergente", CST_X_CCLASSTRIB: "CST × cClassTrib",
};

export function montarAnalise(entradas: EmpresaEntrada[], periodo: { de: string; ate: string; meses: number }) {
  const raizes = new Set(entradas.map((e) => raizCnpj(e.empresa.cnpj)));
  const intra = (cnpj: string) => raizes.has(raizCnpj(cnpj));
  const meses = Math.max(1, periodo.meses);
  const anual = (v: number) => (v * 12) / meses;
  const regras = new Map<string, number>();
  const notificar: any[] = [];
  const gastos: Record<string, number> = { combustivel: 0, lubrificantes: 0, pneus: 0, pecas: 0, insumosAgro: 0, maquinas: 0 };
  const simples = { fornecedores: 0, notas: 0, valor: 0, perdaAno: 0 };
  let ncmsVencidos = 0;
  const empresas = entradas.map(({ empresa, auditoria: d, extras }) => {
    const fornsExternos = (d.fornecedores || []).filter((f: any) => !intra(f.cnpj));
    const fornsIntra = (d.fornecedores || []).filter((f: any) => intra(f.cnpj));
    const notasIntra = fornsIntra.reduce((a: number, f: any) => a + f.notas, 0);
    const notasIntraComFalha = fornsIntra.filter((f: any) => f.alta || f.media).reduce((a: number, f: any) => a + f.notas, 0);
    const notas = d.kpis.notas - notasIntra;
    const notasComFalha = Math.max(0, d.kpis.notas - d.kpis.notasConformes - notasIntraComFalha);
    const perda = empresa.tomaCredito ? fornsExternos.reduce((a: number, f: any) => a + (f.perda2027Anual || 0), 0) : 0;
    for (const a of d.achados || []) {
      if (a.severidade === "info" || intra(a.cnpj)) continue;
      regras.set(a.regra, (regras.get(a.regra) || 0) + 1);
    }
    for (const f of fornsExternos) {
      if (/^(sn_dentro|sn_indefinido|mei)$/.test(f.regime)) { simples.fornecedores++; simples.notas += f.notas; simples.valor += f.valor; simples.perdaAno += empresa.tomaCredito ? f.perda2027Anual || 0 : 0; }
      const falhas = f.alta + f.media;
      const perdaF = empresa.tomaCredito ? f.perda2027Anual || 0 : 0;
      if (!falhas && !perdaF) continue;
      const probs = (f.regras || []).map((r: string) => REGRA_CURTA[r]).filter(Boolean);
      if (!probs.length && /^sn_/.test(f.regime)) probs.push("Simples: crédito limitado ao DAS");
      if (!probs.length && f.regime === "mei") probs.push("MEI não gera crédito");
      if (!probs.length) probs.push("crédito de 2027 não documentado");
      notificar.push({ nome: f.nome, cnpj: f.cnpj, comprador: empresa.nome, compradorCnpj: empresa.cnpj, notas: f.notas, falhas, problema: probs.join("; "), perdaAno: r2(perdaF) });
    }
    for (const n of d.ncms || []) {
      const c = categoriaNcm(n.ncm);
      if (c) gastos[c] += n.valor || 0;
      if (n.status === "ncm_vencido") ncmsVencidos++;
    }
    return {
      id: empresa.id, nome: empresa.nome, cnpj: empresa.cnpj, regime: empresa.regime, regimeLabel: empresa.regimeLabel, tomaCredito: empresa.tomaCredito,
      cidade: empresa.cidade || "", uf: empresa.uf || "", cnae: empresa.cnae || "",
      notas, itens: d.kpis.itens, valor: r2(fornsExternos.reduce((a: number, f: any) => a + f.valor, 0)),
      notasSemFalha: Math.max(0, notas - notasComFalha), notasComFalha,
      fornecedores: fornsExternos.length, fornecedoresComFalha: fornsExternos.filter((f: any) => f.alta || f.media).length,
      perda2027Ano: r2(perda), semNotas: extras.documentosPeriodo === 0, ...extras,
    };
  });
  for (const k of Object.keys(gastos)) gastos[k] = Math.round(anual(gastos[k]));
  notificar.sort((a, b) => b.perdaAno - a.perdaAno || b.falhas - a.falhas || b.notas - a.notas);
  const soma = (f: (e: any) => number) => empresas.reduce((a, e) => a + f(e), 0);
  const totais = {
    cnpjs: empresas.length, notas: soma((e) => e.notas), itens: soma((e) => e.itens), valor: r2(soma((e) => e.valor)),
    fornecedores: soma((e) => e.fornecedores), notasComFalha: soma((e) => e.notasComFalha), fornecedoresComFalha: soma((e) => e.fornecedoresComFalha),
    perda2027Ano: r2(soma((e) => e.perda2027Ano)), nfseTomadas12m: soma((e) => e.nfseTomadas12m), cancelamentos: soma((e) => e.cancelamentos),
    exportacoes12m: soma((e) => e.exportacoes12m), exportacoesValor12m: r2(soma((e) => e.exportacoesValor12m)),
  };
  const notasMes = totais.notas / meses, itensMes = totais.itens / meses, nfseMes = totais.nfseTomadas12m / 12;
  const minutos = itensMes * MIN_ITEM + notasMes * MIN_NOTA + nfseMes * MIN_NFSE + totais.fornecedoresComFalha * MIN_FORNECEDOR + MIN_RELATORIO;
  const horasMes = Math.round(minutos / 60);
  const dedicacaoSugerida = Math.min(100, Math.max(25, Math.ceil((horasMes / HORAS_ANALISTA) * 4) * 25));
  const erros = [...regras.entries()]
    .map(([regra, qtd]) => ({ regra, qtd, titulo: REGRA_EXPLICA[regra]?.titulo || regra, consequencia: REGRA_EXPLICA[regra]?.consequencia || "Erro de preenchimento do IBS/CBS que coloca o crédito em risco." }))
    .sort((a, b) => b.qtd - a.qtd);
  const faixa = FAIXAS_REFORMA.find(([lim]) => notasMes <= lim)![1];
  return {
    geradoEm: new Date().toISOString(), periodo: { ...periodo, meses },
    empresas, totais, erros, notificar: notificar.slice(0, 14), notificarTotal: notificar.length,
    simples: { ...simples, valor: r2(simples.valor), perdaAno: r2(simples.perdaAno) }, gastos, ncmsVencidos,
    volume: { notasMes: Math.round(notasMes), itensMes: Math.round(itensMes), nfseMes: Math.round(nfseMes) },
    horasMes, dedicacaoSugerida,
    perfil: {
      agro: empresas.some((e) => /^01/.test(String(e.cnae).replace(/\D/g, ""))) || gastos.insumosAgro > 0,
      exporta: totais.exportacoes12m > 0,
      regimeRegular: empresas.some((e) => e.tomaCredito),
      transporte: empresas.some((e) => /^49/.test(String(e.cnae).replace(/\D/g, ""))) || gastos.combustivel > 0,
      semNotas: empresas.filter((e) => e.semNotas).map((e) => e.nome + " · " + fmtCnpj(e.cnpj)),
    },
    sugestao: { buscaMensal: PRECO_BUSCA_POR_CNPJ * empresas.length, reformaMensal: faixa, implantacao: IMPLANTACAO_BASE + IMPLANTACAO_POR_CNPJ * empresas.length },
  };
}
export type AnaliseProposta = ReturnType<typeof montarAnalise>;

export function configPadrao(a: AnaliseProposta): ConfigProposta {
  return { buscaMensal: a.sugestao.buscaMensal, reformaMensal: a.sugestao.reformaMensal, descontoPct: 0, implantacao: a.sugestao.implantacao, buscaDescontoPct: 0, buscaIsento: false, reformaDescontoPct: 0, reformaIsento: false, implantacaoDescontoPct: 0, implantacaoIsenta: false, salarioAnalista: SALARIO_ANALISTA_PADRAO, dedicacaoPct: a.dedicacaoSugerida, validadeDias: 30, observacoes: "" };
}
export function normalizarConfig(c: any, base: ConfigProposta): ConfigProposta {
  const n = (v: any, d: number, min = 0, max = 1e9) => { const x = Number(v); return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : d; };
  return {
    buscaMensal: r2(n(c?.buscaMensal, base.buscaMensal)), reformaMensal: r2(n(c?.reformaMensal, base.reformaMensal)),
    descontoPct: r2(n(c?.descontoPct, base.descontoPct, 0, 100)), implantacao: r2(n(c?.implantacao, base.implantacao)),
    buscaDescontoPct: r2(n(c?.buscaDescontoPct, base.buscaDescontoPct || 0, 0, 100)), buscaIsento: c?.buscaIsento !== undefined ? !!c.buscaIsento : !!base.buscaIsento,
    reformaDescontoPct: r2(n(c?.reformaDescontoPct, base.reformaDescontoPct || 0, 0, 100)), reformaIsento: c?.reformaIsento !== undefined ? !!c.reformaIsento : !!base.reformaIsento,
    implantacaoDescontoPct: r2(n(c?.implantacaoDescontoPct, base.implantacaoDescontoPct || 0, 0, 100)), implantacaoIsenta: c?.implantacaoIsenta !== undefined ? !!c.implantacaoIsenta : !!base.implantacaoIsenta,
    salarioAnalista: r2(n(c?.salarioAnalista, base.salarioAnalista)), dedicacaoPct: Math.round(n(c?.dedicacaoPct, base.dedicacaoPct, 0, 100)),
    validadeDias: Math.round(n(c?.validadeDias, base.validadeDias, 1, 365)), observacoes: String(c?.observacoes ?? base.observacoes).slice(0, 2000),
  };
}
// Mesma conta da tela (app.html › propCalcular) — manter as duas iguais.
export function calcularValores(a: AnaliseProposta, c: ConfigProposta) {
  const fin = (v: number, d: number, isento: boolean) => (isento ? 0 : r2(v * (1 - (d || 0) / 100)));
  const buscaFinal = fin(c.buscaMensal, c.buscaDescontoPct, c.buscaIsento), reformaFinal = fin(c.reformaMensal, c.reformaDescontoPct, c.reformaIsento);
  const mensalBruto = r2(c.buscaMensal + c.reformaMensal);
  const subtotal = r2(buscaFinal + reformaFinal);
  const descontoGeral = r2((subtotal * c.descontoPct) / 100);
  const descontoValor = r2(mensalBruto - subtotal + descontoGeral);
  const mensal = r2(subtotal - descontoGeral);
  const implantacaoFinal = fin(c.implantacao, c.implantacaoDescontoPct, c.implantacaoIsenta);
  const analistaMensal = r2(c.salarioAnalista * FATOR_ENCARGOS + BENEFICIOS_ANALISTA);
  const analistaAno = Math.round(analistaMensal * 12 * (c.dedicacaoPct / 100));
  const credito = Math.round(a.totais.perda2027Ano);
  const economia = analistaAno + credito;
  const investimentoAno1 = r2(mensal * 12 + implantacaoFinal);
  const liquido = Math.round(economia - investimentoAno1);
  const roi = investimentoAno1 > 0 ? Math.round((economia / investimentoAno1) * 10) / 10 : 0;
  const paybackMeses = economia > 0 ? Math.round((investimentoAno1 / (economia / 12)) * 10) / 10 : null;
  return { mensalBruto, buscaFinal, reformaFinal, subtotal, descontoGeral, descontoValor, mensal, implantacaoFinal, analistaMensal, analistaAno, credito, economia, investimentoAno1, liquido, roi, paybackMeses };
}

// ---- Formatação ----
function esc(s: any) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
export function fmtCnpj(c: string) { const d = String(c || "").replace(/\D/g, ""); return d.length === 14 ? d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5") : c; }
const brl = (v: number) => "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const brl0 = (v: number) => "R$ " + Math.round(Number(v || 0)).toLocaleString("pt-BR");
const mil = (v: number) => (Math.abs(v) >= 1e6 ? `R$ ${(v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} milhões` : Math.abs(v) >= 1000 ? `R$ ${(v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil` : brl0(v));
const num = (v: number) => Math.round(v).toLocaleString("pt-BR");
const dataBR = (iso: string) => iso.slice(0, 10).split("-").reverse().join("/");
const nomeCurto = (n: string) => String(n || "").replace(/\s+(LTDA|S\/?A|EIRELI|ME|EPP)\.?$/i, "").trim();
const vezes = (v: number) => v.toLocaleString("pt-BR", { maximumFractionDigits: 1 });

// Economias: as duas primeiras entram na soma (quantificadas); as demais aparecem conforme o perfil do cliente.
export function listarEconomias(a: AnaliseProposta, v: ReturnType<typeof calcularValores>, c: ConfigProposta) {
  const L: { titulo: string; texto: string; valor: string; rotulo: string; quantificada: boolean }[] = [];
  if (v.credito > 0) L.push({ titulo: "Crédito de IBS/CBS preservado em 2027", texto: `${a.notificarTotal} fornecedor(es) emitem sem grupo IBS/CBS, com erro ou pelo Simples "por dentro", e isso faz o cliente perder crédito. O módulo identifica cada um e notifica antes de 2027, quando a CBS passa a valer de verdade.`, valor: brl0(v.credito), rotulo: "por ano (estimado)", quantificada: true });
  if (v.analistaAno > 0) L.push({ titulo: c.dedicacaoPct >= 100 ? "Funcionário que não precisa ser contratado" : `${c.dedicacaoPct}% de um analista que não precisa ser contratado`, texto: `A conferência manual deste volume leva cerca de ${a.horasMes} horas por mês (${a.volume.notasMes} NF-e e ${a.volume.itensMes} itens de entrada por mês). Conferência, notificação e cobrança dos fornecedores ficam automáticas, e ninguém das compras precisa analisar fornecedor por fornecedor.`, valor: brl0(v.analistaAno), rotulo: "por ano", quantificada: true });
  const base = a.erros.find((e) => e.regra === "BASE_DIVERGENTE");
  L.push({ titulo: "Proteção contra glosa e autuação por crédito indevido", texto: `${base ? `São ${base.qtd} ocorrências de base de cálculo fora da fórmula oficial. ` : ""}Crédito inflado é devolvido pelo comprador, com multa, na fiscalização. Cada nota fica guardada com evidência e ficha de conferência, prontas para apresentar ao fisco.`, valor: "multa evitada", rotulo: "até 75% do crédito glosado", quantificada: false });
  if (a.perfil.exporta) L.push({ titulo: "Ressarcimento do crédito na exportação", texto: `Nos últimos 12 meses foram ${a.totais.exportacoes12m} nota(s) de saída para exportação/fim específico (${mil(a.totais.exportacoesValor12m)}). A exportação não paga IBS/CBS, e o crédito das compras acumula. Pela LC 214/2025 esse saldo pode ser <b>devolvido em dinheiro</b>, mas só com nota de insumo correta.`, valor: "crédito vira caixa", rotulo: "ressarcimento", quantificada: false });
  const cat = [
    a.gastos.combustivel ? `combustível (cerca de ${mil(a.gastos.combustivel)}/ano)` : "",
    a.gastos.pecas ? `peças e manutenção (cerca de ${mil(a.gastos.pecas)}/ano)` : "",
    a.gastos.pneus ? `pneus (cerca de ${mil(a.gastos.pneus)}/ano)` : "",
    a.gastos.insumosAgro ? `insumos agropecuários (cerca de ${mil(a.gastos.insumosAgro)}/ano)` : "",
    a.gastos.maquinas ? `máquinas e veículos do imobilizado (cerca de ${mil(a.gastos.maquinas)}/ano)` : "",
    a.totais.nfseTomadas12m ? `serviços tomados (${num(a.totais.nfseTomadas12m)} NFS-e em 12 meses)` : "",
  ].filter(Boolean);
  if (a.perfil.regimeRegular && cat.length) L.push({ titulo: "Crédito amplo nas compras com a CBS", texto: `No Lucro Presumido, o PIS/Cofins cumulativo não dá crédito de nada. Com a CBS, passam a gerar crédito: ${cat.join(", ")}. Tudo isso só vale com o documento do fornecedor correto.`, valor: "maior mudança", rotulo: "da reforma para o cliente", quantificada: false });
  if (a.simples.fornecedores) L.push({ titulo: "Renegociação com os fornecedores do Simples e MEI", texto: `São ${a.simples.notas} notas de ${a.simples.fornecedores} fornecedor(es) do Simples/MEI no período (${mil(a.simples.valor)}). O módulo mostra quanto cada um "custa" em crédito perdido e dá o argumento para pedir desconto, pedir a opção pelo regime regular ou trocar de fornecedor.`, valor: "preço líquido", rotulo: "menor por compra", quantificada: false });
  if (a.perfil.agro) L.push({ titulo: "Redução de 60% nos insumos agropecuários", texto: "Defensivos, fertilizantes e sementes têm alíquota reduzida na reforma. O módulo confere se o fornecedor aplicou a redução. Se não aplicou, o cliente paga imposto cheio embutido no preço.", valor: "imposto a menor", rotulo: "no preço do insumo", quantificada: false });
  if (a.ncmsVencidos) L.push({ titulo: "NCM vencido nas notas de compra", texto: `${a.ncmsVencidos} NCM(s) usados pelos fornecedores não estavam vigentes na data da emissão. O módulo aponta cada um antes que o crédito seja questionado.`, valor: "glosa evitada", rotulo: "por NCM vencido", quantificada: false });
  L.push({ titulo: `Busca de XML: nenhuma nota perdida, nas ${a.totais.cnpjs} inscrição(ões)`, texto: `Todas as NF-e, NFS-e, CT-e e MDF-e emitidas contra os CNPJs chegam sozinhas${a.perfil.semNotas.length ? `, inclusive as de ${a.perfil.semNotas.map(esc).join(", ")}, que hoje não tem nenhuma nota captada` : ""}. ${a.totais.cancelamentos ? `Os cancelamentos são vistos na hora (${a.totais.cancelamentos} no período). ` : ""}Nota que não chega é crédito que não entra e escrituração incompleta.`, valor: "0 notas", rotulo: "esquecidas", quantificada: false });
  L.push({ titulo: "Nota \"fria\" ou emitida indevidamente contra o CNPJ", texto: "Toda nota emitida contra o cliente aparece no painel. Uma compra que ninguém fez é detectada antes de virar problema com o fisco.", valor: "risco fiscal", rotulo: "reduzido", quantificada: false });
  L.push({ titulo: "Decisão de compra pelo custo líquido", texto: "Com o histórico de cada fornecedor (regime, crédito real e falhas), o comprador compara cotações pelo custo depois do crédito, não pelo preço de tabela.", valor: "margem", rotulo: "em cada compra", quantificada: false });
  return L;
}

export function htmlProposta(a: AnaliseProposta, c: ConfigProposta, meta: { clienteNome: string; data: string; numero: string }, timbrado: string | null) {
  const v = calcularValores(a, c);
  const eco = listarEconomias(a, v, c);
  const t = a.totais;
  const pctSemFalha = t.notas ? Math.round(((t.notas - t.notasComFalha) / t.notas) * 100) : 100;
  const linhasEmp = a.empresas.map((e) => e.notas || !e.semNotas
    ? `<tr><td><b>${esc(nomeCurto(e.nome))}</b><br><span class="mut">${fmtCnpj(e.cnpj)} · ${esc(e.regimeLabel)}</span></td><td class="num">${num(e.notas)}</td><td class="num">${num(e.itens)}</td><td class="num">${brl0(e.valor)}</td><td class="num">${num(e.notasSemFalha)}${e.notas ? ` (${Math.round((e.notasSemFalha / e.notas) * 100)}%)` : ""}</td><td class="num">${e.fornecedoresComFalha} de ${e.fornecedores}</td><td class="num"><b>${e.tomaCredito ? brl0(e.perda2027Ano) : "—"}</b></td></tr>`
    : `<tr><td><b>${esc(nomeCurto(e.nome))}</b><br><span class="mut">${fmtCnpj(e.cnpj)} · ${esc(e.regimeLabel)}</span></td><td colspan="6" style="text-align:center"><b>nenhuma nota captada no período</b></td></tr>`).join("");
  const naoRegular = a.empresas.filter((e) => !e.tomaCredito);
  const topNot = a.notificar[0];
  const custoTabela = [
    ["Salário de assistente/analista fiscal (região)", c.salarioAnalista],
    ["INSS patronal + RAT + terceiros (28,8%)", c.salarioAnalista * 0.288],
    ["FGTS (8%)", c.salarioAnalista * 0.08],
    ["Provisão de 13º e férias + 1/3, com encargos", c.salarioAnalista * (FATOR_ENCARGOS - 1 - 0.288 - 0.08)],
    ["Vale-transporte, alimentação, posto de trabalho e equipamento", BENEFICIOS_ANALISTA],
  ];
  const analistaCheio = Math.round(v.analistaMensal * 12);
  const barraModulo = analistaCheio ? Math.max(6, Math.min(100, ((v.mensal * 12) / analistaCheio) * 100)) : 100;
  const validade = (() => { const d = new Date(meta.data + "T12:00:00"); d.setDate(d.getDate() + c.validadeDias); return d.toISOString().slice(0, 10); })();
  const corpo = `
<span class="capa-tag">Proposta comercial nº ${esc(meta.numero)} · Confidencial</span>
<h1>Auditoria automática de notas fiscais e Reforma Tributária</h1>
<p class="sub"><b>${esc(meta.clienteNome)}</b>: ${a.empresas.map((e) => `${esc(nomeCurto(e.nome))} (${fmtCnpj(e.cnpj)})`).join(" · ")}<br>
Simples Contábeis · Redenção/PA, ${dataBR(meta.data)} · Proposta válida até ${dataBR(validade)}</p>

<p class="txt">A partir de 2027 a CBS substitui o PIS e a Cofins. O crédito de cada compra passa a depender de uma coisa só: <b>a nota do fornecedor vir certa</b>. Se o fornecedor erra o grupo IBS/CBS, a classificação, a base ou a alíquota, o crédito some ou vira risco de glosa. Quem paga é o comprador, não o fornecedor.</p>
<p class="txt">Antes de fazer esta proposta, rodamos o nosso módulo nas notas que <b>${esc(meta.clienteNome)} já recebeu</b> de ${dataBR(a.periodo.de)} a ${dataBR(a.periodo.ate)}. Todos os números abaixo saem dessas notas.</p>

<div class="hero">
  <div class="rot">Economia potencial estimada para ${esc(meta.clienteNome)}</div>
  <div class="big">${brl0(v.economia)} <small>por ano</small></div>
  <div class="txt">${[v.credito ? `${mil(v.credito)} de crédito de IBS/CBS que deixaria de ser aproveitado em 2027` : "", v.analistaAno ? `${mil(v.analistaAno)} de ${c.dedicacaoPct >= 100 ? "um analista" : `${c.dedicacaoPct}% de um analista`} que não precisa ser contratado` : ""].filter(Boolean).join(" + ")}. Somam-se a isso as economias não quantificadas do item 4.<br>
  <b style="color:#e9d48a;">Investimento no 1º ano: ${brl0(v.investimentoAno1)}${v.roi ? ` · retorno de cerca de ${vezes(v.roi)} vezes` : ""}${v.paybackMeses != null ? ` · o valor se paga em ${v.paybackMeses <= 1 ? "menos de 1 mês" : `cerca de ${Math.ceil(v.paybackMeses)} meses`}` : ""}.</b></div>
</div>

<div class="kpis">
  <div class="kpi"><div class="r">Notas de entrada auditadas</div><div class="v">${num(t.notas)} NF-e</div><div class="d">${num(t.itens)} itens · ${mil(t.valor)} em compras · ${num(t.fornecedores)} fornecedores</div></div>
  <div class="kpi verm"><div class="r">Notas com erro do fornecedor</div><div class="v">${num(t.notasComFalha)} notas</div><div class="d">de ${t.fornecedoresComFalha} fornecedor(es), com falha alta ou média</div></div>
  <div class="kpi verm"><div class="r">Crédito 2027 em jogo</div><div class="v">${mil(t.perda2027Ano)}/ano</div><div class="d">fornecedores sem destaque, com erro, Simples "por dentro" e MEI</div></div>
</div>

<h2>1. O que o módulo encontrou nas notas de vocês</h2>
<p class="txt">Período: <b>${dataBR(a.periodo.de)} a ${dataBR(a.periodo.ate)}</b>. Cada item foi conferido contra a NT 2025.002 (leiaute IBS/CBS da NF-e). O NCM e o cClassTrib foram validados direto na API oficial da Receita Federal (Calculadora de Tributos RFB/CGIBS).</p>
<table class="t">
  <thead><tr><th style="width:27%">Empresa</th><th class="num" style="width:8%">NF-e</th><th class="num" style="width:8%">Itens</th><th class="num" style="width:15%">Compras</th><th class="num" style="width:12%">Sem falha</th><th class="num" style="width:13%">Fornec. c/ falha</th><th class="num" style="width:17%">Crédito 2027/ano</th></tr></thead>
  <tbody>${linhasEmp}
    ${a.empresas.length > 1 ? `<tr class="tot"><td>Total</td><td class="num">${num(t.notas)}</td><td class="num">${num(t.itens)}</td><td class="num">${brl0(t.valor)}</td><td class="num">${pctSemFalha}%</td><td class="num">${t.fornecedoresComFalha}</td><td class="num">${brl0(t.perda2027Ano)}</td></tr>` : ""}
  </tbody>
</table>
<p class="small">${t.notas ? `Só ${pctSemFalha}% das notas chegaram sem falha. ` : ""}O volume é de cerca de ${a.volume.notasMes} NF-e de entrada por mês${a.volume.nfseMes ? ` e ${a.volume.nfseMes} NFS-e de serviços tomados por mês` : ""}, de ${num(t.fornecedores)} fornecedores. Ninguém confere isso à mão nota a nota.${naoRegular.length ? ` ${naoRegular.map((e) => esc(nomeCurto(e.nome)) + " (" + fmtCnpj(e.cnpj) + ")").join(", ")} ${naoRegular.length > 1 ? "estão" : "está"} no ${esc(naoRegular[0].regimeLabel)} e só toma crédito se optar pelo regime regular, por isso o crédito dessas inscrições não entra na soma.` : ""}</p>

${a.erros.length ? `<h2>2. Erros encontrados e quanto custam</h2>
<table class="t">
  <thead><tr><th style="width:27%">Erro do fornecedor</th><th class="num" style="width:9%">Ocorr.</th><th>O que acontece com o cliente</th></tr></thead>
  <tbody>${a.erros.slice(0, 8).map((e) => `<tr><td><b>${esc(e.titulo)}</b></td><td class="num">${num(e.qtd)}</td><td>${e.consequencia}</td></tr>`).join("")}</tbody>
</table>` : `<h2>2. Erros encontrados</h2><p class="txt">No período analisado não apareceram falhas altas ou médias. O valor do módulo aqui é manter isso assim quando a CBS passar a valer, conferindo 100% das notas que chegarem.</p>`}

${a.notificar.length ? `<h3>Fornecedores que já deveriam receber notificação${a.notificarTotal > a.notificar.length ? ` (os ${a.notificar.length} principais de ${a.notificarTotal})` : ""}</h3>
<table class="t">
  <thead><tr><th style="width:34%">Fornecedor</th>${a.empresas.length > 1 ? `<th style="width:17%">Comprador</th>` : ""}<th class="num" style="width:9%">Notas</th><th>Problema</th><th class="num" style="width:14%">Crédito 2027/ano</th></tr></thead>
  <tbody>${a.notificar.map((f) => `<tr><td>${esc(f.nome)}</td>${a.empresas.length > 1 ? `<td>${esc(nomeCurto(f.comprador))}<br><span class="mut">${fmtCnpj(f.compradorCnpj).slice(-7)}</span></td>` : ""}<td class="num">${f.notas}</td><td>${esc(f.problema)}</td><td class="num">${f.perdaAno ? `<b>${brl0(f.perdaAno)}</b>` : "risco de glosa"}</td></tr>`).join("")}</tbody>
</table>
<p class="small">${topNot && topNot.perdaAno ? `Só ${esc(topNot.nome)} responde por ${brl0(topNot.perdaAno)}/ano de crédito em jogo. ` : ""}O módulo gera a notificação de cada fornecedor com o número da nota, a falha e o XML esperado, e envia por e-mail ou WhatsApp. Ninguém do cliente precisa ligar para fornecedor, explicar leiaute ou acompanhar o retorno.</p>` : ""}

<h2>3. Sem contratar um analista para conferir compras</h2>
<p class="txt">Sem o módulo, esse controle exige alguém que receba todos os XMLs das ${t.cnpjs} inscrição(ões) e confira item a item NCM, CST, cClassTrib, base, alíquota e redução. Essa pessoa também teria que separar os fornecedores com problema, notificar, cobrar a correção e guardar a prova para a fiscalização. No volume atual são cerca de <b>${a.horasMes} horas de trabalho por mês</b> (${a.volume.notasMes} NF-e e ${a.volume.itensMes} itens por mês${a.volume.nfseMes ? `, mais ${a.volume.nfseMes} NFS-e` : ""}). Em 2027, com a CBS cheia, cada erro passa a valer dinheiro.</p>
<table class="t cab" style="break-inside:avoid">
  <tbody>${custoTabela.map(([r, x]) => `<tr><td>${r}</td><td class="num">${brl(x as number)}</td></tr>`).join("")}
    <tr class="tot"><td>Custo mensal do funcionário · <b>${brl0(analistaCheio)} por ano</b>${c.dedicacaoPct < 100 ? ` · ${c.dedicacaoPct}% dele: <b>${brl0(v.analistaAno)}/ano</b>` : ""}</td><td class="num">${brl(v.analistaMensal)}</td></tr>
  </tbody>
</table>
<div class="barras">
  <div class="barra"><span>Analista dedicado (ano)</span><div class="trilho"><div class="enc" style="width:100%; background:#9c3a24;">${brl0(analistaCheio)} · trabalho manual, sujeito a falta, férias e rotatividade</div></div></div>
  <div class="barra"><span>Módulo (mensalidades/ano)</span><div class="trilho"><div class="enc" style="width:${barraModulo.toFixed(1)}%; background:#2e8b57;">${brl0(v.mensal * 12)}</div></div></div>
</div>
<div class="destaque"><b>A máquina não tira férias, não se demite e não "deixa para amanhã".</b> Ela confere 100% das notas no dia em que chegam, com a tabela oficial da Receita atualizada automaticamente a cada 15 dias. O analista humano confere por amostragem e consulta a legislação à mão.</div>

<h2>4. Todas as economias que o módulo gera</h2>
${eco.map((e, i) => `<div class="eco${e.quantificada ? "" : " q"}"><div class="n">${i + 1}</div><div><div class="t">${e.titulo}</div><div class="x">${e.texto}</div></div><div class="val">${e.valor}<small>${e.rotulo}</small></div></div>`).join("")}

<h2>5. Como funciona no dia a dia</h2>
<div class="fluxo2">
  <div><b>1. Captura</b>O XML de cada nota emitida contra os CNPJs chega sozinho.</div>
  <div><b>2. Auditoria</b>Cada item é conferido contra a NT 2025.002 e a API oficial da Receita.</div>
  <div><b>3. Painel</b>O cliente vê a conformidade, o crédito em jogo e os fornecedores críticos.</div>
  <div><b>4. Notificação</b>O fornecedor recebe por e-mail ou WhatsApp a falha e a correção esperada.</div>
  <div><b>5. Relatório</b>Todo mês sai um PDF para a diretoria, com as fichas de conferência.</div>
</div>

<h2>6. Investimento</h2>
<div class="preco"><table>
  <tr class="cab"><td><b>Item</b></td><td class="num"><b>Tabela</b></td><td class="num"><b>Desconto</b></td><td class="num"><b>Valor</b></td></tr>
  ${[
    [`Busca automática de XML: NF-e, NFC-e, NFS-e, CT-e e MDF-e, ${t.cnpjs} inscrição(ões)`, c.buscaMensal, c.buscaDescontoPct, c.buscaIsento, v.buscaFinal],
    ["Auditoria Reforma Tributária: entradas e saídas, validação na API da Receita, notificação automática dos fornecedores e relatório mensal", c.reformaMensal, c.reformaDescontoPct, c.reformaIsento, v.reformaFinal],
  ].map(([nome, tab, d, isento, fin]: any) => `<tr><td>${nome}</td><td class="num">${brl(tab)}</td><td class="num ok">${isento ? "isento" : d ? `${String(d).replace(".", ",")}%` : "—"}</td><td class="num">${isento ? "<b>isento</b>" : brl(fin)}</td></tr>`).join("")}
  ${v.descontoGeral ? `<tr><td colspan="3">Subtotal</td><td class="num">${brl(v.subtotal)}</td></tr><tr><td colspan="3"><b>Desconto especial (${String(c.descontoPct).replace(".", ",")}%)</b></td><td class="num ok">− ${brl(v.descontoGeral)}</td></tr>` : ""}
  <tr class="total"><td colspan="3">Mensalidade${v.descontoValor ? ` <span style="font-size:9px; font-weight:600; color:#1f6e43;">(economia de ${brl(v.descontoValor)}/mês sobre a tabela de ${brl(v.mensalBruto)})</span>` : ""}</td><td class="num">${brl(v.mensal)}/mês</td></tr>
  <tr><td>Implantação, cobrada uma vez: cadastro das inscrições, carga das notas do ano, primeira auditoria completa e primeira rodada de notificação aos fornecedores com falha</td><td class="num">${brl(c.implantacao)}</td><td class="num ok">${c.implantacaoIsenta ? "isenta" : c.implantacaoDescontoPct ? `${String(c.implantacaoDescontoPct).replace(".", ",")}%` : "—"}</td><td class="num">${v.implantacaoFinal ? brl(v.implantacaoFinal) : "<b>isenta</b>"}</td></tr>
</table></div>
<table class="t" style="break-inside:avoid">
  <thead><tr><th>Retorno no 1º ano</th><th class="num" style="width:24%">Valor</th></tr></thead>
  <tbody>
    <tr><td>Economia quantificada${v.credito && v.analistaAno ? ": crédito 2027 preservado + analista não contratado" : ""}</td><td class="num ok">${brl0(v.economia)}</td></tr>
    <tr><td>Investimento: ${v.implantacaoFinal ? "implantação + " : ""}12 mensalidades</td><td class="num no">− ${brl0(v.investimentoAno1)}</td></tr>
    <tr class="tot"><td>Ganho líquido estimado no 1º ano, sem contar as economias não quantificadas</td><td class="num">${brl0(v.liquido)}</td></tr>
    <tr><td>Retorno sobre o investimento</td><td class="num"><b>≈ ${vezes(v.roi)} vezes</b></td></tr>
    ${v.paybackMeses != null ? `<tr><td>Prazo para se pagar</td><td class="num"><b>${v.paybackMeses <= 1 ? "menos de 1 mês" : `cerca de ${Math.ceil(v.paybackMeses)} meses`}</b></td></tr>` : ""}
  </tbody>
</table>
${c.observacoes ? `<div class="destaque"><b>Condições:</b> ${esc(c.observacoes).replace(/\n/g, "<br>")}</div>` : ""}
<div class="alerta"><b>Por que agora:</b> a CBS cheia começa em <b>janeiro de 2027</b>. A janela para o fornecedor do Simples optar pelo regime regular no 2º semestre é <b>março de 2027</b>. Os fornecedores precisam ser notificados e corrigidos <b>antes</b> disso. Cada mês sem controle é crédito que não volta.</div>

<h2>7. Premissas e ressalvas</h2>
<div class="rodape-nota">
<b>Base dos números:</b> NF-e de entrada captadas nos CNPJs da proposta de ${dataBR(a.periodo.de)} a ${dataBR(a.periodo.ate)}, auditadas pelo módulo de Reforma Tributária da Simples Contábeis. Foram excluídas as notas canceladas e as transferências entre estabelecimentos do próprio grupo. O "crédito 2027 em jogo" é a diferença entre o crédito que as compras dariam se viessem corretas de fornecedor do regime regular e o crédito efetivamente documentado. Ele é projetado com a CBS de 2027 estimada (a alíquota ainda depende de resolução do Senado, LC 214/2025, art. 347) e anualizado linearmente a partir de ${a.periodo.meses} meses. Compras sazonais podem fazer o valor anual real ser maior ou menor.<br>
<b>Custo do analista:</b> salário de mercado da região e encargos do Lucro Presumido. A dedicação considerada é de ${c.dedicacaoPct}% de um profissional, conforme o volume de notas. Não inclui recrutamento, treinamento e rotatividade.<br>
<b>Economias não quantificadas:</b> são economias reais, mas dependem de fiscalização, do comportamento dos fornecedores e de regulamentação ainda em curso. Por isso não entram na soma.<br>
Esta proposta não é garantia de resultado nem parecer jurídico. A recuperação efetiva de cada crédito depende da correção pelo fornecedor e da escrituração regular.
</div>
<div class="assin"><div class="linha"></div><b>Simples Contábeis</b><br>Escritório Contábil · Redenção/PA</div>`;
  const bg = timbrado ? `<img class="bg" src="${timbrado}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Proposta ${esc(meta.numero)}</title><style>
@page { size: A4; margin: ${timbrado ? "0" : "16mm 14mm"}; }
html, body { margin: 0; padding: 0; }
body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #2f3b42; font-size: 10px; line-height: 1.45; }
.bg { position: fixed; top: 0; left: 0; width: 210mm; height: 297mm; z-index: -1; }
table.layout { width: ${timbrado ? "210mm" : "100%"}; border-collapse: collapse; }
table.layout > thead td, table.layout > tfoot td, table.layout > tbody > tr > td.corpo { border: none; padding: 0; }
.espaco-topo { height: ${timbrado ? "48mm" : "0"}; } .espaco-rodape { height: ${timbrado ? "44mm" : "0"}; }
td.corpo { padding: 0 ${timbrado ? "20mm" : "0"} !important; vertical-align: top; }
h1 { font-size: 16px; margin: 0 0 3px; color: #2f3b42; letter-spacing: -.2px; }
h2 { font-size: 12.5px; margin: 16px 0 6px; color: #2f3b42; break-after: avoid; padding-bottom: 3px; border-bottom: 1.6px solid #c9a227; }
h3 { font-size: 10.8px; margin: 12px 0 4px; color: #6b5410; break-after: avoid; }
.sub { font-size: 9.6px; color: #6b7880; margin: 0 0 12px; padding-bottom: 8px; border-bottom: 2.5px solid #c9a227; }
p.txt { margin: 6px 0 8px; text-align: justify; } p.small { font-size: 9.2px; color: #52616a; } .mut { color: #78858c; font-size: 8.6px; }
table.t { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 9px; background: rgba(255,255,255,.94); margin: 6px 0 10px; }
table.t th { text-align: left; background: #2f3b42; color: #fff; padding: 5px 6px; border: 1px solid #2f3b42; font-size: 8px; text-transform: uppercase; letter-spacing: .04em; font-weight: 700; }
table.t td { padding: 5px 6px; border: 1px solid #dde3e6; vertical-align: top; word-wrap: break-word; }
table.t tr { break-inside: avoid; } table.t thead { display: table-header-group; }
table.t.cab td:first-child { background: #f5f7f8; font-weight: 600; width: 62%; }
tr.tot td { background: #f3eed9; font-weight: 700; } .num { text-align: right; white-space: nowrap; }
.alerta { background: #fdf6e3; border: 1px solid #c9a227; border-left: 4px solid #c9a227; padding: 9px 11px; margin: 12px 0; font-size: 9.4px; text-align: justify; break-inside: avoid; }
.destaque { background: #f0f4f6; border-left: 4px solid #2f3b42; padding: 9px 11px; margin: 10px 0; font-size: 9.4px; text-align: justify; break-inside: avoid; }
.rodape-nota { margin-top: 10px; padding: 9px 11px; background: #f7f8f9; border: 1px solid #e2e7ea; font-size: 8.4px; color: #52616a; text-align: justify; break-inside: avoid; }
.assin { margin-top: 26px; text-align: center; font-size: 9.4px; break-inside: avoid; } .assin .linha { width: 62mm; border-top: 1px solid #2f3b42; margin: 0 auto 5px; }
.capa-tag { display:inline-block; font-size:8.4px; letter-spacing:.14em; text-transform:uppercase; color:#6b5410; background:#f3eed9; border:1px solid #c9a227; padding:2px 8px; border-radius:2px; margin-bottom:6px; }
.hero { background:#2f3b42; color:#fff; padding:14px 16px; margin:12px 0 10px; break-inside:avoid; border-bottom:4px solid #c9a227; }
.hero .rot { font-size:8.6px; letter-spacing:.12em; text-transform:uppercase; color:#e9d48a; }
.hero .big { font-size:30px; font-weight:800; letter-spacing:-.5px; margin:2px 0; color:#fff; } .hero .big small { font-size:13px; font-weight:600; color:#e9d48a; }
.hero .txt { font-size:9.6px; color:#dfe5e8; }
.kpis { display:grid; grid-template-columns:repeat(3,1fr); gap:7px; margin:8px 0 10px; break-inside:avoid; }
.kpi { border:1px solid #dde3e6; border-top:3px solid #c9a227; background:rgba(255,255,255,.95); padding:7px 9px; }
.kpi .r { font-size:7.6px; letter-spacing:.08em; text-transform:uppercase; color:#6b7880; } .kpi .v { font-size:16px; font-weight:800; color:#2f3b42; margin:2px 0 1px; } .kpi .d { font-size:8.2px; color:#52616a; }
.kpi.verm { border-top-color:#b4472e; } .kpi.verm .v { color:#9c3a24; }
.eco { display:grid; grid-template-columns:30px 1fr 92px; gap:0 9px; align-items:start; border:1px solid #dde3e6; border-left:4px solid #2e8b57; background:rgba(255,255,255,.96); padding:8px 10px; margin:0 0 7px; break-inside:avoid; }
.eco .n { width:24px; height:24px; border-radius:50%; background:#2f3b42; color:#e9d48a; font-weight:800; font-size:11px; display:flex; align-items:center; justify-content:center; }
.eco .t { font-size:10.4px; font-weight:800; color:#2f3b42; margin-bottom:2px; } .eco .x { font-size:9.1px; color:#3c4950; text-align:justify; }
.eco .val { text-align:right; font-size:12.5px; font-weight:800; color:#1f6e43; line-height:1.15; } .eco .val small { display:block; font-size:7.6px; font-weight:600; color:#6b7880; text-transform:uppercase; letter-spacing:.05em; }
.eco.q { border-left-color:#c9a227; } .eco.q .val { color:#6b5410; font-size:10px; }
.barras { break-inside:avoid; margin:8px 0 12px; } .barra { display:grid; grid-template-columns:150px 1fr; gap:8px; align-items:center; margin:5px 0; font-size:9px; }
.barra .trilho { overflow:hidden; background:#eef1f3; height:20px; } .barra .enc { height:20px; display:flex; align-items:center; padding-left:7px; color:#fff; font-weight:700; font-size:9px; white-space:nowrap; }
.fluxo2 { display:grid; grid-template-columns:repeat(5,1fr); gap:5px; margin:8px 0 12px; break-inside:avoid; }
.fluxo2 div { background:#f0f4f6; border-top:3px solid #2f3b42; padding:7px; font-size:8.4px; text-align:center; } .fluxo2 b { display:block; font-size:9px; margin-bottom:2px; color:#2f3b42; }
.preco { border:2px solid #c9a227; background:#fffdf5; padding:12px 14px; margin:10px 0; break-inside:avoid; }
.preco table { width:100%; border-collapse:collapse; font-size:9.6px; } .preco td { padding:5px 4px; border-bottom:1px dashed #e4d8a8; }
.preco tr.cab td { font-size:8.4px; text-transform:uppercase; letter-spacing:.04em; color:#6b5410; border-bottom:1.5px solid #c9a227; }
.preco tr.total td { font-size:12px; font-weight:800; border-bottom:none; border-top:2px solid #c9a227; padding-top:7px; }
.ok { color:#1f6e43; font-weight:700; } .no { color:#9c3a24; font-weight:700; }
</style></head><body>${bg}<table class="layout"><thead><tr><td class="espaco-topo"></td></tr></thead><tfoot><tr><td class="espaco-rodape"></td></tr></tfoot><tbody><tr><td class="corpo">${corpo}</td></tr></tbody></table></body></html>`;
}

export async function gerarPdfProposta(...args: Parameters<typeof htmlProposta>): Promise<Buffer> {
  const html = htmlProposta(...args);
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ javaScriptEnabled: false });
    await page.route("**/*", (route: any) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url === "about:blank") return route.continue();
      return route.abort();
    });
    await page.setContent(html, { waitUntil: "networkidle" });
    return (await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true })) as Buffer;
  } finally {
    await browser.close();
  }
}

// Lista de estabelecimentos do Anexo I do contrato (HTML já escapado — entra cru no modelo).
export function anexoEstabelecimentosHtml(empresas: { nome: string; cnpj: string; cidade?: string; uf?: string }[]) {
  return `<table class="dados"><thead><tr><th>#</th><th>Razão social</th><th>CNPJ</th><th>Município</th></tr></thead><tbody>${empresas
    .map((e, i) => `<tr><td>${i + 1}</td><td>${esc(e.nome)}</td><td>${fmtCnpj(e.cnpj)}</td><td>${esc([e.cidade, e.uf].filter(Boolean).join("-"))}</td></tr>`)
    .join("")}</tbody></table>`;
}
