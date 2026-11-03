// PDF do Diagnóstico de Regime Tributário pós-reforma — documento que o escritório entrega ao cliente:
// timbrado, identificação, sumário executivo, quadro comparativo dos regimes (2026/2027/2033), detalhe por
// tributo, pontos de vista, prazos, premissas, fundamentação, ressalvas e assinatura dos sócios.
const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const brl = (v: number) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v: number) => (Number(v) || 0).toFixed(2).replace(".", ",") + "%";
const fmtDoc = (d: string) => {
  const x = String(d || "").replace(/\D/g, "");
  if (x.length === 14) return x.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  if (x.length === 11) return x.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  return d || "";
};
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const COR: Record<string, string> = { sn_dentro: "#eb6834", sn_fora: "#1baf7a", presumido: "#6250d6", real: "#2a78d6" };

export const FUNDAMENTACAO_DIAGNOSTICO = [
  "Emenda Constitucional nº 132/2023 — Reforma Tributária do consumo (IBS e CBS) e transição 2026–2033 (ADCT).",
  "Lei Complementar nº 214/2025 (com alterações da LC nº 227/2026) — IBS/CBS: não cumulatividade e crédito amplo (art. 47), vedação de crédito para uso e consumo pessoal (art. 57), reduções de 30% e 60% (arts. 127 e seguintes), alíquotas de transição (arts. 343 a 348), opção do Simples Nacional pelo regime regular (art. 41, §3º).",
  "Lei Complementar nº 123/2006 — Simples Nacional: Anexos I a V, alíquota efetiva (art. 18, §1º-A), Fator R (art. 18, §§5º-J e 5º-M), sublimite de ICMS/ISS (art. 13-A).",
  "Resolução CGSN nº 140/2018, com a Resolução CGSN nº 190/2026 (art. 22-A — IBS/CBS pelo regime regular pelo optante) e a Resolução CGSN nº 194/2026 (prazos de opção).",
  "Lei nº 9.249/1995, arts. 15 e 20 — presunção do Lucro Presumido; Lei Complementar nº 224/2025 — acréscimo de 10% na presunção sobre a receita acima de R$ 5 milhões (questionado no STF).",
  "Lei nº 14.973/2024 — reoneração gradual da folha (2025–2028).",
];
export const RESSALVAS_DIAGNOSTICO = [
  "A alíquota de referência da CBS de 2027 ainda depende de resolução do Senado (prazo 15/12/2026); as alíquotas de IBS de 2029–2033 são estimativas. Os valores devem ser revistos quando forem publicadas.",
  "As tabelas de partilha do Simples Nacional de 2027 a 2033 seguem os anexos da LC nº 214/2025 (com a LC nº 227/2026) e podem ser alteradas.",
  "ICMS e ISS foram estimados por premissa (carga líquida e alíquota informadas); benefícios fiscais estaduais, substituição tributária e regimes especiais não foram modelados.",
  "Folha de pagamento, pró-labore e margem de lucro são premissas — o resultado é sensível a elas.",
  "O crédito de IBS/CBS depende do pagamento do tributo pelo fornecedor (inclusive split payment) e não alcança uso e consumo pessoal.",
  "Este diagnóstico é uma estimativa gerencial com base nos documentos fiscais disponíveis no sistema; não constitui parecer jurídico. A decisão deve ser validada com o contador responsável.",
];

export function htmlDiagnostico(d: any, escritorio: { nome: string; cnpj: string; cidade: string; uf: string }, socios: { nome: string; registro: string }[], timbrado: string | null) {
  const e = d.empresa, r = d.resultado, en = r.entradas, p = d.premissas;
  const hoje = new Date();
  const ano27 = r.anos.find((a: any) => a.ano === 2027), ano33 = r.anos.find((a: any) => a.ano === 2033);
  const melhor = (a: any) => a.regimes.find((x: any) => x.id === a.melhor);
  const quadro = (a: any) => `<h3>${esc(a.titulo)}</h3><table class="t"><colgroup><col style="width:26%"><col style="width:13%"><col style="width:13%"><col style="width:12%"><col style="width:12%"><col style="width:12%"><col style="width:12%"></colgroup>
    <thead><tr><th>Regime</th><th class="num">Tributos a recolher</th><th class="num">IBS/CBS cobrado no preço</th><th class="num">Carga própria</th><th class="num">Custo efetivo</th><th class="num">Crédito nas entradas</th><th class="num">Crédito ao cliente B2B</th></tr></thead>
    <tbody>${a.regimes.map((g: any) => g.disponivel
      ? `<tr${g.id === a.melhor ? ' class="best"' : ""}><td><span class="sw" style="background:${COR[g.id]}"></span><b>${esc(g.label)}</b>${g.id === a.melhor ? '<br><span class="ok">✔ menor custo efetivo</span>' : ""}</td><td class="num">${brl(g.total)}</td><td class="num">${brl(g.ibsCbsPorFora)}</td><td class="num">${pct(g.cargaPropriaPct)}</td><td class="num"><b>${pct(g.custoEfetivoPct)}</b></td><td class="num">${brl(g.creditoEntradas)}</td><td class="num">${brl(g.creditoRepassado)}</td></tr>`
      : `<tr class="na"><td><span class="sw" style="background:${COR[g.id]}"></span>${esc(g.label)}</td><td colspan="6">${esc(g.motivoIndisponivel || "não disponível")}</td></tr>`).join("")}</tbody></table>`;
  const detalhe = ano27 ? `<table class="t"><thead><tr><th>Tributo (2027)</th>${ano27.regimes.map((g: any) => `<th class="num">${esc(g.label.replace("Simples Nacional", "Simples"))}</th>`).join("")}</tr></thead><tbody>${
    [...new Set(ano27.regimes.flatMap((g: any) => g.tributos.map((t: any) => t.nome)))].map((nome: any) => `<tr><td>${esc(nome)}</td>${ano27.regimes.map((g: any) => { const t = g.tributos.find((x: any) => x.nome === nome); return `<td class="num">${g.disponivel && t ? brl(t.valor) : "—"}</td>`; }).join("")}</tr>`).join("")
  }<tr class="tot"><td>Total a recolher</td>${ano27.regimes.map((g: any) => `<td class="num">${g.disponivel ? brl(g.total) : "—"}</td>`).join("")}</tr></tbody></table>` : "";
  const premissas: [string, string][] = [
    ["Receita anual considerada", brl(en.receitaAnual) + (p.receitaAnual ? " (informada)" : " (NF-e/NFS-e emitidas, 12 meses)")],
    ["Mercadorias / serviços", `${brl(en.receitaMercadorias)} / ${brl(en.receitaServicos)}`],
    ["Vendas para empresas (B2B)", pct(en.pctB2B)],
    ["Compras de fornecedores do regime regular (com crédito)", brl(en.comprasComCredito)],
    ["Compras de fornecedores do Simples", brl(en.comprasSimples) + ` (crédito médio ${String(p.creditoMedioComprasSimples).replace(".", ",")}%)`],
    ["Folha anual / pró-labore anual", `${brl(p.folhaAnual)} / ${brl(p.proLaboreAnual)} · Fator R ${pct(en.fatorR)}`],
    ["Encargos sobre a folha fora do Simples", pct(p.encargosFolhaPct)],
    ["Simples Nacional", `Mercadorias: Anexo ${en.anexoMercadorias} (alíq. efetiva ${pct(en.aliquotaEfetivaMerc)}) · Serviços: Anexo ${en.anexoServicos} (${pct(en.aliquotaEfetivaServ)}) · faixa ${en.faixaSimples}`],
    ["Lucro Presumido", `IRPJ ${p.presuncaoIrpjMerc}%/${p.presuncaoIrpjServ}% · CSLL ${p.presuncaoCsllMerc}%/${p.presuncaoCsllServ}% (mercadorias/serviços)${p.acrescimoLc224 ? " · acréscimo LC 224/2025 acima de R$ 5 mi" : ""}`],
    ["Lucro Real", `margem de lucro ${pct(p.margemLucro)}`],
    ["IBS/CBS", `CBS de referência ${String(p.cbsReferencia).replace(".", ",")}% (2027: −0,1 p.p.) · IBS de referência em 2033 ${String(p.ibsReferencia2033).replace(".", ",")}%${p.reducaoSetorial ? ` · redução setorial ${p.reducaoSetorial}%` : ""}`],
    ["ICMS / ISS (fora do Simples)", `ICMS líquido ${pct(p.icmsLiquidoPct)} das mercadorias · ISS ${pct(p.issPct)} dos serviços (reduzidos na transição 2029–2032)`],
  ];
  const corpo = `
  <h1>Diagnóstico Tributário — Regime pós-Reforma Tributária (IBS/CBS)</h1>
  <p class="sub">${esc(escritorio.nome)} · ${hoje.toLocaleDateString("pt-BR")}</p>
  <div class="ident"><div><span class="mut">EMPRESA</span><br><b>${esc(e.nome)}</b><br>CNPJ ${esc(fmtDoc(e.cnpj))}${e.cidade ? ` · ${esc(e.cidade)}/${esc(e.uf || "")}` : ""}</div>
    <div><span class="mut">ATIVIDADE E REGIME ATUAL</span><br>${e.cnae ? `CNAE ${esc(e.cnae)} — ${esc(e.cnaeDescricao || "")}<br>` : ""}Regime atual: <b>${esc(e.regimeLabel)}</b><br><span class="mut">Dados: ${esc(d.periodo.descricao)}</span></div></div>

  <h2>1. Sumário executivo</h2>
  <div class="reco">${esc(r.recomendacao)}</div>
  <div class="badges">${ano27 ? `<div class="badge"><span class="mut">Melhor em 2027</span><br><b>${esc(melhor(ano27)?.label || "—")}</b><br>custo efetivo ${pct(melhor(ano27)?.custoEfetivoPct)}</div>` : ""}${ano33 ? `<div class="badge"><span class="mut">Melhor em 2033 (regime pleno)</span><br><b>${esc(melhor(ano33)?.label || "—")}</b><br>custo efetivo ${pct(melhor(ano33)?.custoEfetivoPct)}</div>` : ""}
    <div class="badge"><span class="mut">Vendas para empresas</span><br><b>${pct(en.pctB2B)}</b><br>da receita</div></div>

  <h2>2. Quadro comparativo dos regimes</h2>
  <p class="txt"><b>Como ler:</b> <i>tributos a recolher</i> soma tudo o que a empresa paga; nos regimes com IBS/CBS por fora, esse imposto é cobrado do cliente além do preço (neutro para o cliente empresa, que o recupera como crédito). <i>Carga própria</i> é o que sai do resultado da empresa. <i>Custo efetivo</i> (critério da recomendação) soma a carga própria, o IBS/CBS sobre as vendas a consumidor final (que pressiona o preço) e, no Simples por dentro, o crédito que os clientes empresas deixam de tomar em comparação com um fornecedor do regime regular.</p>
  ${r.anos.map(quadro).join("")}

  <h2>3. Detalhamento por tributo — 2027</h2>
  ${detalhe}

  <h2>4. Pontos de atenção e argumentos técnicos</h2>
  <ul class="pts">${r.pontos.map((x: any) => `<li class="${x.tipo}">${esc(x.texto)}</li>`).join("") || "<li>Sem pontos de atenção específicos com os dados disponíveis.</li>"}
    <li class="info">Crédito nas entradas: a partir de 2027 o IBS/CBS pago nas compras de fornecedores do regime regular vira crédito (crédito financeiro amplo, LC 214, art. 47) nos regimes com IBS/CBS por fora; no Simples por dentro não há crédito para a empresa.</li>
    <li class="info">Repasse de crédito: o cliente empresa do regime regular toma crédito integral do IBS/CBS destacado por fornecedor do regime regular; de fornecedor do Simples por dentro, só o valor da partilha do DAS.</li>
    <li class="info">Compensação nas saídas: no regime regular o IBS/CBS a recolher é o débito das vendas menos os créditos das compras; saldo credor pode ser ressarcido nos termos da LC 214.</li></ul>

  <h2>5. Prazos e próximos passos</h2>
  <ul class="pts">
    <li>Simples Nacional com IBS/CBS por fora: opção semestral no Portal do Simples — <b>1º a 31/03/2027</b> (efeitos a partir de 01/07/2027) e 1º a 30/09 para o semestre seguinte. A janela do 1º semestre de 2027 encerrou em 30/10/2026.</li>
    <li>Entrada ou permanência no Simples Nacional: opção em janeiro de cada ano. Lucro Presumido ou Real: opção com o pagamento do primeiro tributo do ano (irretratável no ano-calendário).</li>
    <li>Rever este diagnóstico quando o Senado publicar a alíquota de referência da CBS e a cada ano da transição (2027, 2029 e 2033).</li>
  </ul>

  <h2>6. Premissas utilizadas</h2>
  <table class="t"><colgroup><col style="width:38%"><col style="width:62%"></colgroup><tbody>${premissas.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</tbody></table>

  <h2>7. Fundamentação legal</h2>
  <ul class="pts">${FUNDAMENTACAO_DIAGNOSTICO.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
  <h2>8. Ressalvas</h2>
  <ul class="pts">${RESSALVAS_DIAGNOSTICO.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>

  <p class="local">${esc(escritorio.cidade || "Redenção")}, ${esc(escritorio.uf === "PA" || !escritorio.uf ? "Pará" : escritorio.uf)}, ${hoje.getDate()} de ${MESES[hoje.getMonth()]} de ${hoje.getFullYear()}.</p>
  <div class="assinaturas">${socios.map((s) => `<div class="ass"><div class="linha"></div><b>${esc(s.nome.toUpperCase())}</b><br>${esc(s.registro)}<br><span class="mut">${esc(escritorio.nome)}${escritorio.cnpj ? ` · CNPJ ${esc(fmtDoc(escritorio.cnpj))}` : ""}</span></div>`).join("")}</div>`;
  const bg = timbrado ? `<img class="bg" src="${timbrado}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Diagnóstico Tributário</title><style>
  @page { size: A4; margin: ${timbrado ? "0" : "16mm 14mm"}; }
  html, body { margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1c2b24; font-size: 10px; }
  .bg { position: fixed; top: 0; left: 0; width: 210mm; height: 297mm; z-index: -1; }
  table.layout { width: 210mm; border-collapse: collapse; } table.layout > thead td, table.layout > tfoot td, table.layout > tbody > tr > td.corpo { border: none; padding: 0; }
  .espaco-topo { height: ${timbrado ? "46mm" : "0"}; } .espaco-rodape { height: ${timbrado ? "38mm" : "0"}; }
  td.corpo { padding: 0 ${timbrado ? "20mm" : "0"} !important; vertical-align: top; }
  h1 { font-size: 15.5px; margin: 0 0 2px; } h2 { font-size: 12.5px; margin: 14px 0 6px; color: #154d36; break-after: avoid; } h3 { font-size: 10.5px; margin: 10px 0 4px; break-after: avoid; }
  .sub { font-size: 10.5px; color: #5b6b63; margin: 0 0 10px; } .mut { color: #5b6b63; font-size: 8.5px; letter-spacing: .03em; }
  .ident { display: flex; gap: 10px; } .ident > div { flex: 1; background: rgba(238,245,241,.92); border-radius: 8px; padding: 8px 10px; line-height: 1.5; }
  .reco { padding: 9px 11px; border-left: 4px solid #1f6f4d; background: rgba(238,245,241,.92); font-size: 10.5px; line-height: 1.55; text-align: justify; }
  .badges { display: flex; gap: 8px; margin-top: 8px; } .badge { flex: 1; border: 1px solid #d5ded9; border-radius: 8px; padding: 7px 9px; background: rgba(255,255,255,.93); line-height: 1.45; }
  .txt { font-size: 9.6px; line-height: 1.5; text-align: justify; margin: 0 0 6px; }
  table.t { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 9px; background: rgba(255,255,255,.93); }
  table.t th { text-align: left; background: #eef5f1; padding: 4px 5px; border: 1px solid #d5ded9; font-size: 8px; text-transform: uppercase; letter-spacing: .03em; color: #3c584a; }
  table.t td { padding: 4px 5px; border: 1px solid #e3e9e6; vertical-align: top; } .num { text-align: right; } td.num { white-space: nowrap; } table.t th { white-space: normal; line-height: 1.25; vertical-align: bottom; }
  tr { break-inside: avoid; } tr.best td { background: rgba(31,138,82,.08); } tr.na td { color: #8a948f; } tr.tot td { font-weight: 700; background: #f7faf9; }
  .ok { color: #1f8a52; font-size: 8.5px; font-weight: 700; } .sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
  ul.pts { margin: 0; padding-left: 16px; font-size: 9.6px; line-height: 1.55; } ul.pts li { margin-bottom: 3px; text-align: justify; }
  ul.pts li.atencao::marker { color: #c0392b; } ul.pts li.favor::marker { color: #1f8a52; }
  .local { margin: 22px 0 30px; text-align: right; font-size: 10.5px; break-before: avoid; }
  .assinaturas { display: flex; gap: 24px; justify-content: space-around; break-inside: avoid; }
  .ass { flex: 1; text-align: center; font-size: 9.6px; line-height: 1.45; } .ass .linha { border-top: 1px solid #333; margin: 0 10px 4px; }
  </style></head><body>${bg}<table class="layout"><thead><tr><td class="espaco-topo"></td></tr></thead><tfoot><tr><td class="espaco-rodape"></td></tr></tfoot><tbody><tr><td class="corpo">${corpo}</td></tr></tbody></table></body></html>`;
}

export async function gerarPdfDiagnostico(...args: Parameters<typeof htmlDiagnostico>): Promise<Buffer> {
  const html = htmlDiagnostico(...args);
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
