// Comparativo "Acompanhamento de Entradas" do Domínio (PDF) x notas de entrada do site (XMLs da Busca de XML).
// Pedido do usuário (2026-11-25): ler o PDF do Domínio, cruzar nota a nota com o que o site tem no mesmo
// período e dizer exatamente onde está cada diferença — ou "tudo certo" quando bate. Só escritório.
//
// Duas partes independentes (puras, testáveis fora do servidor):
//   1) lerAcompanhamentoEntradas(pdf) — lê o relatório pelas COORDENADAS do texto (pdf-parse/pdf.js).
//      As colunas são achadas pelo cabeçalho do próprio relatório (não por posição fixa) e a leitura se
//      autoconfere: a soma das linhas tem que bater com o "Total Geral" do rodapé, senão avisa.
//   2) compararEntradas(dominio, site, ...) — casa nota a nota (número + valor, número + fornecedor,
//      número único) e classifica cada diferença, explicando a causa quando dá pra saber pelo XML
//      (desconto não abatido, ICMS desonerado, ST/IPI/frete fora, valor líquido de NFS-e, duplicidade...).

export interface LinhaDominio {
  codigo: string; // código do lançamento no Domínio
  data: string; // data de entrada (AAAA-MM-DD)
  nota: string; // número sem zeros à esquerda
  serie: string;
  especie: string; // 36 NF-e, 39 serviço, 38 transporte, 7 energia... (código interno do Domínio)
  codFornecedor: string;
  fornecedor: string;
  cfop: string; // "1556" (sem o traço do relatório)
  acumulador: string;
  uf: string;
  valor: number; // valor contábil
  pagina: number;
}
export interface RelatorioDominio {
  empresaNome: string;
  cnpj: string; // só dígitos
  periodoDe: string | null; // AAAA-MM-DD
  periodoAte: string | null;
  linhas: LinhaDominio[];
  totalGeral: number | null; // "Total Geral" do rodapé (valor contábil)
  somaLinhas: number;
  avisos: string[];
}

const soDig = (s: string) => String(s || "").replace(/\D/g, "");
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const MONEY = /^-?[\d.]+,\d{2}$/;
const num = (s: string) => Number(String(s).replace(/\./g, "").replace(",", "."));
const dataIso = (br: string) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(br); return m ? `${m[3]}-${m[2]}-${m[1]}` : ""; };

interface Item { s: string; x: number; r: number; y: number } // x = esquerda, r = direita, y = baseline (do topo)

// ---------------------------------------------------------------- 1) Leitura do PDF
export async function lerAcompanhamentoEntradas(pdf: Buffer): Promise<RelatorioDominio> {
  const pdfParse = require("pdf-parse");
  const paginas: Item[][] = [];
  await pdfParse(pdf, {
    pagerender: async (p: any) => {
      const [x0, y0, , y1] = p.view;
      const alt = y1 - y0;
      const tc = await p.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      paginas.push(
        tc.items
          .filter((it: any) => it.str && it.str.trim())
          .map((it: any) => { const x = it.transform[4] - x0; return { s: it.str.trim(), x, r: x + (it.width || 0), y: alt - (it.transform[5] - y0) }; })
      );
      return "";
    },
  });
  const avisos: string[] = [];
  const todoTexto = paginas.flat().map((i) => i.s).join(" ");
  if (!/ACOMPANHAMENTO DE ENTRADAS/i.test(todoTexto)) {
    throw new Error('Este PDF não parece ser o relatório "Acompanhamento de Entradas" do Domínio (não achei o título).');
  }
  // Cabeçalho: empresa (1º texto da página), CNPJ e período.
  const p1 = paginas[0] || [];
  const topo = [...p1].sort((a, b) => a.y - b.y || a.x - b.x);
  const cnpjTxt = topo.find((i) => /^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/.test(i.s) || /^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(i.s));
  const per = /(\d{2}\/\d{2}\/\d{4})\s*at[ée]\s*(\d{2}\/\d{2}\/\d{4})/i.exec(todoTexto);
  const empresaNome = (topo.find((i) => i.y < 14 && !/^P[áa]gina/i.test(i.s) && !/^\d+$/.test(i.s)) || { s: "" }).s;

  const linhas: LinhaDominio[] = [];
  const vistos = new Set<string>();
  let totalGeral: number | null = null;
  paginas.forEach((itens, idx) => {
    // Agrupa por linha (mesma altura, tolerância 2pt).
    const porLinha: Item[][] = [];
    for (const it of [...itens].sort((a, b) => a.y - b.y)) {
      const l = porLinha.find((g) => Math.abs(g[0].y - it.y) <= 2);
      if (l) l.push(it); else porLinha.push([it]);
    }
    porLinha.forEach((l) => l.sort((a, b) => a.x - b.x));
    // Âncoras das colunas pelo cabeçalho da tabela desta página.
    const cab = porLinha.find((l) => l.some((i) => i.s === "CFOP") && l.some((i) => /^Fornecedor$/i.test(i.s)));
    if (!cab) return;
    const h = (re: RegExp, n = 0) => cab.filter((i) => re.test(i.s))[n];
    const hData = h(/^Data$/i), hSerie = h(/^S[ée]rie$/i), hEsp = h(/^Esp[ée]cie$/i), hForn = h(/^Fornecedor$/i);
    const hCfop = h(/^CFOP$/i), hValor = h(/^Valor Cont[áa]bil/i) || h(/^Valor$/i), hTipo = h(/^Tipo$/i);
    if (!hData || !hForn || !hCfop || !hValor) { avisos.push(`Página ${idx + 1}: cabeçalho da tabela incompleto — página ignorada.`); return; }
    for (const l of porLinha) {
      if (l.some((i) => /^Total Geral$/i.test(i.s))) {
        // Valores do total geral vêm na(s) linha(s) logo abaixo do rótulo.
        const yT = l[0].y;
        const abaixo = porLinha.filter((o) => o[0].y >= yT - 1 && o[0].y <= yT + 30).flat();
        const v = abaixo.find((i) => MONEY.test(i.s) && i.r > hValor.x && i.r <= hValor.r + 4);
        if (v) totalGeral = num(v.s);
        continue;
      }
      const dt = l.find((i) => /^\d{2}\/\d{2}\/\d{4}$/.test(i.s) && i.x < hSerie.x && i.r < hSerie.x + 10);
      // Código = o número logo antes da data (o Domínio imprime um "1" solto na margem em linhas alternadas).
      const cod = dt ? l.filter((i) => /^\d+$/.test(i.s) && i.r <= dt.x + 2).pop() : undefined;
      if (!dt || !cod) continue; // linha de imposto (IRRF/CRF/DIFALI), subtotal ou cabeçalho
      if (vistos.has(cod.s)) continue; // mesma linha repetida (quebra de página)
      // Entre a data e o fornecedor: nota, [série], espécie, código do fornecedor.
      // O pdf.js junta nota e série num item só quando ficam coladas ("443 1") — separa antes de classificar.
      const meio: Item[] = [];
      for (const i of l.filter((i) => i.x > dt.r && i.x < hForn.x - 2)) {
        const m = /^(\d+)\s+(\S+)$/.exec(i.s);
        if (m && hSerie && i.x < hSerie.x && i.r > hSerie.x) { meio.push({ ...i, s: m[1], r: hSerie.x - 1 }, { ...i, s: m[2], x: hSerie.x }); }
        else meio.push(i);
      }
      const nota = meio.find((i) => /^\d+$/.test(i.s) && i.r <= (hSerie ? hSerie.x + 1.5 : Infinity));
      const serie = hSerie ? meio.find((i) => i !== nota && i.x >= hSerie.x - 1.5 && (!hEsp || i.r < hEsp.x + 2)) : undefined;
      const resto = meio.filter((i) => i !== nota && i !== serie);
      const codForn = resto.length ? resto[resto.length - 1] : undefined;
      const especie = resto.length > 1 ? resto[resto.length - 2] : undefined;
      const fornecedor = l.filter((i) => i.x >= hForn.x - 2 && i.x < hCfop.x - 1).map((i) => i.s).join(" ").replace(/&amp;|amp;/g, "&").trim();
      const cfop = l.find((i) => /^\d-\d{3}$/.test(i.s));
      const depoisCfop = l.filter((i) => cfop && i.x > cfop.x && i.x < hValor.x);
      const uf = depoisCfop.find((i) => /^[A-Z]{2}$/.test(i.s));
      const ac = depoisCfop.find((i) => /^\d+$/.test(i.s));
      const valor = l.find((i) => MONEY.test(i.s) && i.r > hValor.x && i.r <= hValor.r + 4 && (!hTipo || i.x < hTipo.x));
      if (!nota || !valor) { avisos.push(`Página ${idx + 1}: lançamento ${cod.s} sem número da nota ou valor legível — conferir na mão.`); continue; }
      vistos.add(cod.s);
      linhas.push({
        codigo: cod.s, data: dataIso(dt.s), nota: String(Number(nota.s)), serie: serie ? serie.s : "",
        especie: especie ? especie.s : "", codFornecedor: codForn ? codForn.s : "", fornecedor,
        cfop: cfop ? cfop.s.replace("-", "") : "", acumulador: ac ? ac.s : "", uf: uf ? uf.s : "",
        valor: num(valor.s), pagina: idx + 1,
      });
    }
  });
  const somaLinhas = r2(linhas.reduce((a, l) => a + l.valor, 0));
  if (!linhas.length) throw new Error("Não consegui ler nenhum lançamento do PDF. Gere o relatório de novo no Domínio (Acompanhamento de Entradas) e tente outra vez.");
  if (totalGeral === null) avisos.push('Não achei o "Total Geral" no fim do relatório — não deu pra autoconferir a leitura (o PDF pode estar incompleto).');
  else if (Math.abs(totalGeral - somaLinhas) > 0.01) avisos.push(`A soma das linhas lidas (R$ ${fmt(somaLinhas)}) não bate com o Total Geral do PDF (R$ ${fmt(totalGeral)}) — diferença de R$ ${fmt(totalGeral - somaLinhas)}. Alguma linha pode não ter sido lida; confira na mão.`);
  return {
    empresaNome, cnpj: cnpjTxt ? soDig(cnpjTxt.s) : "",
    periodoDe: per ? dataIso(per[1]) : null, periodoAte: per ? dataIso(per[2]) : null,
    linhas, totalGeral, somaLinhas, avisos,
  };
}

// ---------------------------------------------------------------- 2) Lado do site (XML)
export interface GrupoCfop { cfop: string; bruto: number; desconto: number; deson: number; st: number; ipi: number; frete: number; outros: number; liquido: number }
export interface DocSite {
  id: number;
  tipo: string; // nfe | nfce | cte | nfse | nf3e | ...
  chave: string | null;
  numero: string;
  serie: string;
  emitenteCnpj: string;
  emitenteNome: string;
  dataEmissao: string; // AAAA-MM-DD
  competencia: string; // AAAA-MM-DD (NFS-e: dCompet)
  valor: number; // valor contábil comparável ao Domínio (NFS-e = vServ)
  cancelada: boolean;
  tpNF0: boolean; // nota de ENTRADA do próprio emitente (ex.: devolução recebida pelo fornecedor)
  cteTomador: string | null; // CNPJ/CPF do tomador do CT-e
  natOp: string;
  resumo: boolean; // só o resumo (sem XML completo)
  tot: { vNF: number; vProd: number; vDesc: number; vICMSDeson: number; vST: number; vIPI: number; vFrete: number; vSeg: number; vOutro: number; vServ: number; vLiq: number; vRet: number };
  grupos: GrupoCfop[];
}

const tag = (x: string, t: string) => { const m = x.match(new RegExp(`<${t}>([^<]*)</${t}>`)); return m ? m[1] : null; };
const tagN = (x: string, t: string) => Number(tag(x, t) || 0) || 0;

// Monta o DocSite a partir da linha de nfe_documentos (o servidor passa os campos já lidos do banco).
export function docSiteDeLinha(r: { id: number; tipo: string; chave: string | null; emitenteCnpj: string | null; emitenteNome: string | null; dataEmissao: string | null; competencia: string | null; valorTotal: number | null; cancelada: any; xml: string; cteTomador?: string | null }): DocSite {
  const x = String(r.xml || "");
  const chave = r.chave && /^\d{44}$/.test(r.chave) ? r.chave : null;
  let numero = "-", serie = "";
  if (r.tipo === "nfse") numero = String(Number(tag(x, "nNFSe") || 0) || "-");
  else if (chave) { numero = String(Number(chave.slice(25, 34))); serie = String(Number(chave.slice(22, 25))); }
  else { const n = tag(x, "nNF") || tag(x, "nCT"); if (n) numero = String(Number(n)); }
  const icmsTot = (x.match(/<ICMSTot>([\s\S]*?)<\/ICMSTot>/) || [])[1] || "";
  const vServ = tagN(x, "vServ"), vLiq = tagN(x, "vLiq");
  let valor = Number(r.valorTotal || 0);
  if (r.tipo === "nfse" && vServ > 0) valor = vServ; // valor contábil = valor do serviço (Domínio), não o líquido
  // Itens agrupados pelo CFOP do XML (o Domínio troca pro CFOP de entrada — 5405 vira 1407 etc. —, então
  // a ligação linha-do-Domínio ↔ grupo é feita pelo VALOR na comparação, não pelo código).
  const grupos = new Map<string, GrupoCfop>();
  for (const m of x.matchAll(/<det nItem="\d+">([\s\S]*?)<\/det>/g)) {
    const d = m[1];
    const prod = (d.match(/<prod>([\s\S]*?)<\/prod>/) || [])[1] || "";
    const cfop = tag(prod, "CFOP") || "?";
    const g = grupos.get(cfop) || { cfop, bruto: 0, desconto: 0, deson: 0, st: 0, ipi: 0, frete: 0, outros: 0, liquido: 0 };
    const ipiBloco = (d.match(/<IPI>([\s\S]*?)<\/IPI>/) || [])[1] || "";
    g.bruto += tagN(prod, "vProd");
    g.desconto += tagN(prod, "vDesc");
    g.frete += tagN(prod, "vFrete");
    g.outros += tagN(prod, "vSeg") + tagN(prod, "vOutro");
    g.deson += tagN(d, "vICMSDeson");
    g.st += tagN(d, "vICMSST") + tagN(d, "vFCPST");
    g.ipi += tagN(ipiBloco, "vIPI") + tagN(d, "vIPIDevol");
    grupos.set(cfop, g);
  }
  for (const g of grupos.values()) {
    g.liquido = r2(g.bruto - g.desconto - g.deson + g.st + g.ipi + g.frete + g.outros);
    for (const k of ["bruto", "desconto", "deson", "st", "ipi", "frete", "outros"] as const) g[k] = r2(g[k]);
  }
  return {
    id: r.id, tipo: r.tipo, chave, numero, serie,
    emitenteCnpj: soDig(r.emitenteCnpj || ""), emitenteNome: String(r.emitenteNome || ""),
    dataEmissao: String(r.dataEmissao || "").slice(0, 10), competencia: String(r.competencia || r.dataEmissao || "").slice(0, 10),
    valor: r2(valor), cancelada: !!r.cancelada,
    tpNF0: (r.tipo === "nfe" || r.tipo === "nfce") && /<tpNF>0<\/tpNF>/.test(x),
    cteTomador: r.tipo === "cte" ? (r.cteTomador || null) : null,
    natOp: tag(x, "natOp") || "",
    resumo: (r.tipo === "nfe" || r.tipo === "nfce") && !/<det nItem=/.test(x),
    tot: {
      vNF: tagN(icmsTot, "vNF"), vProd: tagN(icmsTot, "vProd"), vDesc: tagN(icmsTot, "vDesc"), vICMSDeson: tagN(icmsTot, "vICMSDeson"),
      vST: tagN(icmsTot, "vST") + tagN(icmsTot, "vFCPST"), vIPI: tagN(icmsTot, "vIPI") + tagN(icmsTot, "vIPIDevol"), vFrete: tagN(icmsTot, "vFrete"),
      vSeg: tagN(icmsTot, "vSeg"), vOutro: tagN(icmsTot, "vOutro"), vServ, vLiq, vRet: tagN(x, "vTotalRet"),
    },
    grupos: [...grupos.values()],
  };
}

// ---------------------------------------------------------------- 3) Comparação
export interface NotaDominio { chave: string; nota: string; serie: string; especie: string; codFornecedor: string; fornecedor: string; data: string; valor: number; linhas: LinhaDominio[]; duplicadas: boolean }
export interface LinhaCfopComparada { cfopDominio: string; valorDominio: number; cfopXml: string | null; valorXml: number | null; diferenca: number; motivo: string }
export interface ItemComparativo {
  situacao:
    | "ok" | "cancelada_ok" // batem
    | "valor_diferente" | "cancelada_no_site_com_valor" | "zerada_no_dominio" // ERRO: lançado diferente
    | "so_dominio" // ERRO: no Domínio e não no site
    | "so_site" // ERRO: no site e não lançado no Domínio
    | "numero_diferente" // ERRO: mesma nota (fornecedor + valor), número digitado diferente no Domínio
    | "outro_periodo" | "energia_sem_xml" | "cte_outro_tomador" | "entrada_do_emitente" | "cancelada_so_site"; // justificadas (não é erro)
  erro: boolean;
  titulo: string;
  detalhe: string;
  dominio: NotaDominio | null;
  site: Pick<DocSite, "id" | "tipo" | "chave" | "numero" | "serie" | "emitenteCnpj" | "emitenteNome" | "dataEmissao" | "valor" | "cancelada" | "natOp"> | null;
  diferenca: number; // site − Domínio (no valor contábil)
  cfops?: LinhaCfopComparada[];
}
export interface ResultadoComparativo {
  empresa: { nome: string; cnpj: string };
  periodo: { de: string | null; ate: string | null };
  leitura: { linhas: number; notas: number; totalGeralPdf: number | null; somaLinhas: number; avisos: string[] };
  totais: { dominio: number; site: number; diferenca: number; explicadoJustificado: number; explicadoErros: number; naoExplicado: number };
  contagem: { batem: number; erros: number; justificadas: number };
  status: "ok" | "divergente";
  itens: ItemComparativo[];
  geradoEm: string;
}

function fmt(n: number) { return (Number(n) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
const fmtData = (iso: string) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10).split("-").reverse().join("/") : "—");
const perto = (a: number, b: number, tol = 0.02) => Math.abs(a - b) <= tol;
const STOP = new Set(["LTDA", "ME", "EPP", "EIRELI", "SA", "S/A", "COM", "COMERCIO", "DE", "DA", "DO", "DOS", "DAS", "E", "&", "-", "CIA", "PRODUTOS", "SERVICOS", "INDUSTRIA", "IND"]);
const tokens = (s: string) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length >= 3 && !STOP.has(t));
function mesmoFornecedor(dom: NotaDominio, s: DocSite): boolean {
  // O Domínio às vezes começa o nome pela raiz do CNPJ/CPF ("32.491.927 DAVID ...").
  const raiz = /^(\d{2,3}\.\d{3}\.\d{3})/.exec(dom.fornecedor);
  if (raiz && s.emitenteCnpj.startsWith(soDig(raiz[1]))) return true;
  const a = new Set(tokens(dom.fornecedor)), b = tokens(s.emitenteNome);
  return b.some((t) => a.has(t));
}
// Concessionárias de energia (nome inteiro — "ELETRO" sozinho pegava "ELETRODOMESTICOS").
const ehEnergia = (d: NotaDominio) => d.especie === "7" || /\bENERGIA\b|EQUATORIAL|\bCELPA\b|\bENEL\b|\bCEMIG\b|\bCOPEL\b|\bLIGHT\b|\bCPFL\b|ENERGISA|COELBA|NEOENERGIA|ELETROPAULO|\bCELESC\b|\bCEEE\b|\bCOSERN\b|\bCOELCE\b|\bCELPE\b|AMAZONAS ENERGIA|\bRGE\b/i.test(d.fornecedor);

function docResumo(s: DocSite): ItemComparativo["site"] {
  return { id: s.id, tipo: s.tipo, chave: s.chave, numero: s.numero, serie: s.serie, emitenteCnpj: s.emitenteCnpj, emitenteNome: s.emitenteNome, dataEmissao: s.dataEmissao, valor: s.valor, cancelada: s.cancelada, natOp: s.natOp };
}

// Explica uma diferença de valor olhando o XML (ordem: o mais comum primeiro).
function explicarValor(dom: NotaDominio, s: DocSite): { motivo: string; cfops?: LinhaCfopComparada[] } {
  const d = dom.valor, t = s.tot;
  if (dom.duplicadas && perto(d, s.valor * 2, 0.05)) return { motivo: `Nota lançada EM DUPLICIDADE no Domínio (${dom.linhas.length} linhas iguais) — o valor ficou em dobro.` };
  if (s.tipo === "nfse") {
    if (t.vLiq > 0 && perto(d, t.vLiq)) return { motivo: `Lançada pelo valor LÍQUIDO (R$ ${fmt(t.vLiq)}, depois das retenções de R$ ${fmt(t.vServ - t.vLiq)}). O valor contábil é o do serviço: R$ ${fmt(t.vServ)}.` };
    return { motivo: `Valor do serviço no XML: R$ ${fmt(s.valor)}${t.vLiq && t.vLiq !== s.valor ? ` (líquido R$ ${fmt(t.vLiq)})` : ""}.` };
  }
  if (d === 0 && s.valor > 0) return { motivo: "Lançada ZERADA no Domínio, mas a nota é válida (não está cancelada) no site." };
  // Por CFOP: liga cada linha do Domínio a um grupo de itens do XML pelo valor (líquido, depois bruto).
  let cfops: LinhaCfopComparada[] | undefined;
  if (s.grupos.length) {
    const livres = [...s.grupos];
    const usar = (g: GrupoCfop) => livres.splice(livres.indexOf(g), 1);
    const pend: LinhaDominio[] = [];
    cfops = [];
    for (const l of dom.linhas) {
      const g = livres.find((x) => perto(x.liquido, l.valor));
      if (g) { usar(g); cfops.push({ cfopDominio: l.cfop, valorDominio: l.valor, cfopXml: g.cfop, valorXml: g.liquido, diferenca: 0, motivo: "ok" }); }
      else pend.push(l);
    }
    for (const l of pend) {
      let g = livres.find((x) => perto(x.bruto, l.valor) && x.desconto > 0) || livres.find((x) => perto(x.liquido + x.deson, l.valor) && x.deson > 0)
        || livres.find((x) => perto(x.liquido - x.st, l.valor) && x.st > 0) || livres.find((x) => perto(x.liquido - x.ipi, l.valor) && x.ipi > 0)
        || livres.find((x) => perto(x.liquido - x.frete, l.valor) && x.frete > 0) || (livres.length === 1 || pend.length === 1 ? livres[0] : undefined);
      if (!g) { cfops.push({ cfopDominio: l.cfop, valorDominio: l.valor, cfopXml: null, valorXml: null, diferenca: -l.valor, motivo: "linha sem itens correspondentes no XML" }); continue; }
      usar(g);
      let motivo = "valor diferente do XML";
      if (g.desconto > 0 && perto(g.bruto, l.valor)) motivo = `lançado pelo valor BRUTO dos itens, sem abater o desconto de R$ ${fmt(g.desconto)}`;
      else if (g.deson > 0 && perto(g.liquido + g.deson, l.valor)) motivo = `ICMS desonerado de R$ ${fmt(g.deson)} não foi abatido`;
      else if (g.st > 0 && perto(g.liquido - g.st, l.valor)) motivo = `ICMS-ST de R$ ${fmt(g.st)} não foi somado`;
      else if (g.ipi > 0 && perto(g.liquido - g.ipi, l.valor)) motivo = `IPI de R$ ${fmt(g.ipi)} não foi somado`;
      else if (g.frete > 0 && perto(g.liquido - g.frete, l.valor)) motivo = `frete de R$ ${fmt(g.frete)} não foi somado`;
      cfops.push({ cfopDominio: l.cfop, valorDominio: l.valor, cfopXml: g.cfop, valorXml: g.liquido, diferenca: r2(g.liquido - l.valor), motivo });
    }
    for (const g of livres) cfops.push({ cfopDominio: "—", valorDominio: 0, cfopXml: g.cfop, valorXml: g.liquido, diferenca: g.liquido, motivo: "itens do XML sem linha no Domínio" });
  }
  // Motivo geral (nota inteira).
  let motivo = "";
  if (t.vDesc > 0 && perto(d, s.valor + t.vDesc)) motivo = `Lançada pelo valor dos produtos sem abater o DESCONTO de R$ ${fmt(t.vDesc)}.`;
  else if (t.vICMSDeson > 0 && perto(d, s.valor + t.vICMSDeson)) motivo = `O ICMS DESONERADO de R$ ${fmt(t.vICMSDeson)} não foi abatido (a nota vale R$ ${fmt(s.valor)}).`;
  else if (t.vST > 0 && perto(d, s.valor - t.vST)) motivo = `Faltou somar o ICMS-ST de R$ ${fmt(t.vST)}.`;
  else if (t.vIPI > 0 && perto(d, s.valor - t.vIPI)) motivo = `Faltou somar o IPI de R$ ${fmt(t.vIPI)}.`;
  else if (t.vFrete > 0 && perto(d, s.valor - t.vFrete)) motivo = `Faltou somar o frete de R$ ${fmt(t.vFrete)}.`;
  else if (t.vProd > 0 && perto(d, t.vProd)) motivo = `Lançada pelo valor dos produtos (R$ ${fmt(t.vProd)}); o total da nota é R$ ${fmt(s.valor)}.`;
  else if (cfops && cfops.some((c) => c.motivo !== "ok")) motivo = cfops.filter((c) => c.motivo !== "ok").map((c) => `CFOP ${fmtCfop(c.cfopDominio)}: ${c.motivo}`).join("; ") + ".";
  else motivo = `Valor no Domínio R$ ${fmt(d)} x total da nota no XML R$ ${fmt(s.valor)}.`;
  if (s.resumo) motivo += " (O site só tem o resumo desta NF-e — sem os itens para detalhar por CFOP.)";
  return { motivo, cfops };
}
export const fmtCfop = (c: string) => (/^\d{4}$/.test(c) ? `${c[0]}.${c.slice(1)}` : c);

export function compararEntradas(dom: RelatorioDominio, sitePeriodo: DocSite[], siteForaPeriodo: DocSite[], empresaDoc: string): ResultadoComparativo {
  // Agrupa as linhas do Domínio por nota (uma nota vira várias linhas, uma por CFOP).
  const porNota = new Map<string, NotaDominio>();
  for (const l of dom.linhas) {
    const k = `${l.nota}|${l.codFornecedor || l.fornecedor.slice(0, 14).toUpperCase()}|${l.serie}`;
    const n = porNota.get(k) || { chave: k, nota: l.nota, serie: l.serie, especie: l.especie, codFornecedor: l.codFornecedor, fornecedor: l.fornecedor, data: l.data, valor: 0, linhas: [], duplicadas: false };
    n.linhas.push(l);
    n.valor = r2(n.valor + l.valor);
    porNota.set(k, n);
  }
  for (const n of porNota.values()) {
    const assin = n.linhas.map((l) => `${l.cfop}|${l.valor}`);
    n.duplicadas = n.linhas.length > 1 && new Set(assin).size < assin.length;
  }
  const notasDom = [...porNota.values()];
  const usados = new Set<number>();
  const casado = new Map<NotaDominio, DocSite>();
  const foraCasado = new Map<NotaDominio, DocSite>();
  // Casamento em passadas, da mais forte pra mais fraca (evita que uma regra fraca "roube" o par certo).
  const passadas: ((d: NotaDominio, s: DocSite) => boolean)[] = [
    (d, s) => s.numero === d.nota && perto(s.valor, d.valor) && mesmoFornecedor(d, s),
    (d, s) => s.numero === d.nota && perto(s.valor, d.valor),
    (d, s) => s.numero === d.nota && mesmoFornecedor(d, s),
  ];
  for (const regra of passadas) {
    for (const d of notasDom) {
      if (casado.has(d)) continue;
      const cands = sitePeriodo.filter((s) => !usados.has(s.id) && regra(d, s));
      // Lançamento zerado prefere a nota cancelada; com valor, prefere a válida.
      const s = cands.find((c) => c.cancelada === (d.valor === 0)) || cands[0];
      if (s) { casado.set(d, s); usados.add(s.id); }
    }
  }
  for (const d of notasDom) { // número único no período (fornecedor com nome muito diferente no Domínio)
    if (casado.has(d)) continue;
    const cands = sitePeriodo.filter((s) => !usados.has(s.id) && s.numero === d.nota);
    if (cands.length === 1) { casado.set(d, cands[0]); usados.add(cands[0].id); }
  }
  const usadosFora = new Set<number>();
  for (const d of notasDom) { // fora do período: nota emitida em outro mês e lançada neste (data de entrada)
    if (casado.has(d)) continue;
    const s = siteForaPeriodo.find((x) => !usadosFora.has(x.id) && x.numero === d.nota && (perto(x.valor, d.valor) || mesmoFornecedor(d, x)));
    if (s) { foraCasado.set(d, s); usadosFora.add(s.id); }
  }

  const itens: ItemComparativo[] = [];
  const nomeDom = (d: NotaDominio) => `${d.especie === "39" ? "NFS-e/serviço" : d.especie === "7" ? "Energia" : "Nota"} ${d.nota}${d.serie ? "/" + d.serie : ""} — ${d.fornecedor || "fornecedor " + d.codFornecedor}`;
  const nomeSite = (s: DocSite) => `${s.tipo.toUpperCase()} ${s.numero}${s.serie ? "/" + s.serie : ""} — ${s.emitenteNome || s.emitenteCnpj}`;
  for (const d of notasDom) {
    const s = casado.get(d);
    if (s) {
      if (s.cancelada) {
        if (d.valor === 0) itens.push({ situacao: "cancelada_ok", erro: false, titulo: nomeDom(d), detalhe: "Cancelada no site e lançada zerada no Domínio.", dominio: d, site: docResumo(s), diferenca: 0 });
        else itens.push({ situacao: "cancelada_no_site_com_valor", erro: true, titulo: nomeDom(d), detalhe: `A nota está CANCELADA (evento de cancelamento no site), mas foi lançada com R$ ${fmt(d.valor)} no Domínio. Deve ser lançada como cancelada / zerada.`, dominio: d, site: docResumo(s), diferenca: r2(0 - d.valor) });
        continue;
      }
      if (perto(s.valor, d.valor)) { itens.push({ situacao: "ok", erro: false, titulo: nomeDom(d), detalhe: "", dominio: d, site: docResumo(s), diferenca: 0 }); continue; }
      const ex = explicarValor(d, s);
      itens.push({ situacao: d.valor === 0 ? "zerada_no_dominio" : "valor_diferente", erro: true, titulo: nomeDom(d), detalhe: ex.motivo, dominio: d, site: docResumo(s), diferenca: r2(s.valor - d.valor), cfops: ex.cfops });
      continue;
    }
    const f = foraCasado.get(d);
    if (f) {
      const valorBate = perto(f.valor, d.valor) || (f.cancelada && d.valor === 0);
      itens.push({
        situacao: valorBate ? "outro_periodo" : "valor_diferente", erro: !valorBate, titulo: nomeDom(d),
        detalhe: `Emitida em ${fmtData(f.dataEmissao)} — no site ela está em outro mês; no Domínio entrou em ${fmtData(d.data)} (data de entrada).${valorBate ? "" : ` E o valor não bate: XML R$ ${fmt(f.valor)} x Domínio R$ ${fmt(d.valor)}. ${explicarValor(d, f).motivo}`}`,
        dominio: d, site: docResumo(f), diferenca: r2(0 - d.valor),
      });
      continue;
    }
    if (ehEnergia(d)) { itens.push({ situacao: "energia_sem_xml", erro: false, titulo: nomeDom(d), detalhe: "Conta de energia (NF3-e): esse modelo não vem na busca de XML da Sefaz, por isso só existe no Domínio.", dominio: d, site: null, diferenca: r2(0 - d.valor) }); continue; }
    itens.push({
      situacao: "so_dominio", erro: true, titulo: nomeDom(d),
      detalhe: d.valor === 0
        ? "Lançada zerada no Domínio e não existe no site — confirmar se a nota foi cancelada/denegada (e importar o XML), ou excluir o lançamento."
        : `Lançada no Domínio (entrada ${fmtData(d.data)}, CFOP ${d.linhas.map((l) => fmtCfop(l.cfop)).join(", ")}) e NÃO existe XML no site para o período. Conferir o número/fornecedor digitado ou importar o XML (Importar XML).`,
      dominio: d, site: null, diferenca: r2(0 - d.valor),
    });
  }
  for (const s of sitePeriodo) {
    if (usados.has(s.id)) continue;
    const base = { dominio: null, site: docResumo(s), titulo: nomeSite(s) };
    if (s.cancelada) { itens.push({ ...base, situacao: "cancelada_so_site", erro: false, detalhe: "Cancelada — não precisa ser lançada.", diferenca: 0 }); continue; }
    if (s.tipo === "cte" && s.cteTomador && empresaDoc && s.cteTomador !== empresaDoc) {
      itens.push({ ...base, situacao: "cte_outro_tomador", erro: false, detalhe: `CT-e em que a empresa NÃO é a tomadora (frete pago por ${s.cteTomador.length === 14 ? s.cteTomador.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : s.cteTomador}) — não é entrada da empresa, o Domínio não lança.`, diferenca: s.valor });
      continue;
    }
    if (s.tpNF0) {
      itens.push({ ...base, situacao: "entrada_do_emitente", erro: false, detalhe: `Nota de ENTRADA emitida pelo próprio fornecedor (${s.natOp || "tpNF=0"}) — ex.: devolução recebida por ele. Para a empresa não é compra; não se lança como entrada.`, diferenca: s.valor });
      continue;
    }
    itens.push({ ...base, situacao: "so_site", erro: true, detalhe: `Nota de entrada válida (emitida em ${fmtData(s.dataEmissao)}, R$ ${fmt(s.valor)}) que NÃO está lançada no Domínio neste período. Lançar${s.chave ? ` — chave ${s.chave}` : ""}.`, diferenca: s.valor });
  }
  // Número digitado errado: sobrou "só no Domínio" e "só no site" do MESMO fornecedor com o MESMO valor —
  // é a mesma nota; junta as duas num item só apontando o número certo (em vez de dois erros soltos).
  for (const sd of itens.filter((i) => i.situacao === "so_dominio" && i.dominio && i.dominio.valor > 0)) {
    const d = sd.dominio!;
    const par = itens.find((i) => i.situacao === "so_site" && i.site && perto(i.site.valor, d.valor) && mesmoFornecedor(d, sitePeriodo.find((s) => s.id === i.site!.id)!));
    if (!par) continue;
    const s = par.site!;
    itens.splice(itens.indexOf(par), 1);
    Object.assign(sd, {
      situacao: "numero_diferente", erro: true, site: s, diferenca: r2(s.valor - d.valor),
      detalhe: `Mesma nota (mesmo fornecedor e valor R$ ${fmt(d.valor)}), mas no Domínio foi digitado o número ${d.nota}${d.serie ? "/" + d.serie : ""} e o XML é o número ${s.numero}${s.serie ? "/" + s.serie : ""}. Corrigir o número no Domínio${s.chave ? ` (chave ${s.chave})` : ""}.`,
    });
  }
  // Ordem: erros primeiro (maior valor), depois justificadas, depois as que batem.
  const peso = (i: ItemComparativo) => (i.erro ? 0 : i.situacao === "ok" || i.situacao === "cancelada_ok" ? 2 : 1);
  itens.sort((a, b) => peso(a) - peso(b) || Math.abs(b.diferenca) - Math.abs(a.diferenca));
  const totalDom = r2(dom.linhas.reduce((a, l) => a + l.valor, 0));
  const totalSite = r2(sitePeriodo.filter((s) => !s.cancelada).reduce((a, s) => a + s.valor, 0));
  const somaDif = (f: (i: ItemComparativo) => boolean) => r2(itens.filter(f).reduce((a, i) => a + i.diferenca, 0));
  const explicadoJustificado = somaDif((i) => !i.erro && i.situacao !== "ok" && i.situacao !== "cancelada_ok");
  const explicadoErros = somaDif((i) => i.erro);
  const diferenca = r2(totalSite - totalDom);
  const erros = itens.filter((i) => i.erro).length;
  const batem = itens.filter((i) => i.situacao === "ok" || i.situacao === "cancelada_ok").length;
  return {
    empresa: { nome: dom.empresaNome, cnpj: dom.cnpj },
    periodo: { de: dom.periodoDe, ate: dom.periodoAte },
    leitura: { linhas: dom.linhas.length, notas: notasDom.length, totalGeralPdf: dom.totalGeral, somaLinhas: dom.somaLinhas, avisos: dom.avisos },
    totais: { dominio: totalDom, site: totalSite, diferenca, explicadoJustificado, explicadoErros, naoExplicado: r2(diferenca - explicadoJustificado - explicadoErros) },
    contagem: { batem, erros, justificadas: itens.length - erros - batem },
    status: erros === 0 && !dom.avisos.length ? "ok" : "divergente",
    itens,
    geradoEm: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- 4) Relatório (HTML → PDF, padrão do sistema)
const esc = (s: any) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as any)[c]);
export const ROTULO_SITUACAO: Record<ItemComparativo["situacao"], string> = {
  ok: "Bate", cancelada_ok: "Cancelada nos dois",
  valor_diferente: "Valor diferente", cancelada_no_site_com_valor: "Cancelada no site, lançada com valor", zerada_no_dominio: "Zerada no Domínio",
  so_dominio: "Só no Domínio (sem XML)", so_site: "Falta lançar no Domínio", numero_diferente: "Número digitado errado",
  outro_periodo: "Emitida em outro mês", energia_sem_xml: "Energia (sem XML)", cte_outro_tomador: "CT-e de outro tomador",
  entrada_do_emitente: "Entrada do fornecedor (devolução)", cancelada_so_site: "Cancelada (só no site)",
};
export function relatorioHtml(r: ResultadoComparativo, empresaNome: string, cnpjFmt: string): string {
  const per = `${fmtData(r.periodo.de || "")} até ${fmtData(r.periodo.ate || "")}`;
  const erros = r.itens.filter((i) => i.erro);
  const just = r.itens.filter((i) => !i.erro && i.situacao !== "ok" && i.situacao !== "cancelada_ok");
  const okN = r.itens.filter((i) => i.situacao === "ok" || i.situacao === "cancelada_ok");
  const linhaItem = (i: ItemComparativo) => {
    const dVal = i.dominio ? `R$ ${fmt(i.dominio.valor)}` : "—";
    const sVal = i.site ? `R$ ${fmt(i.site.valor)}${i.site.cancelada ? " (cancelada)" : ""}` : "—";
    const cf = i.cfops && i.cfops.some((c) => c.motivo !== "ok")
      ? `<table class="cf"><tr><th>CFOP Domínio</th><th class="n">Valor Domínio</th><th>CFOP XML</th><th class="n">Valor XML</th><th class="n">Diferença</th><th>Motivo</th></tr>${i.cfops.map((c) => `<tr class="${c.motivo === "ok" ? "" : "bad"}"><td>${esc(fmtCfop(c.cfopDominio))}</td><td class="n">${fmt(c.valorDominio)}</td><td>${esc(c.cfopXml ? fmtCfop(c.cfopXml) : "—")}</td><td class="n">${c.valorXml == null ? "—" : fmt(c.valorXml)}</td><td class="n">${fmt(c.diferenca)}</td><td>${esc(c.motivo)}</td></tr>`).join("")}</table>`
      : "";
    return `<tr><td><span class="tag t-${i.erro ? "err" : i.situacao === "ok" || i.situacao === "cancelada_ok" ? "ok" : "info"}">${esc(ROTULO_SITUACAO[i.situacao])}</span></td>
      <td><b>${esc(i.titulo)}</b>${i.site && i.site.chave ? `<div class="ch">${esc(i.site.chave)}</div>` : ""}${i.detalhe ? `<div class="det">${esc(i.detalhe)}</div>` : ""}${cf}</td>
      <td class="n">${i.dominio ? fmtData(i.dominio.data) : "—"}</td><td class="n">${i.site ? fmtData(i.site.dataEmissao) : "—"}</td>
      <td class="n">${dVal}</td><td class="n">${sVal}</td><td class="n ${i.erro && Math.abs(i.diferenca) > 0.009 ? "neg" : ""}">${fmt(i.diferenca)}</td></tr>`;
  };
  const tabela = (lista: ItemComparativo[]) => `<table class="rep"><colgroup><col style="width:12%"><col style="width:44%"><col style="width:7.5%"><col style="width:7.5%"><col style="width:9.5%"><col style="width:10%"><col style="width:9.5%"></colgroup><thead><tr><th>Situação</th><th>Nota / explicação</th><th class="n">Entrada (Dom.)</th><th class="n">Emissão (XML)</th><th class="n">Domínio</th><th class="n">Site (XML)</th><th class="n">Dif. (site − Dom.)</th></tr></thead><tbody>${lista.map(linhaItem).join("")}</tbody></table>`;
  const statusHtml = r.status === "ok"
    ? `<div class="st ok">✔ TUDO CERTO — o Domínio bate com os XMLs do site. ${okN.length} nota(s) conferidas${just.length ? `; ${just.length} diferença(s) justificada(s) (não são erro), detalhadas abaixo` : ""}.</div>`
    : `<div class="st bad">⚠ ${erros.length} DIFERENÇA(S) A CORRIGIR${r.leitura.avisos.length ? " — e avisos de leitura do PDF" : ""}. Detalhe de cada uma abaixo.</div>`;
  return `<style>
    body { font-family: 'Helvetica Neue', Arial, sans-serif !important; font-size: 9px; color:#2b2b2b; }
    h1, h2, h3, table, td, th, div, span, p, b { font-family: 'Helvetica Neue', Arial, sans-serif !important; }
    .cab { border-bottom: 2.5px solid #159873; padding-bottom: 7px; margin-bottom: 8px; }
    h1 { font-size: 16px; margin: 0 0 3px; color:#0E6B52; }
    h2 { font-size: 12px; color:#0E6B52; margin: 14px 0 5px; border-left:4px solid #159873; padding-left:7px; }
    .cab p { margin: 1px 0; color:#555; font-size: 9.5px; } .cab p b { color:#222; }
    .st { padding:9px 12px; border-radius:7px; font-weight:700; font-size:11.5px; margin:8px 0; }
    .st.ok { background:#DFF7EC; color:#0E6B52; border:1px solid #9fe3c6; } .st.bad { background:#fdecec; color:#9b1c1c; border:1px solid #f3c0c0; }
    .cards { display:flex; gap:8px; margin:6px 0 4px; } .card { flex:1; border:1px solid #cdeee1; background:#fbfffd; border-radius:7px; padding:6px 9px; }
    .card .l { font-size:8px; color:#3b8268; text-transform:uppercase; letter-spacing:.3px; } .card .v { font-size:12.5px; font-weight:700; color:#0E6B52; white-space:nowrap; }
    table.rep { border-collapse: collapse; width: 100%; table-layout: fixed; margin: 2px 0 6px; }
    table.rep th, table.rep td { border: 1px solid #cdeee1; padding: 3px 5px; vertical-align: top; overflow-wrap:break-word; }
    table.rep th { background:#DFF7EC; color:#0E6B52; text-align:left; font-size: 7.6px; font-weight:700; text-transform:uppercase; }
    table.rep tr { page-break-inside: avoid; } .n { text-align:right; white-space:nowrap; } .neg { color:#b91c1c; font-weight:700; }
    .tag { display:inline-block; border-radius:9px; padding:1px 7px; font-size:7.8px; font-weight:700; }
    .t-err { background:#fdecec; color:#9b1c1c; } .t-ok { background:#DFF7EC; color:#0E6B52; } .t-info { background:#eef3fb; color:#2f4f7a; }
    .det { color:#444; margin-top:2px; } .ch { font-family:'Courier New',monospace; font-size:7.5px; color:#777; }
    table.cf { border-collapse:collapse; width:100%; margin-top:4px; } table.cf th, table.cf td { border:1px solid #e3e3e3; padding:2px 4px; font-size:7.8px; } table.cf th { background:#f6f6f6; text-align:left; } table.cf tr.bad td { background:#fff4f4; }
    .avisos { background:#fff8e6; border:1px solid #f0d58a; border-radius:7px; padding:6px 10px; color:#7a5a00; margin:6px 0; }
  </style>
  <div class="cab">
    <h1>${esc(empresaNome)} — Comparativo de Entradas: Domínio x Site (XML)</h1>
    <p><b>CNPJ:</b> ${esc(cnpjFmt)} &nbsp;·&nbsp; <b>Período:</b> ${esc(per)} &nbsp;·&nbsp; Relatório do Domínio: "Acompanhamento de Entradas" — conferência interna</p>
  </div>
  ${statusHtml}
  ${r.leitura.avisos.length ? `<div class="avisos"><b>Leitura do PDF:</b><br>${r.leitura.avisos.map(esc).join("<br>")}</div>` : ""}
  <div class="cards">
    <div class="card"><div class="l">Total Domínio (valor contábil)</div><div class="v">R$ ${fmt(r.totais.dominio)}</div></div>
    <div class="card"><div class="l">Total site (entradas válidas)</div><div class="v">R$ ${fmt(r.totais.site)}</div></div>
    <div class="card"><div class="l">Diferença (site − Domínio)</div><div class="v">R$ ${fmt(r.totais.diferenca)}</div></div>
    <div class="card"><div class="l">Notas que batem</div><div class="v">${r.contagem.batem}</div></div>
    <div class="card"><div class="l">A corrigir</div><div class="v" style="color:${erros.length ? "#b91c1c" : "#0E6B52"}">${erros.length}</div></div>
  </div>
  <div style="font-size:8.5px; color:#555;">Composição da diferença: justificadas R$ ${fmt(r.totais.explicadoJustificado)} · a corrigir R$ ${fmt(r.totais.explicadoErros)}${Math.abs(r.totais.naoExplicado) > 0.009 ? ` · <b style="color:#b91c1c">não explicado R$ ${fmt(r.totais.naoExplicado)}</b>` : " · não explicado R$ 0,00"} &nbsp;·&nbsp; Leitura: ${r.leitura.linhas} linhas / ${r.leitura.notas} notas; Total Geral do PDF ${r.leitura.totalGeralPdf == null ? "não encontrado" : "R$ " + fmt(r.leitura.totalGeralPdf)} (soma das linhas R$ ${fmt(r.leitura.somaLinhas)}).</div>
  ${erros.length ? `<h2>A corrigir (${erros.length})</h2>${tabela(erros)}` : ""}
  ${just.length ? `<h2>Diferenças justificadas — não são erro (${just.length})</h2>${tabela(just)}` : ""}
  ${okN.length ? `<h2>Notas que batem (${okN.length})</h2>${tabela(okN)}` : ""}`;
}
