// Diagnóstico de regime tributário pós-reforma: compara, num quadro só, Simples Nacional com IBS/CBS
// dentro do DAS, Simples "por fora" (regime regular de IBS/CBS), Lucro Presumido e Lucro Real, em 2026
// (hoje), 2027 (CBS plena) e 2033 (IBS pleno) — com crédito nas entradas, crédito repassado ao cliente
// B2B e recomendação. Cálculo puro (sem banco): o server.ts junta os dados (XML, cadastro) e as premissas.
//
// Fontes (pesquisadas em nov/2026): LC 123/2006 (Anexos I–V, art. 18 §1º-A alíquota efetiva, §5º-J/M
// Fator R, art. 13-A sublimite); LC 214/2025 (arts. 41 §3º, 47, 57, 127/128, 343–348; anexos da partilha
// 2027–2033) e LC 227/2026; Res. CGSN 140/2018 com Res. CGSN 190/2026 (art. 22-A: Simples por fora) e
// 194/2026 (janela de 2027); Lei 9.249/95 arts. 15 e 20 (presunção); LC 224/2025 (acréscimo de 10% na
// presunção acima de R$ 5 mi — judicializado); Lei 14.973/2024 (reoneração da folha).

export type Anexo = "I" | "II" | "III" | "IV" | "V";
// [alíquota nominal %, parcela a deduzir R$] por faixa (1ª a 6ª) — LC 123/2006 (redação LC 155/2016).
const TABELA_SN: Record<Anexo, [number, number][]> = {
  I: [[4, 0], [7.3, 5940], [9.5, 13860], [10.7, 22500], [14.3, 87300], [19, 378000]],
  II: [[4.5, 0], [7.8, 5940], [10, 13860], [11.2, 22500], [14.7, 85500], [30, 720000]],
  III: [[6, 0], [11.2, 9360], [13.5, 17640], [16, 35640], [21, 125640], [33, 648000]],
  IV: [[4.5, 0], [9, 8100], [10.2, 12420], [14, 39780], [22, 183780], [33, 828000]],
  V: [[15.5, 0], [18, 4500], [19.5, 9900], [20.5, 17100], [23, 62100], [30.5, 540000]],
};
const FAIXAS = [180000, 360000, 720000, 1800000, 3600000, 4800000];
// Partilha vigente até 2026 (% da alíquota efetiva): [IRPJ, CSLL, COFINS, PIS, CPP, ICMS/ISS, IPI] por faixa.
const PARTILHA: Record<Anexo, number[][]> = {
  I: [[5.5, 3.5, 12.74, 2.76, 41.5, 34, 0], [5.5, 3.5, 12.74, 2.76, 41.5, 34, 0], [5.5, 3.5, 12.74, 2.76, 42, 33.5, 0], [5.5, 3.5, 12.74, 2.76, 42, 33.5, 0], [5.5, 3.5, 12.74, 2.76, 42, 33.5, 0], [13.5, 10, 28.27, 6.13, 42.1, 0, 0]],
  II: [[5.5, 3.5, 11.51, 2.49, 37.5, 32, 7.5], [5.5, 3.5, 11.51, 2.49, 37.5, 32, 7.5], [5.5, 3.5, 11.51, 2.49, 37.5, 32, 7.5], [5.5, 3.5, 11.51, 2.49, 37.5, 32, 7.5], [5.5, 3.5, 11.51, 2.49, 37.5, 32, 7.5], [8.5, 7.5, 20.96, 4.54, 23.5, 0, 35]],
  III: [[4, 3.5, 12.82, 2.78, 43.4, 33.5, 0], [4, 3.5, 14.05, 3.05, 43.4, 32, 0], [4, 3.5, 13.64, 2.96, 43.4, 32.5, 0], [4, 3.5, 13.64, 2.96, 43.4, 32.5, 0], [4, 3.5, 12.82, 2.78, 43.4, 33.5, 0], [35, 15, 16.03, 3.47, 30.5, 0, 0]],
  IV: [[18.8, 15.2, 17.67, 3.83, 0, 44.5, 0], [19.8, 15.2, 20.55, 4.45, 0, 40, 0], [20.8, 15.2, 19.73, 4.27, 0, 40, 0], [17.8, 19.2, 18.9, 4.1, 0, 40, 0], [18.8, 19.2, 18.08, 3.92, 0, 40, 0], [53.5, 21.5, 20.55, 4.45, 0, 0, 0]],
  V: [[25, 15, 14.1, 3.05, 28.85, 14, 0], [23, 15, 14.1, 3.05, 27.85, 17, 0], [24, 15, 14.92, 3.23, 23.85, 19, 0], [21, 15, 15.74, 3.41, 23.85, 21, 0], [23, 12.5, 14.1, 3.05, 23.85, 23.5, 0], [35, 15.5, 16.44, 3.56, 29.5, 0, 0]],
};
export const ANEXO_LABEL: Record<Anexo, string> = { I: "Anexo I (comércio)", II: "Anexo II (indústria)", III: "Anexo III (serviços)", IV: "Anexo IV (serviços — CPP fora do DAS)", V: "Anexo V (serviços)" };

export function aliquotaEfetivaSN(anexo: Anexo, rbt12: number) {
  const r = Math.max(rbt12, 0.01);
  const fx = Math.min(FAIXAS.findIndex((t) => r <= t) === -1 ? 5 : FAIXAS.findIndex((t) => r <= t), 5);
  const [nom, pd] = TABELA_SN[anexo][fx];
  return { faixa: fx + 1, nominal: nom, efetiva: Math.max(0, ((r * nom) / 100 - pd) / r) * 100, partilha: PARTILHA[anexo][fx] };
}
// Fração do antigo ICMS/ISS que vira IBS no DAS e fora dele (ADCT/EC 132 e anexos da LC 214).
export function fatorTransicao(ano: number) {
  if (ano <= 2028) return 0;
  if (ano >= 2033) return 1;
  return (ano - 2028) / 10; // 2029 0,1 · 2030 0,2 · 2031 0,3 · 2032 0,4
}

export interface Premissas {
  receitaAnual: number | null;          // override; null = usa a do XML
  pctMercadorias: number | null;        // % da receita que é venda de mercadorias (resto = serviços); null = XML
  pctB2B: number | null;                // % das vendas para CNPJ; null = XML
  folhaAnual: number;                   // salários + encargos-base (12 meses), sem pró-labore
  proLaboreAnual: number;
  margemLucro: number;                  // % (Lucro Real)
  anexoMercadorias: Anexo;
  anexoServicos: Anexo | "III/V";       // "III/V" = decide pelo Fator R
  reducaoSetorial: 0 | 30 | 60;         // redução de alíquota de IBS/CBS da atividade (LC 214)
  presuncaoIrpjMerc: number; presuncaoCsllMerc: number; presuncaoIrpjServ: number; presuncaoCsllServ: number;
  acrescimoLc224: boolean;
  icmsLiquidoPct: number;               // carga líquida de ICMS sobre mercadorias fora do Simples (%)
  issPct: number;                       // alíquota de ISS (%)
  cbsReferencia: number;                // %
  ibsReferencia2033: number;            // % (UF+Mun) no regime pleno
  pctComprasComCredito: number;         // % das compras que gera crédito (exclui uso e consumo pessoal etc.)
  creditoMedioComprasSimples: number;   // % de crédito médio nas compras de fornecedor do Simples por dentro
  encargosFolhaPct: number;             // CPP 20% + RAT + terceiros (fora do Simples e Anexo IV)
}
export interface DadosEmpresa {
  nome: string; regimeAtual: string; cnae: string | null; cnaeDescricao: string | null;
  receitaMercadorias12m: number; receitaServicos12m: number; vendasB2B12m: number; vendasTotal12m: number;
  comprasRegular12m: number; comprasSimples12m: number; comprasOutras12m: number;
  meses: number; mesesComDados: number;
}

// Padrões por atividade (CNAE): anexo, presunções, margem e folha típicas — todos editáveis.
export function premissasPadrao(d: DadosEmpresa): Premissas {
  const div = Number(String(d.cnae || "").replace(/\D/g, "").slice(0, 2)) || 0;
  const cnae4 = String(d.cnae || "").replace(/\D/g, "").slice(0, 4);
  const industria = div >= 10 && div <= 33;
  const servico = d.receitaServicos12m > d.receitaMercadorias12m;
  const construcaoOuIV = (div >= 41 && div <= 43) || ["6911", "8011", "8012", "8121", "8122", "8129"].includes(cnae4);
  const regulamentada = ["6911", "6920", "7111", "7112", "7119", "7120", "7410", "7500", "8630", "8640", "8650", "8660", "8690"].includes(cnae4);
  const reduz60 = div === 85 || ["8610", "8621", "8622", "8630", "8640"].includes(cnae4);
  const receita = d.receitaMercadorias12m + d.receitaServicos12m;
  return {
    receitaAnual: null, pctMercadorias: null, pctB2B: null,
    folhaAnual: Math.round(receita * (servico ? 0.22 : 0.07)),
    proLaboreAnual: 0,
    margemLucro: servico ? 20 : industria ? 8 : 5,
    anexoMercadorias: industria ? "II" : "I",
    anexoServicos: construcaoOuIV ? "IV" : "III/V",
    reducaoSetorial: reduz60 ? 60 : regulamentada ? 30 : 0,
    presuncaoIrpjMerc: 8, presuncaoCsllMerc: 12, presuncaoIrpjServ: 32, presuncaoCsllServ: 32,
    acrescimoLc224: true,
    icmsLiquidoPct: 3, issPct: 5,
    cbsReferencia: 11.3, ibsReferencia2033: 17.7,
    pctComprasComCredito: 90, creditoMedioComprasSimples: 1.5,
    encargosFolhaPct: 27.8,
  };
}

export type RegimeId = "sn_dentro" | "sn_fora" | "presumido" | "real";
export const REGIME_LABEL: Record<RegimeId, string> = { sn_dentro: "Simples Nacional (IBS/CBS no DAS)", sn_fora: "Simples Nacional (IBS/CBS por fora)", presumido: "Lucro Presumido", real: "Lucro Real" };
export interface LinhaTributo { nome: string; valor: number }
export interface ResultadoRegime {
  id: RegimeId; label: string; disponivel: boolean; motivoIndisponivel?: string;
  tributos: LinhaTributo[]; total: number; cargaPct: number;
  // IBS/CBS por fora é cobrado do cliente além do preço: neutro pra cliente empresa (vira crédito dele),
  // pesa pro consumidor final. Carga própria = o que sai do bolso da empresa.
  ibsCbsPorFora: number; cargaPropria: number; cargaPropriaPct: number;
  // Custo efetivo (critério do ranking): carga própria + IBS/CBS por fora sobre a fatia B2C (como se a
  // empresa absorvesse pra manter o preço ao consumidor) + no Simples por dentro, o crédito que os
  // clientes empresas deixam de tomar em relação a um fornecedor do regime regular.
  custoEfetivo: number; custoEfetivoPct: number; perdaCreditoClientes: number;
  creditoEntradas: number;       // crédito de IBS/CBS (ou PIS/COFINS em 2026 no Real) aproveitado das compras
  creditoRepassado: number;      // crédito que os clientes B2B tomam
  custoLiquidoClienteB2B: number; // por R$ 100 de compra do cliente B2B: preço − crédito
}
export interface ResultadoAno { ano: number; titulo: string; regimes: ResultadoRegime[]; melhor: RegimeId | null }

const r2 = (v: number) => Math.round(v * 100) / 100;
function irpj(base: number) { return 0.15 * base + 0.1 * Math.max(0, base - 240000); }

export function calcularDiagnostico(d: DadosEmpresa, p: Premissas) {
  const R = p.receitaAnual != null && p.receitaAnual > 0 ? p.receitaAnual : d.receitaMercadorias12m + d.receitaServicos12m;
  const totalXml = d.receitaMercadorias12m + d.receitaServicos12m;
  const pctMerc = p.pctMercadorias != null ? p.pctMercadorias / 100 : totalXml > 0 ? d.receitaMercadorias12m / totalXml : 1;
  const Rm = R * pctMerc, Rs = R - Rm;
  const b = p.pctB2B != null ? p.pctB2B / 100 : d.vendasTotal12m > 0 ? d.vendasB2B12m / d.vendasTotal12m : 0;
  const folhaFatorR = p.folhaAnual + p.proLaboreAnual;
  const fatorR = R > 0 ? (folhaFatorR / R) * 100 : 0;
  const anexoServ: Anexo = p.anexoServicos === "III/V" ? (fatorR >= 28 ? "III" : "V") : p.anexoServicos;
  const cpp = p.folhaAnual * (p.encargosFolhaPct / 100) + p.proLaboreAnual * 0.2;
  const comprasCred = (d.comprasRegular12m * p.pctComprasComCredito) / 100;
  const escala = totalXml > 0 && R !== totalXml ? R / totalXml : 1; // compras acompanham a receita ajustada
  const comprasRegular = comprasCred * escala, comprasSimples = ((d.comprasSimples12m * p.pctComprasComCredito) / 100) * escala;
  const red = 1 - p.reducaoSetorial / 100;

  const snMerc = aliquotaEfetivaSN(p.anexoMercadorias, R);
  const snServ = aliquotaEfetivaSN(anexoServ, R);
  const acimaSublimite = R > 3600000, acimaTeto = R > 4800000;
  const presIrpj = Rm * (p.presuncaoIrpjMerc / 100) + Rs * (p.presuncaoIrpjServ / 100);
  const presCsll = Rm * (p.presuncaoCsllMerc / 100) + Rs * (p.presuncaoCsllServ / 100);
  const fatorLc224 = p.acrescimoLc224 && R > 5000000 ? (5000000 + (R - 5000000) * 1.1) / R : 1;

  const anos = [2026, 2027, 2033];
  const resultado: ResultadoAno[] = anos.map((ano) => {
    const f = fatorTransicao(ano);
    // Alíquotas de IBS/CBS do ano (regime regular), com a redução setorial.
    const tC = ano === 2026 ? 0 : (ano <= 2028 ? p.cbsReferencia - 0.1 : p.cbsReferencia) * red / 100;
    const tI = ano === 2026 ? 0 : (ano <= 2028 ? 0.1 : p.ibsReferencia2033 * f) * red / 100;
    const t = tC + tI;
    const icms = Rm * (p.icmsLiquidoPct / 100) * (1 - f), iss = Rs * (p.issPct / 100) * (1 - f);
    const creditoRegular = comprasRegular * t + comprasSimples * (ano === 2026 ? 0 : p.creditoMedioComprasSimples / 100);
    const credRepassadoRegular = b * R * t;
    const regimes: ResultadoRegime[] = [];
    const mk = (id: RegimeId, tributos: LinhaTributo[], creditoEntradas: number, creditoRepassado: number, disponivel = true, motivo?: string): ResultadoRegime => {
      const tr = tributos.filter((x) => Math.abs(x.valor) >= 0.005).map((x) => ({ nome: x.nome, valor: r2(x.valor) }));
      const total = r2(tr.reduce((a, x) => a + x.valor, 0));
      const porFora = r2(tr.filter((x) => /^CBS \+ IBS/.test(x.nome)).reduce((a, x) => a + x.valor, 0));
      const propria = r2(total - porFora);
      const perdaClientes = id === "sn_dentro" && ano >= 2027 ? r2(Math.max(0, b * R * t - creditoRepassado)) : 0;
      const custoEf = r2(propria + (1 - b) * porFora + perdaClientes);
      const precoB2B = id === "sn_dentro" ? 100 : 100 * (1 + t); // IBS/CBS por fora entram no preço
      const credPor100 = id === "sn_dentro" ? (R > 0 ? (creditoRepassado / Math.max(b * R, 0.01)) * 100 : 0) : 100 * t;
      return { id, label: REGIME_LABEL[id], disponivel, motivoIndisponivel: motivo, tributos: tr, total, cargaPct: R > 0 ? r2((total / R) * 100) : 0,
        ibsCbsPorFora: porFora, cargaPropria: propria, cargaPropriaPct: R > 0 ? r2((propria / R) * 100) : 0, custoEfetivo: custoEf, custoEfetivoPct: R > 0 ? r2((custoEf / R) * 100) : 0, perdaCreditoClientes: perdaClientes,
        creditoEntradas: r2(creditoEntradas), creditoRepassado: r2(creditoRepassado), custoLiquidoClienteB2B: r2(precoB2B - (b > 0 ? credPor100 : 0)) };
    };
    // ---- Simples por dentro ----
    const dasPartes = [{ R: Rm, sn: snMerc, anexo: p.anexoMercadorias }, { R: Rs, sn: snServ, anexo: anexoServ }].filter((x) => x.R > 0);
    let das = 0, parcelaIbsCbsDas = 0;
    for (const x of dasPartes) {
      const valor = (x.R * x.sn.efetiva) / 100;
      das += valor;
      const [, , cof, pis, , icmsIss] = x.sn.partilha;
      const shareCbs = cof + pis, shareIbs = f * icmsIss;
      if (ano >= 2027) parcelaIbsCbsDas += (valor * (shareCbs + shareIbs)) / 100;
    }
    const cppForaDas = dasPartes.some((x) => x.anexo === "IV") ? (cpp * (Rs / Math.max(R, 1))) : 0;
    const icmsIssForaSimples = acimaSublimite ? icms + iss : 0; // acima do sublimite ICMS/ISS saem do DAS
    const motivoSn = acimaTeto ? "Receita acima de R$ 4,8 milhões — fora do limite do Simples Nacional" : undefined;
    regimes.push(mk("sn_dentro", [
      { nome: "DAS (Simples Nacional)", valor: das },
      ...(cppForaDas ? [{ nome: "CPP fora do DAS (Anexo IV)", valor: cppForaDas }] : []),
      ...(icmsIssForaSimples ? [{ nome: "ICMS/ISS fora do DAS (acima do sublimite)", valor: icmsIssForaSimples }] : []),
    ], 0, b * parcelaIbsCbsDas, !acimaTeto, motivoSn));
    // ---- Simples por fora (regime regular de IBS/CBS) ----
    if (ano === 2026) {
      regimes.push(mk("sn_fora", [], 0, 0, false, "Opção disponível a partir de 2027 (Res. CGSN 190/2026)"));
    } else {
      const debito = R * t;
      const ibsCbs = Math.max(0, debito - creditoRegular);
      regimes.push(mk("sn_fora", [
        { nome: "DAS sem a parcela de IBS/CBS", valor: das - parcelaIbsCbsDas },
        { nome: "CBS + IBS a recolher (débito − crédito)", valor: ibsCbs },
        ...(cppForaDas ? [{ nome: "CPP fora do DAS (Anexo IV)", valor: cppForaDas }] : []),
        ...(icmsIssForaSimples ? [{ nome: "ICMS/ISS fora do DAS (acima do sublimite)", valor: icmsIssForaSimples }] : []),
      ], Math.min(creditoRegular, debito), credRepassadoRegular, !acimaTeto, motivoSn));
    }
    // ---- Lucro Presumido ----
    const baseIrpjP = presIrpj * fatorLc224, baseCsllP = presCsll * fatorLc224;
    const pisCofinsP = ano === 2026 ? R * 0.0365 : 0;
    const ibsCbsP = ano === 2026 ? 0 : Math.max(0, R * t - creditoRegular);
    regimes.push(mk("presumido", [
      { nome: "IRPJ", valor: irpj(baseIrpjP) }, { nome: "CSLL", valor: baseCsllP * 0.09 },
      ...(ano === 2026 ? [{ nome: "PIS/COFINS (cumulativo 3,65%)", valor: pisCofinsP }] : [{ nome: "CBS + IBS a recolher (débito − crédito)", valor: ibsCbsP }]),
      { nome: "ICMS (líquido)", valor: icms }, { nome: "ISS", valor: iss }, { nome: "INSS patronal (CPP + RAT + terceiros)", valor: cpp },
    ], ano === 2026 ? 0 : Math.min(creditoRegular, R * t), ano === 2026 ? 0 : credRepassadoRegular));
    // ---- Lucro Real ----
    const lucro = R * (p.margemLucro / 100);
    const pisCofinsR = ano === 2026 ? Math.max(0, R * 0.0925 - comprasRegular * 0.0925) : 0;
    regimes.push(mk("real", [
      { nome: "IRPJ", valor: irpj(Math.max(0, lucro)) }, { nome: "CSLL", valor: Math.max(0, lucro) * 0.09 },
      ...(ano === 2026 ? [{ nome: "PIS/COFINS (não cumulativo 9,25% − créditos)", valor: pisCofinsR }] : [{ nome: "CBS + IBS a recolher (débito − crédito)", valor: ibsCbsP }]),
      { nome: "ICMS (líquido)", valor: icms }, { nome: "ISS", valor: iss }, { nome: "INSS patronal (CPP + RAT + terceiros)", valor: cpp },
    ], ano === 2026 ? Math.min(comprasRegular * 0.0925, R * 0.0925) : Math.min(creditoRegular, R * t), ano === 2026 ? b * R * 0.0925 : credRepassadoRegular));
    const disponiveis = regimes.filter((x) => x.disponivel);
    const melhor = disponiveis.length ? disponiveis.reduce((a, x) => (x.custoEfetivo < a.custoEfetivo ? x : a)).id : null;
    return { ano, titulo: ano === 2026 ? "2026 — hoje (ano-teste)" : ano === 2027 ? "2027 — CBS plena, fim do PIS/COFINS" : "2033 — IBS pleno, fim do ICMS/ISS", regimes, melhor };
  });

  // ---- Leitura técnica e recomendação (regras de decisão de mercado) ----
  const r27 = resultado[1], r33 = resultado[2];
  const get = (a: ResultadoAno, id: RegimeId) => a.regimes.find((x) => x.id === id)!;
  const pontos: { tipo: "favor" | "atencao" | "info"; texto: string }[] = [];
  const pctB2B = Math.round(b * 100);
  if (b < 0.2) pontos.push({ tipo: "info", texto: `Vendas majoritariamente a consumidor final (${pctB2B}% para empresas): o crédito de IBS/CBS tem pouco valor para quem compra, o que favorece manter o IBS/CBS dentro do DAS.` });
  if (b >= 0.6) pontos.push({ tipo: "atencao", texto: `${pctB2B}% das vendas vão para empresas. A partir de 2027, clientes do regime regular tomam crédito integral (${(get(r27, "sn_fora").creditoRepassado / Math.max(b * R, 1) * 100).toFixed(1).replace(".", ",")}% do preço) de fornecedores no regime regular, mas só o valor da partilha do DAS (${(get(r27, "sn_dentro").creditoRepassado / Math.max(b * R, 1) * 100).toFixed(2).replace(".", ",")}%) de quem fica no Simples por dentro — risco comercial de perder clientes para concorrentes que geram crédito.` });
  if (anexoServ === "V" && p.anexoServicos === "III/V" && fatorR >= 20 && fatorR < 28) pontos.push({ tipo: "favor", texto: `Fator R em ${fatorR.toFixed(1).replace(".", ",")}%: perto dos 28%. Ajustar o pró-labore pode levar os serviços do Anexo V para o Anexo III (alíquota menor).` });
  if (p.anexoServicos === "IV" && Rs > 0) pontos.push({ tipo: "atencao", texto: "Atividade do Anexo IV: a contribuição patronal (CPP) é paga fora do DAS, sobre a folha — isso reduz a vantagem do Simples." });
  if (R > 3600000) pontos.push({ tipo: "atencao", texto: "Receita acima do sublimite de R$ 3,6 milhões: ICMS e ISS (e o IBS) saem do DAS e são pagos pelas regras normais, o que reduz a atratividade do Simples." });
  if (R > 4800000) pontos.push({ tipo: "atencao", texto: "Receita acima de R$ 4,8 milhões: a empresa não pode estar no Simples Nacional." });
  if (p.margemLucro < (pctMerc > 0.5 ? 8 : 32) * 0.6) pontos.push({ tipo: "favor", texto: `Margem de lucro estimada de ${p.margemLucro}% — abaixo da presunção do Lucro Presumido: no Lucro Real o IRPJ/CSLL incidem só sobre o lucro efetivo.` });
  if (d.comprasSimples12m > d.comprasRegular12m) pontos.push({ tipo: "atencao", texto: "A maior parte das compras vem de fornecedores do Simples Nacional: o crédito de IBS/CBS nas entradas é pequeno, o que encarece os regimes com IBS/CBS por fora." });
  if (p.reducaoSetorial) pontos.push({ tipo: "info", texto: `Atividade com redução de ${p.reducaoSetorial}% nas alíquotas de IBS/CBS (LC 214/2025): aplicada nos regimes com IBS/CBS por fora.` });
  if (R > 5000000 && p.acrescimoLc224) pontos.push({ tipo: "info", texto: "Lucro Presumido com o acréscimo de 10% na presunção sobre a receita acima de R$ 5 milhões (LC 224/2025) — medida questionada no STF; há empresas com liminar." });
  const ordem = (a: ResultadoAno) => a.regimes.filter((x) => x.disponivel).sort((x, y) => x.custoEfetivo - y.custoEfetivo);
  const o27 = ordem(r27), o33 = ordem(r33);
  const melhor27 = o27[0], segundo27 = o27[1];
  let recomendacao = "";
  if (melhor27) {
    const eco = segundo27 ? segundo27.custoEfetivo - melhor27.custoEfetivo : 0;
    const brl = (v: number) => "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    recomendacao = `Pelos dados dos últimos 12 meses, o menor custo efetivo em 2027 é no ${melhor27.label} (${melhor27.custoEfetivoPct.toFixed(2).replace(".", ",")}% da receita; carga própria de ${melhor27.cargaPropriaPct.toFixed(2).replace(".", ",")}%)${eco > 0 ? `, com vantagem estimada de ${brl(eco)} por ano sobre a segunda opção (${segundo27!.label})` : ""}.`;
    if (o33[0] && o33[0].id !== melhor27.id) recomendacao += ` No regime pleno (2033) a melhor opção passa a ser ${o33[0].label} — a decisão deve ser revista ao longo da transição.`;
    const dentro = get(r27, "sn_dentro"), fora = get(r27, "sn_fora");
    if (dentro.disponivel && fora.disponivel && b >= 0.4) {
      const custoExtra = fora.cargaPropria + fora.ibsCbsPorFora * (1 - b) - dentro.cargaPropria, credExtra = fora.creditoRepassado - dentro.creditoRepassado;
      recomendacao += custoExtra < credExtra
        ? ` Como ${pctB2B}% das vendas são para empresas, o IBS/CBS por fora gera R$ ${credExtra.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} a mais de crédito aos clientes ${custoExtra > 0 ? `contra R$ ${custoExtra.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} de custo adicional` : "e ainda reduz a carga da própria empresa"} — se a empresa permanecer no Simples, vale avaliar a opção pelo IBS/CBS por fora (próxima janela: 1º a 31/03/2027, efeitos em 01/07/2027).`
        : ` Mesmo com ${pctB2B}% das vendas para empresas, o IBS/CBS por fora custa mais do que o crédito adicional que gera aos clientes — manter o Simples por dentro, salvo exigência comercial dos clientes.`;
    }
  }
  return {
    entradas: {
      receitaAnual: r2(R), receitaMercadorias: r2(Rm), receitaServicos: r2(Rs), pctB2B: r2(b * 100), fatorR: r2(fatorR),
      anexoMercadorias: p.anexoMercadorias, anexoServicos: anexoServ, faixaSimples: snMerc.faixa, aliquotaEfetivaMerc: r2(snMerc.efetiva), aliquotaEfetivaServ: r2(snServ.efetiva),
      comprasComCredito: r2(comprasRegular), comprasSimples: r2(comprasSimples), cpp: r2(cpp),
    },
    anos: resultado, pontos, recomendacao,
  };
}
