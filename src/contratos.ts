import fs from "fs";
import path from "path";
import mammoth from "mammoth";
import JSZip from "jszip";

// Geração de PDF via Playwright (já é dependência real do projeto, usada hoje pelo agente do
// Domínio Web — o Chromium headless já fica baixado no ambiente, então não precisa de nenhuma lib
// nova só pra isso).

const CONTRATOS_PDF_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, "..", "data"), "contratos-pdf");
fs.mkdirSync(CONTRATOS_PDF_DIR, { recursive: true });

export function caminhoPdfContrato(contratoId: number): string {
  return path.join(CONTRATOS_PDF_DIR, `${contratoId}.pdf`);
}

// Escapa texto puro (ex.: descrição digitada pelo admin, não vinda do editor rico) antes de virar
// parte de um HTML já montado — sem isso, um "<" ou "&" digitado quebraria a estrutura do
// documento. Quebras de linha viram <br>, já que o campo de origem costuma ser um textarea simples.
export function escaparEQuebrarLinhas(texto: string): string {
  const escapado = texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return escapado.replace(/\n/g, "<br>");
}

// Troca {{chave}} pelo valor correspondente em `dados`. Um token sem valor correspondente
// continua visível no texto (em vez de virar branco) — assim o admin percebe na hora o que ainda
// falta preencher, em vez de descobrir só quando o cliente reclamar de uma cláusula em branco.
// \p{L} (com a flag "u") em vez de \w — chaves em português têm acento/cedilha de verdade
// (ex.: {{endereço}}, {{inscrição_municipal}}, {{valor_honorário}}), e \w sozinho não reconhece
// esses caracteres, então o token nunca batia e ficava visível pra sempre mesmo com dado preenchido.
export function aplicarCamposNoModelo(conteudoHtml: string, dados: Record<string, string | number | null | undefined>): string {
  return conteudoHtml.replace(/\{\{([\p{L}\p{N}_]+)\}\}/gu, (match, chave) => {
    const valor = dados[chave];
    return valor === undefined || valor === null || valor === "" ? match : String(valor);
  });
}

const UNIDADES_EXT = ["", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove"];
const DEZ_A_DEZENOVE_EXT = ["dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
const DEZENAS_EXT = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const CENTENAS_EXT = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];
function extensoAte999(n: number): string {
  if (n === 0) return "";
  if (n === 100) return "cem";
  const c = Math.floor(n / 100);
  const resto = n % 100;
  const partes: string[] = [];
  if (c > 0) partes.push(CENTENAS_EXT[c]);
  if (resto > 0) {
    if (resto < 10) partes.push(UNIDADES_EXT[resto]);
    else if (resto < 20) partes.push(DEZ_A_DEZENOVE_EXT[resto - 10]);
    else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      partes.push(DEZENAS_EXT[d] + (u > 0 ? " e " + UNIDADES_EXT[u] : ""));
    }
  }
  return partes.join(" e ");
}
function extensoInteiro(n: number): string {
  if (n === 0) return "zero";
  const milhoes = Math.floor(n / 1_000_000);
  const resto1 = n % 1_000_000;
  const milhares = Math.floor(resto1 / 1000);
  const centenas = resto1 % 1000;
  const grupos: { texto: string; valor: number }[] = [];
  if (milhoes > 0) grupos.push({ texto: `${extensoAte999(milhoes)} ${milhoes === 1 ? "milhão" : "milhões"}`, valor: milhoes * 1_000_000 });
  if (milhares > 0) grupos.push({ texto: milhares === 1 ? "mil" : `${extensoAte999(milhares)} mil`, valor: milhares * 1000 });
  if (centenas > 0) grupos.push({ texto: extensoAte999(centenas), valor: centenas });
  if (grupos.length === 1) return grupos[0].texto;
  // "e" antes do último grupo quando ele é < 100 ou é uma centena redonda (200, 300...900) — senão
  // vírgula entre os grupos, com o "e" interno de cada grupo (ex.: "cento e cinquenta") preservado.
  const ultimo = grupos[grupos.length - 1];
  const usaE = ultimo.valor > 0 && (ultimo.valor < 100 || ultimo.valor % 100 === 0);
  return grupos
    .slice(0, -1)
    .map((g) => g.texto)
    .join(", ") + (usaE ? " e " : ", ") + ultimo.texto;
}
// Valor monetário por extenso (padrão de contrato/nota fiscal brasileiro) — ex.: 1500.75 ->
// "mil e quinhentos reais e setenta e cinco centavos". Trabalha em centavos internamente pra não
// sofrer erro de arredondamento de ponto flutuante.
export function valorPorExtenso(valor: number): string {
  const negativo = valor < 0;
  const totalCentavos = Math.round(Math.abs(valor) * 100);
  const reais = Math.floor(totalCentavos / 100);
  const centavos = totalCentavos % 100;
  const partes: string[] = [];
  if (reais > 0) partes.push(`${extensoInteiro(reais)} ${reais === 1 ? "real" : "reais"}`);
  if (centavos > 0) partes.push(`${extensoInteiro(centavos)} ${centavos === 1 ? "centavo" : "centavos"}`);
  if (partes.length === 0) return "zero reais";
  return (negativo ? "menos " : "") + partes.join(" e ");
}

// Mammoth por padrão ignora alinhamento direto de parágrafo (só mapeia estilos nomeados, tipo
// Heading 1) — mas o alinhamento original ainda fica acessível em element.alignment antes da
// conversão. Esse transform marca cada parágrafo alinhado ao centro/direita/justificado (que ainda
// não tenha um estilo nomeado, pra não atropelar títulos) com uma classe própria, que o styleMap
// abaixo transforma em <p class="align-...">.
const ALINHAMENTO_PARA_CLASSE: Record<string, string> = {
  center: "align-center",
  right: "align-right",
  both: "align-justify", // é assim que o Word representa "justificado" internamente
};
function marcarAlinhamento(paragrafo: any) {
  const classe = paragrafo.alignment && ALINHAMENTO_PARA_CLASSE[paragrafo.alignment];
  if (classe && !paragrafo.styleId) {
    return { ...paragrafo, styleId: classe, styleName: classe };
  }
  return paragrafo;
}
const EXT_PARA_CONTENT_TYPE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".emf": "image/x-emf", // formato vetorial do Office — navegador não renderiza, mas ao menos não quebra
  ".wmf": "image/x-wmf",
};
// O mammoth só lê o corpo do documento (word/document.xml) — logos de contrato costumam ficar no
// cabeçalho (word/header*.xml), que o Word guarda à parte. Aqui a gente abre o .docx como o zip que
// ele é por baixo, acha as imagens referenciadas em QUALQUER cabeçalho e devolve como data URIs, pra
// grudar no topo do HTML convertido.
async function extrairImagensDoCabecalho(buffer: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buffer);
  const arquivosHeader = Object.keys(zip.files).filter((nome) => /^word\/header\d+\.xml$/.test(nome));
  const imagens: string[] = [];
  for (const headerPath of arquivosHeader) {
    const headerXml = await zip.file(headerPath)!.async("string");
    // Imagem "moderna" (DrawingML, w:drawing/a:blip) usa r:embed; imagem inserida como figura
    // solta/marca d'água antiga (VML, w:pict/v:imagedata) usa r:id — os dois aparecem em arquivos
    // reais, então checa as duas formas.
    const idsReferenciados = [
      ...[...headerXml.matchAll(/r:embed="([^"]+)"/g)].map((m) => m[1]),
      ...[...headerXml.matchAll(/<v:imagedata[^>]*r:id="([^"]+)"/g)].map((m) => m[1]),
    ];
    if (!idsReferenciados.length) continue;
    const relsPath = `word/_rels/${path.basename(headerPath)}.rels`;
    const relsFile = zip.file(relsPath);
    if (!relsFile) continue;
    const relsXml = await relsFile.async("string");
    for (const rid of idsReferenciados) {
      const relMatch = new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`).exec(relsXml);
      if (!relMatch) continue;
      const mediaPath = `word/${relMatch[1]}`.replace(/\/\.\.\//g, "/");
      const mediaFile = zip.file(mediaPath);
      if (!mediaFile) continue;
      const ext = path.extname(mediaPath).toLowerCase();
      const contentType = EXT_PARA_CONTENT_TYPE[ext];
      if (!contentType) continue; // formato que o navegador não exibe mesmo (raro) — ignora em vez de quebrar
      const base64 = await mediaFile.async("base64");
      imagens.push(`data:${contentType};base64,${base64}`);
    }
  }
  return imagens;
}
// Documento de contrato real costuma misturar títulos de cláusula com estilo "Heading" de verdade
// (viraria <h1>, bem maior e desalinhado do resto) com títulos feitos "na mão" (negrito+centralizado
// como parágrafo comum) — o resultado sai com uns títulos gigantes e outros discretos, bem
// inconsistente. Aqui força TODOS os níveis de título a saírem no mesmo formato (negrito, centralizado,
// tamanho de destaque moderado — ver .clausula-titulo no CSS), igual a como a maioria já vem no
// documento original.
const MAPA_TITULOS = [
  "p[style-name='Heading 1'] => p.clausula-titulo:fresh",
  "p[style-name='Heading 2'] => p.clausula-titulo:fresh",
  "p[style-name='Heading 3'] => p.clausula-titulo:fresh",
  "p[style-name='Title'] => p.clausula-titulo:fresh",
];
// O Word às vezes descreve uma lista numerada de sub-cláusulas como se fosse um item de lista com
// marcador (bullet) que só contém, dentro dele, a lista numerada de verdade — o mammoth reproduz
// isso literalmente como <ul><li><ol>...</ol></li></ul>, o que aparece na tela como um "•" solto
// bem antes do "1." de verdade. Isso não é conteúdo real, é só como o Word guardou a numeração
// internamente — então desembrulha esse padrão específico depois de converter.
function limparListaAninhadaFantasma(html: string): string {
  let anterior;
  do {
    anterior = html;
    html = html
      .replace(/<ul><li><ol>/g, "<ol>")
      .replace(/<\/ol><\/li><\/ul>/g, "</ol>")
      .replace(/<ol><li><ul>/g, "<ul>")
      .replace(/<\/ul><\/li><\/ol>/g, "</ul>");
  } while (html !== anterior);
  return html;
}
// Converte um .docx (Word) pro HTML que já entra direto no editor do modelo — o admin sobe o
// arquivo que já usa hoje e continua livre pra editar/inserir os {{campos}} depois, sem digitar o
// contrato inteiro de novo. Só aceita .docx (formato OOXML) — o .doc antigo não é suportado.
// Preserva alinhamento (centro/direita/justificado), imagens do corpo do documento, e também busca
// separadamente imagens de cabeçalho (logo de timbrado), já que o mammoth por si só não lê essa
// parte do arquivo.
export async function converterDocxParaHtml(buffer: Buffer): Promise<string> {
  const [resultado, imagensCabecalho] = await Promise.all([
    mammoth.convertToHtml(
      { buffer },
      {
        // @types/mammoth não declara "transforms" (existe em runtime, só falta no .d.ts)
        transformDocument: (mammoth as any).transforms.paragraph(marcarAlinhamento),
        styleMap: [
          ...MAPA_TITULOS,
          "p[style-name='align-center'] => p.align-center:fresh",
          "p[style-name='align-right'] => p.align-right:fresh",
          "p[style-name='align-justify'] => p.align-justify:fresh",
        ],
      }
    ),
    extrairImagensDoCabecalho(buffer).catch(() => []), // cabeçalho não é essencial — se falhar, segue só com o corpo
  ]);
  // Largura travada, bem conservadora — imagem de cabeçalho de contrato costuma ser uma peça
  // decorativa alta e estreita (papel timbrado/borda lateral), não um logo quadrado, então mesmo
  // limitando a largura ela ainda fica alta. Entra pequena por padrão; clicando na imagem dentro
  // do editor dá pra arrastar o cantinho e redimensionar na hora (recurso nativo do navegador).
  // Marcada com a classe "cabecalho-repetido" pra, na hora de gerar o PDF, sair do corpo do texto
  // e virar cabeçalho de página de verdade — repetindo em toda página, igual no Word (ver
  // gerarPdfDeHtml abaixo). No editor, continua aparecendo normal, uma vez só, no topo do texto.
  const prefixoCabecalho = imagensCabecalho.map((src) => `<p class="align-center cabecalho-repetido"><img src="${src}" width="110"></p>`).join("");
  return prefixoCabecalho + limparListaAninhadaFantasma(resultado.value);
}

const CONTRATO_PDF_CSS_BASE = `
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 12.5px; line-height: 1.6; color: #1a1a1a; }
  h1, h2, h3 { font-family: Georgia, 'Times New Roman', serif; }
  h1 { font-size: 16px; text-align: center; margin-bottom: 18px; }
  p { margin: 0 0 10px; text-align: justify; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #999; padding: 4px 8px; }
  img { max-width: 100%; }
  .align-center { text-align: center; }
  .align-right { text-align: right; }
  .align-justify { text-align: justify; }
  .clausula-titulo { font-weight: bold; text-align: center; font-size: 13.5px; margin: 20px 0 10px; }
`;

// Se o corpo tiver a imagem de papel timbrado marcada (ver converterDocxParaHtml), tira ela do
// fluxo do texto — ela costuma ser um papel timbrado de página inteira (logo no topo + marca
// d'água + rodapé com contato, tudo numa imagem só, do jeito que o Word guarda cabeçalho de
// página), não um bannerzinho.
function separarCabecalhoRepetido(conteudoHtml: string): { corpo: string; imagemCabecalho: string | null } {
  const match = /<p class="align-center cabecalho-repetido"><img src="([^"]+)"[^>]*><\/p>/.exec(conteudoHtml);
  if (!match) return { corpo: conteudoHtml, imagemCabecalho: null };
  return { corpo: conteudoHtml.slice(0, match.index) + conteudoHtml.slice(match.index + match[0].length), imagemCabecalho: match[1] };
}
// Devolve o parágrafo do timbrado (com a tag <p> inteira) pra reaproveitar tal e qual — usado
// quando um aditivo é criado a partir de um contrato, pra já nascer com o mesmo timbrado.
export function extrairTrechoCabecalho(conteudoHtml: string): string | null {
  const match = /<p class="align-center cabecalho-repetido"><img src="[^"]+"[^>]*><\/p>/.exec(conteudoHtml);
  return match ? match[0] : null;
}

// Altura (em mm) das tiras de topo/rodapé recortadas da imagem de papel timbrado, e a margem real
// de cada página (com folga pro texto não encostar nelas). Definido testando contra o timbrado real
// — tentei primeiro pintar a imagem inteira como fundo da página (via @page/background), mas o
// Chromium (headless, print-to-PDF) escala e posiciona esse fundo errado sempre que a página tem
// margem diferente de zero — bug conhecido desse motor, não tem como contornar só com CSS. A solução
// que funciona de verdade é o recurso nativo de cabeçalho/rodapé do Playwright: cada tira é só um
// recorte (via overflow:hidden + deslocamento negativo) da MESMA imagem, aplicado como
// headerTemplate/footerTemplate — isso o Chromium recorta e repete certinho em toda página impressa.
const TIRA_TOPO_MM = 45;
const TIRA_RODAPE_MM = 32;
const A4_ALTURA_MM = 297;

export async function gerarPdfDeHtml(conteudoHtml: string, titulo: string): Promise<Buffer> {
  const { corpo, imagemCabecalho } = separarCabecalhoRepetido(conteudoHtml);
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // Importante: quando tem timbrado, NÃO declara margin no @page (nem "0") — declarar qualquer
    // valor aqui faz o Chromium ignorar o "margin" passado pro page.pdf() abaixo (testado: com
    // "margin:0" no @page o texto ignora a margem do page.pdf() e escreve por baixo do cabeçalho).
    // Omitindo a propriedade, o "margin" do page.pdf() é quem manda, do jeito que precisa ser aqui.
    const css = imagemCabecalho ? `${CONTRATO_PDF_CSS_BASE} @page { size: A4; }` : `${CONTRATO_PDF_CSS_BASE} @page { size: A4; margin: 20mm 18mm; }`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${titulo}</title><style>${css}</style></head><body>${corpo}</body></html>`;
    await page.setContent(html, { waitUntil: "networkidle" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: !!imagemCabecalho,
      headerTemplate: imagemCabecalho
        ? `<div style="width:210mm; height:${TIRA_TOPO_MM}mm; overflow:hidden; margin:0; padding:0;"><img src="${imagemCabecalho}" style="width:210mm; display:block; margin:0;"></div>`
        : "<span></span>",
      footerTemplate: imagemCabecalho
        ? `<div style="width:210mm; height:${TIRA_RODAPE_MM}mm; overflow:hidden; margin:0; padding:0;"><img src="${imagemCabecalho}" style="width:210mm; display:block; margin-top:-${A4_ALTURA_MM - TIRA_RODAPE_MM}mm;"></div>`
        : "<span></span>",
      margin: imagemCabecalho ? { top: `${TIRA_TOPO_MM + 8}mm`, bottom: `${TIRA_RODAPE_MM + 8}mm`, left: "18mm", right: "18mm" } : undefined,
    });
    return pdf as Buffer;
  } finally {
    await browser.close();
  }
}
