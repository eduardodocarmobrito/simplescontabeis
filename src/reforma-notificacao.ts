// PDFs de saída da auditoria da Reforma Tributária, com o timbrado do escritório:
//  - Relatório/notificação POR FORNECEDOR (um ou vários): tudo o que está errado no preenchimento do
//    IBS/CBS das notas dele, nota a nota e item a item (tag, NCM vencido, classificação, alíquota, base…),
//    com o preenchimento esperado e a fundamentação — pra empresa mandar ao fornecedor.
//  - Mapa de NCM × classificação tributária, só com as linhas do filtro aplicado na tela.
const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const brl = (v: number) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dataBR = (iso: string) => (iso ? String(iso).slice(0, 10).split("-").reverse().join("/") : "");
const fmtDoc = (d: string) => {
  const x = String(d || "").replace(/\D/g, "");
  if (x.length === 14) return x.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  if (x.length === 11) return x.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  return d || "";
};
const ncmFmt = (n: string) => (/^\d{8}$/.test(n || "") ? n.replace(/(\d{4})(\d{2})(\d{2})/, "$1.$2.$3") : n || "—");
const SEV: Record<string, { cor: string; ic: string; label: string }> = {
  alta: { cor: "#c0392b", ic: "⛔", label: "Alta" }, media: { cor: "#a5730a", ic: "⚠", label: "Média" }, baixa: { cor: "#5b6b63", ic: "•", label: "Baixa" }, info: { cor: "#2a78d6", ic: "ℹ", label: "Informativo" },
};
// Fundamentação por regra (vai na coluna "Base legal/técnica" do relatório ao fornecedor).
const FUNDAMENTO: Record<string, string> = {
  GRUPO_AUSENTE: "LC 214/2025; NT 2025.002-RTC v1.53, grupo UB12 (IBSCBS); Ato Conjunto RFB/CGIBS nº 4/2026",
  CST_INEXISTENTE: "IT 2025.002 v1.71 (tabela CST); NT 2025.002, regra UB13",
  CCLASSTRIB_INEXISTENTE: "IT 2025.002 v1.71 (tabela cClassTrib); NT 2025.002, regra UB14-10",
  CST_X_CCLASSTRIB: "NT 2025.002, regra UB14-20; IT 2025.002 v1.71",
  CCLASSTRIB_FORA_VIGENCIA: "IT 2025.002 v1.71 (dIniVig/dFimVig)",
  CCLASSTRIB_FORA_LISTA: "Calculadora de Tributos RFB/CGIBS — lista oficial vigente",
  CCLASSTRIB_MODELO: "NT 2025.002, regra UB14-25",
  NCM_FORA_ANEXO: "LC 214/2025 (anexos de redução); Calculadora RFB/CGIBS — ncm-aplicavel",
  NCM_NAO_VIGENTE: "Nomenclatura Comum do Mercosul vigente; Calculadora RFB/CGIBS — dados-abertos/ncm",
  NCM_INVALIDO: "NT 2025.002 / leiaute NF-e (NCM com 8 dígitos)",
  NCM_EXTINTO_DEPOIS: "Nomenclatura Comum do Mercosul vigente",
  ALIQUOTA_DIVERGENTE: "LC 214/2025, arts. 343, 344 e 346; NT 2025.002, regras UB18/UB37/UB56",
  REDUCAO_NAO_INFORMADA: "IT 2025.002 v1.71 (pRedIBS/pRedCBS); NT 2025.002, grupo gRed",
  REDUCAO_INCOERENTE: "NT 2025.002, regra UB28 (pAliqEfet = alíquota × (1 − pRedAliq/100))",
  VALOR_DIVERGENTE: "NT 2025.002, regras de valor (v = vBC × alíquota efetiva − vDif − vDevTrib)",
  BASE_DIVERGENTE: "NT 2025.002, regra UB16-10 (base de cálculo do IBS/CBS)",
  TOTAL_DIVERGENTE: "NT 2025.002, grupo W03 (IBSCBSTot = soma dos itens)",
  SEM_INCIDENCIA_EM_VENDA: "LC 214/2025, art. 4º; IT 2025.002 v1.71 (CST 410)",
  REDUCAO_ESQUECIDA: "LC 214/2025 (Anexos I e VII); Calculadora RFB/CGIBS — ncm-aplicavel",
  SN_SEM_REGIME: "NT 2026.005 v1.00 (tpRegimeIBSCBS e gTribSN)",
  SN_OPCAO_INCONSISTENTE: "NT 2026.005 v1.00; LC 214/2025, art. 41 §3º",
  MEI_COM_IBSCBS: "NT 2026.005 v1.00 (CRT 4)",
};

function pagina(corpo: string, titulo: string, css: string, timbrado: string | null) {
  const bg = timbrado ? `<img class="bg" src="${timbrado}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(titulo)}</title><style>
  @page { size: A4; margin: ${timbrado ? "0" : "16mm 14mm"}; }
  html, body { margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1c2b24; font-size: 10px; }
  .bg { position: fixed; top: 0; left: 0; width: 210mm; height: 297mm; z-index: -1; }
  table.layout { width: 210mm; border-collapse: collapse; } table.layout > thead td, table.layout > tfoot td, table.layout > tbody > tr > td.corpo { border: none; padding: 0; }
  .espaco-topo { height: ${timbrado ? "46mm" : "0"}; } .espaco-rodape { height: ${timbrado ? "38mm" : "0"}; }
  td.corpo { padding: 0 ${timbrado ? "18mm" : "0"} !important; vertical-align: top; }
  h1 { font-size: 15px; margin: 0 0 2px; } h2 { font-size: 12.5px; margin: 12px 0 5px; color: #154d36; break-after: avoid; }
  .sub { font-size: 10.5px; color: #5b6b63; margin: 0 0 10px; }
  .mut { color: #5b6b63; } code { font-size: 8.3px; background: #f2f5f3; padding: 1px 3px; border-radius: 3px; word-break: break-all; }
  table.t:not(.layout) { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 8.8px; background: rgba(255,255,255,.93); }
  table.t th { text-align: left; background: #eef5f1; padding: 4px 5px; border: 1px solid #d5ded9; font-size: 8px; text-transform: uppercase; letter-spacing: .03em; color: #3c584a; }
  table.t td { padding: 4px 5px; border: 1px solid #e3e9e6; vertical-align: top; word-wrap: break-word; }
  tr { break-inside: avoid; } .num { text-align: right; }
  ${css}
  </style></head><body>${bg}<table class="layout"><thead><tr><td class="espaco-topo"></td></tr></thead><tfoot><tr><td class="espaco-rodape"></td></tr></tfoot><tbody><tr><td class="corpo">${corpo}</td></tr></tbody></table></body></html>`;
}

async function pdf(html: string): Promise<Buffer> {
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

export interface FornecedorNotificacao {
  cnpj: string; nome: string; uf: string; regimeLabel: string; notas: number; itens: number; valor: number; recomendacao: string;
  achados: any[];
}
export function htmlNotificacaoFornecedores(emp: { nome: string; cnpj: string; regimeLabel: string }, periodo: { de: string; ate: string }, forns: FornecedorNotificacao[], escritorioNome: string, timbrado: string | null) {
  const hoje = new Date().toLocaleDateString("pt-BR");
  const secoes = forns.map((f, idx) => {
    const ach = f.achados.filter((a) => a.severidade !== "info" || a.regra === "PRODUTOR_RURAL_PF");
    const porRegra = new Map<string, { titulo: string; sev: string; qtd: number }>();
    for (const a of ach) {
      const k = a.regra; const t = porRegra.get(k) || { titulo: String(a.titulo).replace(/ \((IBS UF|IBS Mun|CBS)\)$/, ""), sev: a.severidade, qtd: 0 };
      t.qtd++; porRegra.set(k, t);
    }
    const ord: Record<string, number> = { alta: 0, media: 1, baixa: 2, info: 3 };
    const resumo = [...porRegra.entries()].sort((a, b) => ord[a[1].sev] - ord[b[1].sev] || b[1].qtd - a[1].qtd);
    const notas = new Map<string, any[]>();
    for (const a of [...ach].sort((x, y) => String(y.dhEmi).localeCompare(String(x.dhEmi)) || (x.nItem || 0) - (y.nItem || 0))) {
      const k = `${a.numero}|${a.serie}|${a.dhEmi}|${a.chave}`;
      if (!notas.has(k)) notas.set(k, []);
      notas.get(k)!.push(a);
    }
    const linhasNotas = [...notas.entries()].map(([k, lst]) => {
      const [numero, serie, dh, chave] = k.split("|");
      return `<tr class="nf"><td colspan="5"><b>NF-e ${esc(numero)}${serie ? "/" + esc(serie) : ""}</b> · emissão ${dataBR(dh)} · chave <span class="mut">${esc(chave)}</span></td></tr>` +
        lst.map((a) => `<tr><td class="c">${a.nItem || "—"}</td><td>${a.produto ? `<b>${esc(a.produto)}</b><br><span class="mut">NCM ${ncmFmt(a.ncm)}${a.cfop ? " · CFOP " + esc(a.cfop) : ""}</span>` : '<span class="mut">nota inteira</span>'}</td>
          <td><span style="color:${SEV[a.severidade].cor}; font-weight:700;">${SEV[a.severidade].ic} ${esc(String(a.titulo))}</span><br>${esc(String(a.detalhe).replace(/^Item \d+ — [^:]+: /, ""))}</td>
          <td><code>${esc(a.evidencia)}</code>${a.esperado ? `<div class="esp"><b>Correto:</b> <code>${esc(a.esperado)}</code></div>` : ""}</td>
          <td class="mut">${esc(FUNDAMENTO[a.regra] || "LC 214/2025; NT 2025.002-RTC")}</td></tr>`).join("");
    }).join("");
    return `<section class="forn">
      <h1>Relatório de inconsistências no preenchimento do IBS/CBS</h1>
      <p class="sub">${esc(escritorioNome)} · emitido em ${hoje} · período analisado: ${dataBR(periodo.de)} a ${dataBR(periodo.ate)}${forns.length > 1 ? ` · fornecedor ${idx + 1} de ${forns.length}` : ""}</p>
      <table class="t partes"><tr><td style="width:50%"><span class="mut">FORNECEDOR (emitente)</span><br><b>${esc(f.nome)}</b><br>CNPJ/CPF ${esc(fmtDoc(f.cnpj))} · ${esc(f.uf)}<br>${esc(f.regimeLabel)}</td>
        <td><span class="mut">DESTINATÁRIO (adquirente)</span><br><b>${esc(emp.nome)}</b><br>CNPJ ${esc(fmtDoc(emp.cnpj))}<br>${esc(emp.regimeLabel)}</td></tr></table>
      <p class="txt">Prezados, ao auditar as NF-e emitidas por ${esc(f.nome)} para ${esc(emp.nome)} no período acima (${f.notas} nota(s), ${f.itens} item(ns), ${brl(f.valor)}), com base no leiaute oficial da NF-e para o IBS/CBS (NT 2025.002-RTC v1.53 e NT 2026.005), na tabela oficial de classificação tributária (IT 2025.002 v1.71) e na validação da Calculadora de Tributos da Receita Federal, identificamos ${ach.length ? `<b>${ach.length} ocorrência(s)</b>, detalhadas abaixo com a tag do XML, o preenchimento correto e a fundamentação` : "nenhuma inconsistência no preenchimento"}. Solicitamos a correção das próximas emissões e, quando cabível, a emissão de CC-e ou NF-e complementar/substituta.</p>
      ${resumo.length ? `<h2>Resumo das ocorrências</h2><table class="t"><colgroup><col style="width:70%"><col style="width:15%"><col style="width:15%"></colgroup><thead><tr><th>Ocorrência</th><th>Gravidade</th><th class="num">Qtd.</th></tr></thead><tbody>
        ${resumo.map(([, r]) => `<tr><td>${esc(r.titulo)}</td><td style="color:${SEV[r.sev].cor};">${SEV[r.sev].ic} ${SEV[r.sev].label}</td><td class="num">${r.qtd}</td></tr>`).join("")}</tbody></table>` : ""}
      <div class="reco"><b>O que precisa ser feito:</b> ${esc(f.recomendacao)}</div>
      ${linhasNotas ? `<h2>Detalhamento nota a nota</h2><table class="t det"><colgroup><col style="width:5%"><col style="width:19%"><col style="width:30%"><col style="width:30%"><col style="width:16%"></colgroup>
        <thead><tr><th>Item</th><th>Produto / NCM</th><th>Inconsistência</th><th>Evidência no XML → preenchimento correto</th><th>Base legal/técnica</th></tr></thead><tbody>${linhasNotas}</tbody></table>` : ""}
      <p class="txt" style="margin-top:10px;">Ficamos à disposição para esclarecimentos. Atenciosamente,</p>
      <p class="ass"><b>${esc(emp.nome)}</b><br>Setor de Compras / Fiscal<br><span class="mut">Análise técnica: ${esc(escritorioNome)}</span></p>
    </section>`;
  }).join("");
  return pagina(secoes, "Relatório de inconsistências IBS/CBS", `
    section.forn { break-after: page; } section.forn:last-child { break-after: auto; }
    table.partes td { font-size: 9.5px; line-height: 1.45; padding: 6px 8px; }
    .txt { font-size: 10px; line-height: 1.55; text-align: justify; margin: 8px 0; }
    .reco { margin: 8px 0; padding: 6px 8px; border-left: 4px solid #eb6834; background: rgba(255,255,255,.93); font-size: 9.6px; line-height: 1.45; }
    tr.nf td { background: #f3f7f5; font-size: 9px; } td.c { text-align: center; }
    .esp { margin-top: 3px; } .ass { font-size: 10px; line-height: 1.5; margin-top: 18px; }`, timbrado);
}
export function gerarPdfNotificacaoFornecedores(...args: Parameters<typeof htmlNotificacaoFornecedores>) {
  return pdf(htmlNotificacaoFornecedores(...args));
}

const ST_LABEL: Record<string, string> = { ok: "✔ Validado", ncm_vencido: "⛔ NCM vencido", fora_anexo: "⛔ Redução indevida", reducao_esquecida: "💡 Redução não aplicada", pendente: "⏳ Validando na RFB", sem_grupo: "— Sem IBS/CBS" };
export function htmlMapaNcm(emp: { nome: string; cnpj: string }, periodo: { de: string; ate: string }, filtroDescricao: string, ncms: any[], escritorioNome: string, timbrado: string | null) {
  const total = ncms.reduce((a, n) => a + (Number(n.valor) || 0), 0);
  const corpo = `<h1>Mapa de NCM × classificação tributária (IBS/CBS)</h1>
    <p class="sub">${esc(emp.nome)} · CNPJ ${esc(fmtDoc(emp.cnpj))} · ${dataBR(periodo.de)} a ${dataBR(periodo.ate)} · ${esc(escritorioNome)} · ${new Date().toLocaleDateString("pt-BR")}</p>
    <p class="sub"><b>Filtro aplicado:</b> ${esc(filtroDescricao)} · ${ncms.length} NCM · ${brl(total)}</p>
    <table class="t"><colgroup><col style="width:11%"><col style="width:35%"><col style="width:16%"><col style="width:16%"><col style="width:6%"><col style="width:6%"><col style="width:10%"></colgroup>
      <thead><tr><th>NCM</th><th>Produto</th><th>cClassTrib usado</th><th>Validação oficial (RFB)</th><th class="num">Itens</th><th class="num">Forn.</th><th class="num">Valor</th></tr></thead>
      <tbody>${ncms.map((n) => `<tr><td><b>${ncmFmt(n.ncm)}</b></td><td>${esc(n.descricao)}${n.descricaoOficial ? `<br><span class="mut">TEC: ${esc(n.descricaoOficial)}</span>` : ""}</td><td>${esc((n.cClassTribs || []).join(", ") || "—")}</td><td>${ST_LABEL[n.status] || n.status}</td><td class="num">${n.itens}</td><td class="num">${n.fornecedores}</td><td class="num">${brl(n.valor)}</td></tr>`).join("")}</tbody></table>
    <p class="mut" style="margin-top:8px; font-size:8.5px;">Validação NCM × cClassTrib e vigência do NCM na Calculadora de Tributos (RFB/CGIBS); tabela de classificação IT 2025.002 v1.71, atualizada automaticamente a cada 15 dias.</p>`;
  return pagina(corpo, "Mapa de NCM", "", timbrado);
}
export function gerarPdfMapaNcm(...args: Parameters<typeof htmlMapaNcm>) {
  return pdf(htmlMapaNcm(...args));
}
