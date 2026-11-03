// Relatório em PDF da auditoria da Reforma Tributária (IBS/CBS nas notas de entrada) — o documento que o
// escritório entrega ao cliente. Padrão da casa: HTML + Playwright, timbrado do escritório de fundo em
// todas as páginas (mesma receita do contrato: espaçadores thead/tfoot que o Chromium repete por página).

const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const brl = (v: number) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numBR = (v: number) => (Number(v) || 0).toLocaleString("pt-BR");
const dataBR = (iso: string) => (iso ? String(iso).slice(0, 10).split("-").reverse().join("/") : "");
const fmtDoc = (d: string) => {
  const x = String(d || "").replace(/\D/g, "");
  if (x.length === 14) return x.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  if (x.length === 11) return x.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  return d || "";
};
const ncmFmt = (n: string) => (/^\d{8}$/.test(n) ? n.replace(/(\d{4})(\d{2})(\d{2})/, "$1.$2.$3") : n);
const COR_REGIME: Record<string, string> = { regular: "#2a78d6", sn_regular: "#1baf7a", sn_dentro: "#eb6834", sn_indefinido: "#eda100", mei: "#e87ba4", desconhecido: "#898781" };
const SEV: Record<string, { cor: string; ic: string; label: string }> = {
  alta: { cor: "#c0392b", ic: "⛔", label: "Alta" }, media: { cor: "#a5730a", ic: "⚠", label: "Média" }, baixa: { cor: "#5b6b63", ic: "•", label: "Baixa" }, info: { cor: "#2a78d6", ic: "ℹ", label: "Info" },
};
const STATUS: Record<string, { cor: string; ic: string; label: string }> = {
  conforme: { cor: "#1f8a52", ic: "✔", label: "Conforme" }, atencao: { cor: "#a5730a", ic: "⚠", label: "Atenção" }, critico: { cor: "#c0392b", ic: "⛔", label: "Crítico" },
};
const NCM_ST: Record<string, string> = { ncm_vencido: "⛔ NCM vencido na emissão", fora_anexo: "⛔ Redução indevida (NCM fora do anexo)", reducao_esquecida: "💡 Redução não aplicada" };

export function htmlRelatorioReforma(d: any, escritorioNome: string, timbrado: string | null): string {
  const k = d.kpis, e = d.empresa;
  const tot = d.mixRegime.reduce((a: number, m: any) => a + m.valor, 0) || 1;
  const pend = d.fornecedores.filter((f: any) => f.status !== "conforme" || f.regime !== "regular");
  const top3 = d.fornecedores.filter((f: any) => f.perda2027Anual > 0).slice(0, 3);
  const pctDentro = ((d.mixRegime.filter((m: any) => ["sn_dentro", "sn_indefinido", "mei"].includes(m.regime)).reduce((a: number, m: any) => a + m.valor, 0) / tot) * 100).toFixed(1).replace(".", ",");
  const resumo = `Foram auditadas <b>${numBR(k.notas)} NF-e de entrada</b> (${numBR(k.itens)} itens) de <b>${numBR(k.fornecedores)} fornecedores</b>, somando <b>${brl(k.valorCompras)}</b> em compras entre ${dataBR(d.periodo.de)} e ${dataBR(d.periodo.ate)}. ` +
    `<b>${String(k.conformidade).replace(".", ",")}%</b> das notas estão aderentes ao leiaute oficial do IBS/CBS (NT 2025.002-RTC v1.53). ` +
    `<b>${pctDentro}%</b> do valor comprado vem de fornecedores do Simples Nacional sem opção pelo regime regular ou MEI, que geram crédito limitado ou nenhum. ` +
    (k.perda2027Anual > 0 ? `Mantido o cenário atual, a estimativa é de <b>${brl(k.perda2027Anual)} por ano de crédito de IBS/CBS deixado de aproveitar em 2027</b>${top3.length ? `, concentrado em ${top3.map((f: any) => esc(f.nome)).join(", ")}` : ""}. ` : "") +
    (k.creditoRisco > 0 ? `Há <b>${brl(k.creditoRisco)}</b> de crédito destacado com erro do fornecedor (risco de glosa). ` : "") +
    (k.ncmsVencidos ? `Foram encontrados <b>${k.ncmsVencidos} NCM vencido(s)/inexistente(s)</b> na data da emissão. ` : "");
  const kpi = (t: string, v: string, s = "", dest = false) => `<div class="kpi${dest ? " dest" : ""}"><div class="kt">${t}</div><div class="kv">${v}</div>${s ? `<div class="ks">${s}</div>` : ""}</div>`;
  const forn = d.fornecedores.slice(0, 30);
  const achados = d.achados.filter((a: any) => a.severidade === "alta" || a.severidade === "media").slice(0, 45);
  const ncmsProb = d.ncms.filter((n: any) => NCM_ST[n.status]).slice(0, 40);
  const corpo = `
  <h1>Auditoria da Reforma Tributária — IBS/CBS nas notas de entrada</h1>
  <p class="sub">${esc(escritorioNome)} · gerado em ${new Date().toLocaleDateString("pt-BR")} às ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</p>
  <div class="empresa-topo"><div class="empresa-nome">${esc(e.nome)}</div><div class="empresa-sub">CNPJ ${esc(fmtDoc(e.cnpj))} · ${esc(e.regimeLabel)} · ${dataBR(d.periodo.de)} a ${dataBR(d.periodo.ate)}</div></div>
  <div class="box">${e.tomaCredito ? `Empresa do <b>${esc(e.regimeLabel)}</b>: toma crédito integral de IBS/CBS nas compras de fornecedores do regime regular; na compra de fornecedor do Simples Nacional "por dentro" o crédito é limitado ao valor pago no regime único, e na compra de MEI não há crédito (LC 214/2025, art. 47 §9º).` : `Empresa do <b>${esc(e.regimeLabel)}</b>: sem opção pelo regime regular de IBS/CBS, não há crédito; os valores de crédito indicam o que seria aproveitável com a opção.`}</div>

  <h2>Resumo executivo</h2>
  <p class="txt">${resumo}</p>
  <div class="kpis">
    ${kpi("Conformidade das notas", String(k.conformidade).replace(".", ",") + "%", `${numBR(k.notasConformes)} de ${numBR(k.notas)} notas sem falha alta/média`)}
    ${kpi("Compras auditadas", brl(k.valorCompras), `${numBR(k.fornecedores)} fornecedores`)}
    ${kpi("IBS/CBS destacado", brl(k.ibs + k.cbs), `CBS ${brl(k.cbs)} · IBS ${brl(k.ibs)}`)}
    ${kpi("Crédito aproveitável", brl(k.creditoAproveitavel), k.creditoRisco ? `${brl(k.creditoRisco)} em risco de glosa` : "sem risco de glosa")}
    ${kpi("Crédito 2027 em jogo", brl(k.perda2027Anual) + "/ano", `estimativa com CBS de ${String(d.fontes.cbs2027Estimada).replace(".", ",")}%`, true)}
    ${kpi("NCM vencido", numBR(k.ncmsVencidos), "na data da emissão")}
  </div>

  <h2>Compras por regime de IBS/CBS do fornecedor</h2>
  <div class="segbar">${d.mixRegime.map((m: any) => `<div style="width:${((m.valor / tot) * 100).toFixed(2)}%; background:${COR_REGIME[m.regime]};"></div>`).join("")}</div>
  <table><colgroup><col style="width:55%"><col style="width:20%"><col style="width:12%"><col style="width:13%"></colgroup>
    <thead><tr><th>Regime do fornecedor</th><th class="num">Compras</th><th class="num">%</th><th class="num">Notas</th></tr></thead>
    <tbody>${d.mixRegime.map((m: any) => `<tr><td><span class="sw" style="background:${COR_REGIME[m.regime]};"></span>${esc(m.label)}</td><td class="num">${brl(m.valor)}</td><td class="num">${((m.valor / tot) * 100).toFixed(1).replace(".", ",")}%</td><td class="num">${numBR(m.notas)}</td></tr>`).join("")}</tbody></table>

  <h2>Ranking de fornecedores</h2>
  <table><colgroup><col style="width:27%"><col style="width:19%"><col style="width:6%"><col style="width:13%"><col style="width:10%"><col style="width:13%"><col style="width:12%"></colgroup>
    <thead><tr><th>Fornecedor</th><th>Regime IBS/CBS</th><th class="num">NF</th><th class="num">Compras</th><th>Achados</th><th class="num">Em jogo 2027/ano</th><th>Status</th></tr></thead>
    <tbody>${forn.map((f: any) => `<tr><td><b>${esc(f.nome)}</b><br><span class="mut">${esc(fmtDoc(f.cnpj))} · ${esc(f.uf)}</span></td><td><span class="sw" style="background:${COR_REGIME[f.regime]};"></span>${esc(f.regimeLabel)}</td><td class="num">${numBR(f.notas)}</td><td class="num">${brl(f.valor)}</td>
      <td>${f.alta ? `<span style="color:#c0392b;">⛔ ${f.alta}</span> ` : ""}${f.media ? `<span style="color:#a5730a;">⚠ ${f.media}</span> ` : ""}${!f.alta && !f.media ? '<span style="color:#1f8a52;">✔</span>' : ""}</td>
      <td class="num">${f.perda2027Anual ? `<b>${brl(f.perda2027Anual)}</b>` : "—"}</td><td style="color:${STATUS[f.status].cor}; white-space:nowrap;">${STATUS[f.status].ic} ${STATUS[f.status].label}</td></tr>`).join("")}</tbody></table>
  ${d.fornecedores.length > forn.length ? `<p class="mut">+ ${d.fornecedores.length - forn.length} fornecedor(es) no painel do sistema.</p>` : ""}

  ${pend.length ? `<h2>Recomendações por fornecedor</h2>
  ${pend.slice(0, 15).map((f: any) => `<div class="reco"><div class="reco-t">${esc(f.nome)} <span class="mut">· ${esc(fmtDoc(f.cnpj))} · ${esc(f.regimeLabel)}</span></div><div>${esc(f.recomendacao)}</div></div>`).join("")}` : ""}

  ${ncmsProb.length ? `<h2>NCM com problema de classificação</h2>
  <table><colgroup><col style="width:13%"><col style="width:37%"><col style="width:18%"><col style="width:20%"><col style="width:12%"></colgroup>
    <thead><tr><th>NCM</th><th>Produto</th><th>cClassTrib usado</th><th>Validação oficial (RFB)</th><th class="num">Valor</th></tr></thead>
    <tbody>${ncmsProb.map((n: any) => `<tr><td><b>${ncmFmt(n.ncm)}</b></td><td>${esc(n.descricao)}</td><td>${esc(n.cClassTribs.join(", ") || "—")}</td><td>${NCM_ST[n.status]}</td><td class="num">${brl(n.valor)}</td></tr>`).join("")}</tbody></table>` : ""}

  ${achados.length ? `<h2>Principais evidências (nota a nota)</h2>
  ${achados.map((a: any) => `<div class="ach" style="border-left-color:${SEV[a.severidade].cor};"><div class="ach-t"><span style="color:${SEV[a.severidade].cor};">${SEV[a.severidade].ic} ${SEV[a.severidade].label}</span> · <b>${esc(a.titulo)}</b> <span class="mut">· ${esc(a.fornecedor)} · NF ${esc(a.numero)}${a.nItem ? " item " + a.nItem : ""} · ${dataBR(a.dhEmi)}</span></div>
    <div>${esc(a.detalhe)}</div><div class="ev"><span class="mut">Evidência:</span> <code>${esc(a.evidencia)}</code></div>${a.esperado ? `<div class="ev"><span class="mut">Como deveria emitir:</span> <code>${esc(a.esperado)}</code></div>` : ""}</div>`).join("")}
  ${d.achadosTotal > achados.length ? `<p class="mut">Total de ${numBR(d.achadosTotal)} achado(s) — a lista completa, com filtros e exportação, está no painel do sistema.</p>` : ""}` : ""}

  <h2>Fontes oficiais e premissas</h2>
  <ul class="fontes">
    <li><b>Leiaute:</b> ${esc(d.fontes.notasTecnicas)}.</li>
    <li><b>Tabela cClassTrib/CST:</b> ${esc(d.fontes.tabela)}. <b>NCM vigentes:</b> ${esc(d.fontes.versaoNcm)}.</li>
    <li><b>Validação oficial:</b> ${esc(d.fontes.api)}. ${esc(d.fontes.atualizacao)}</li>
    <li><b>Alíquotas:</b> 2026 — CBS 0,9%, IBS UF 0,1%, IBS Mun 0% (LC 214/2025, arts. 343 e 346; ano-teste). 2027/2028 — IBS 0,05% + 0,05% (art. 344); CBS de 2027 pendente de resolução do Senado — estimativa de ${String(d.fontes.cbs2027Estimada).replace(".", ",")}% (art. 347).</li>
    <li><b>Crédito em jogo 2027:</b> diferença entre o crédito que a empresa tomaria se o fornecedor emitisse no regime regular e o crédito efetivo, anualizada pelo período analisado; premissa de preço mantido — a decisão comercial deve comparar o custo líquido (preço − crédito).</li>
    <li><b>Simples Nacional:</b> LC 214/2025, arts. 41 §3º e 47 §9º; LC 123/2006, art. 23. Opção pelo regime regular de IBS/CBS semestral (setembro e março).</li>
  </ul>`;
  const bg = timbrado ? `<img class="bg" src="${timbrado}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Auditoria Reforma Tributária</title><style>
  @page { size: A4; margin: ${timbrado ? "0" : "16mm 14mm"}; }
  html, body { margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1c2b24; font-size: 10.5px; }
  .bg { position: fixed; top: 0; left: 0; width: 210mm; height: 297mm; z-index: -1; }
  table.layout { width: 210mm; border-collapse: collapse; border: none; } table.layout > thead td, table.layout > tfoot td, table.layout > tbody > tr > td.corpo { border: none; padding: 0; }
  .espaco-topo { height: ${timbrado ? "46mm" : "0"}; } .espaco-rodape { height: ${timbrado ? "38mm" : "0"}; }
  td.corpo { padding: 0 ${timbrado ? "20mm" : "0"} !important; vertical-align: top; }
  h1 { font-size: 17px; margin: 0 0 2px; } .sub { font-size: 11.5px; color: #5b6b63; margin: 0 0 12px; }
  h2 { font-size: 13px; margin: 16px 0 6px; color: #154d36; break-after: avoid; }
  .empresa-topo { background: #eef5f1; border-radius: 8px; padding: 8px 10px; display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .empresa-nome { font-weight: 700; font-size: 12.5px; } .empresa-sub { font-size: 10.5px; color: #5b6b63; text-align: right; }
  .box { margin-top: 8px; padding: 8px 10px; border-left: 4px solid #1f6f4d; background: rgba(238,245,241,.85); font-size: 10.5px; line-height: 1.5; }
  .txt { font-size: 11px; line-height: 1.6; text-align: justify; margin: 0 0 8px; }
  .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .kpi { border: 1px solid #e5eae7; border-radius: 8px; padding: 7px 9px; background: rgba(255,255,255,.92); break-inside: avoid; }
  .kpi.dest { border: 1.5px solid #eb6834; }
  .kt { font-size: 8.5px; text-transform: uppercase; letter-spacing: .05em; color: #5b6b63; } .kv { font-size: 15px; font-weight: 700; margin-top: 2px; } .ks { font-size: 9px; color: #5b6b63; margin-top: 2px; }
  .segbar { display: flex; gap: 2px; height: 14px; border-radius: 4px; overflow: hidden; margin: 4px 0 6px; } .segbar div { height: 100%; }
  table:not(.layout) { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 9.5px; border: 1px solid #e5eae7; background: rgba(255,255,255,.92); }
  th { text-align: left; background: #f7faf9; padding: 5px 7px; border-bottom: 1px solid #e5eae7; font-size: 8.5px; letter-spacing: .03em; text-transform: uppercase; color: #3c584a; }
  td { padding: 4px 7px; border-bottom: 1px solid #eef2f0; vertical-align: top; word-wrap: break-word; } th.num, td.num { text-align: right; }
  tr { break-inside: avoid; }
  .sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
  .mut { color: #5b6b63; font-size: 9px; }
  .reco { border-left: 3px solid #eb6834; padding: 5px 8px; margin-bottom: 5px; background: rgba(255,255,255,.92); line-height: 1.45; break-inside: avoid; } .reco-t { font-weight: 700; }
  .ach { border: 1px solid #e5eae7; border-left: 4px solid; border-radius: 6px; padding: 6px 8px; margin-bottom: 5px; line-height: 1.45; background: rgba(255,255,255,.92); break-inside: avoid; font-size: 9.5px; }
  .ach-t { margin-bottom: 2px; } .ev { margin-top: 2px; } code { font-size: 8.5px; background: #f2f5f3; padding: 1px 4px; border-radius: 3px; word-break: break-all; }
  .fontes { font-size: 9.5px; line-height: 1.55; padding-left: 16px; margin: 0; }
  </style></head><body>${bg}<table class="layout"><thead><tr><td class="espaco-topo"></td></tr></thead><tfoot><tr><td class="espaco-rodape"></td></tr></tfoot><tbody><tr><td class="corpo">${corpo}</td></tr></tbody></table></body></html>`;
}

export async function gerarPdfRelatorioReforma(d: any, escritorioNome: string, timbrado: string | null): Promise<Buffer> {
  const html = htmlRelatorioReforma(d, escritorioNome, timbrado);
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  try {
    // Mesma blindagem do contrato: JS desligado + rede bloqueada (só data:/about: passam).
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
