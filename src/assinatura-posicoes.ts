// Acha no PDF do contrato onde cada signatário assina — pra Autentique carimbar a assinatura em cima
// da linha certa (e não só na página de auditoria). O PDF é gerado por nós (HTML → Chromium), então
// as linhas de assinatura são texto: uma sequência de pontos/underscores ("......" dos sócios e do
// cliente, "1.____" / "2.____" das testemunhas). Embaixo de cada linha vem o bloco de identificação
// (empresa, CNPJ, nome, CPF) — é por esse bloco que a linha é ligada ao signatário.
// Posição na Autentique: x/y = CENTRO do campo, em % da largura/altura da página; z = página (1ª = 1).

export interface LinhaAssinatura {
  pagina: number; // 1-based
  xCentroPct: number;
  yLinhaPct: number; // altura da linha (baseline), % a partir do topo
  prefixo: number | null; // 1/2 nas linhas de testemunha ("1.____"), null nas demais
  textoAbaixo: string; // bloco de identificação logo abaixo (normalizado)
}

interface ItemTexto { str: string; x: number; y: number; w: number } // y = baseline a partir do topo

// Compara sem acento, sem caixa e SEM espaço: o Chromium às vezes parte a palavra em 2 itens de
// texto ("SER VIÇOS"), então o espaço não é confiável.
export function normalizarNome(s: string): string {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, "");
}

const RE_LINHA = /[._]{8,}/g;

export async function localizarLinhasAssinatura(pdf: Buffer): Promise<LinhaAssinatura[]> {
  const pdfParse = require("pdf-parse");
  const paginas: { largura: number; altura: number; itens: ItemTexto[] }[] = [];
  await pdfParse(pdf, {
    pagerender: async (pageData: any) => {
      const [x0, y0, x1, y1] = pageData.view;
      const largura = x1 - x0, altura = y1 - y0;
      const tc = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      const itens: ItemTexto[] = tc.items
        .filter((it: any) => it.str && it.str.trim())
        .map((it: any) => ({ str: it.str, x: it.transform[4] - x0, y: altura - (it.transform[5] - y0), w: it.width }));
      paginas.push({ largura, altura, itens });
      return "";
    },
  });

  const linhas: LinhaAssinatura[] = [];
  paginas.forEach((pg, idx) => {
    // 1) Acha cada sequência de pontos/underscores (pode haver duas no mesmo item: "1.___ 2.___").
    const achadas: { x0: number; x1: number; y: number; prefixo: number | null }[] = [];
    for (const it of pg.itens) {
      const porChar = it.str.length ? it.w / it.str.length : 0;
      for (const m of it.str.matchAll(RE_LINHA)) {
        const ini = m.index || 0;
        const antes = it.str.slice(0, ini);
        // Prefixo "1." / "2." no mesmo item ou no item imediatamente à esquerda, na mesma altura.
        let pm = antes.match(/(\d)\s*[.)-]?\s*$/);
        if (!pm && ini === 0) {
          const vizinho = pg.itens.find((o) => o !== it && Math.abs(o.y - it.y) < 2 && Math.abs(o.x + o.w - it.x) < 6);
          if (vizinho) pm = vizinho.str.match(/(\d)\s*[.)-]?\s*$/);
        }
        achadas.push({ x0: it.x + ini * porChar, x1: it.x + (ini + m[0].length) * porChar, y: it.y, prefixo: pm ? Number(pm[1]) : null });
      }
    }
    // 2) Pra cada linha, junta o texto que fica logo abaixo dela (na mesma faixa horizontal), até a
    //    próxima linha de assinatura dessa coluna ou ~110pt.
    for (const a of achadas) {
      const proximaAbaixo = achadas
        .filter((b) => b !== a && b.y > a.y + 2 && b.x0 < a.x1 && b.x1 > a.x0)
        .reduce((min, b) => Math.min(min, b.y), a.y + 110);
      const naFaixa = (it: ItemTexto) => { const c = it.x + it.w / 2; return c >= a.x0 - 20 && c <= a.x1 + 20; };
      let abaixo = pg.itens
        .filter((it) => it.y > a.y + 2 && it.y < proximaAbaixo - 2)
        .filter(naFaixa)
        .sort((p, q) => p.y - q.y || p.x - q.x);
      // Linha no pé da página e o bloco de identificação caiu na página seguinte: lê o topo dela.
      if (!abaixo.length && paginas[idx + 1]) {
        const prox = paginas[idx + 1].itens.filter(naFaixa).sort((p, q) => p.y - q.y || p.x - q.x);
        const linhaProx = prox.find((it) => /[._]{8,}/.test(it.str));
        const limite = Math.min(prox.length ? prox[0].y + 110 : 0, linhaProx ? linhaProx.y - 2 : Infinity);
        abaixo = prox.filter((it) => it.y < limite);
      }
      linhas.push({
        pagina: idx + 1,
        xCentroPct: (((a.x0 + a.x1) / 2) / pg.largura) * 100,
        yLinhaPct: (a.y / pg.altura) * 100,
        prefixo: a.prefixo,
        textoAbaixo: normalizarNome(abaixo.map((i) => i.str).join(" ")),
      });
    }
  });
  return linhas;
}

export interface SignatarioPosicionavel { nome?: string; testemunha?: number } // testemunha = 1/2

// Liga cada signatário à sua linha: testemunhas pelo número ("1.____"), depois pelo nome no bloco
// abaixo; os demais pelo nome no bloco abaixo de uma linha sem número. Cada linha é usada uma vez.
// Quem não for encontrado fica sem posição (a assinatura sai só na página de auditoria, como antes).
export function casarLinhas(linhas: LinhaAssinatura[], signatarios: SignatarioPosicionavel[]): (LinhaAssinatura | null)[] {
  const usadas = new Set<LinhaAssinatura>();
  const res: (LinhaAssinatura | null)[] = signatarios.map(() => null);
  const pegar = (i: number, cands: LinhaAssinatura[]) => {
    // Na dúvida, a última ocorrência (bloco de assinaturas fica no fim do contrato).
    const l = cands.filter((c) => !usadas.has(c)).pop();
    if (l) { usadas.add(l); res[i] = l; }
  };
  signatarios.forEach((s, i) => {
    if (!s.testemunha) return;
    const nome = normalizarNome(s.nome || "");
    let c = linhas.filter((l) => l.prefixo === s.testemunha);
    if (!c.length && nome) c = linhas.filter((l) => l.textoAbaixo.includes(nome));
    pegar(i, c);
  });
  signatarios.forEach((s, i) => {
    if (s.testemunha) return;
    const nome = normalizarNome(s.nome || "");
    if (nome) pegar(i, linhas.filter((l) => l.prefixo === null && l.textoAbaixo.includes(nome)));
  });
  // Sobrou exatamente 1 signatário principal e 1 linha sem número → é dele (ex.: nome do
  // representante digitado diferente do que está no texto).
  const semLinha = signatarios.map((s, i) => (!res[i] && !s.testemunha ? i : -1)).filter((i) => i >= 0);
  const livres = linhas.filter((l) => l.prefixo === null && !usadas.has(l));
  if (semLinha.length === 1 && livres.length === 1) { usadas.add(livres[0]); res[semLinha[0]] = livres[0]; }
  return res;
}

// Posição do carimbo de assinatura: sobe o carimbo pra ficar MAIS em cima da linha do que embaixo
// (pedido do usuário — antes ficava centrado/meio pra baixo). y é medido do topo, então subtrair sobe.
// ALTURA_ACIMA_PCT ≈ altura do carimbo da Autentique (antes era ~metade).
const ALTURA_ACIMA_PCT = 3.8;
export function posicaoAssinatura(l: LinhaAssinatura) {
  return {
    x: l.xCentroPct.toFixed(2),
    y: Math.max(0, l.yLinhaPct - ALTURA_ACIMA_PCT).toFixed(2),
    z: l.pagina,
    element: "SIGNATURE" as const,
  };
}
