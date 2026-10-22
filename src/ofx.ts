// Leitor de extrato bancário OFX — tolerante o bastante pra cobrir tanto OFX 1.x (SGML, tags sem
// fechamento, formato mais comum em banco brasileiro) quanto OFX 2.x (XML bem formado): em vez de
// fazer parse estrutural de verdade, varre cada bloco <STMTTRN>...</STMTTRN> com regex e lê cada tag
// como "<TAG>valor até o próximo < ou quebra de linha" — funciona nos dois formatos sem precisar
// saber de antemão qual deles é.
export interface OfxTransacao {
  fitid: string; // ID único da transação dentro do extrato do banco — usado pra não reimportar a mesma duas vezes
  data: string; // YYYY-MM-DD
  valor: number; // positivo = crédito/entrada, negativo = débito/saída
  descricao: string;
  tipoOfx: string; // TRNTYPE bruto (DEBIT, CREDIT, PIX, XFER, ...) — só informativo
}
export interface OfxExtrato {
  transacoes: OfxTransacao[];
  contaBanco: string | null;
  dataInicio: string | null;
  dataFim: string | null;
}

function extrairTag(bloco: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>\\s*([^<\\r\\n]*)`, "i");
  const m = re.exec(bloco);
  const v = m ? m[1].trim() : null;
  return v || null;
}
// "20261001120000[-3:BRT]" ou "20261001" — só os 8 primeiros dígitos (AAAAMMDD) interessam.
function parseDataOfx(raw: string | null): string | null {
  if (!raw) return null;
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(raw);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
export function parseOfx(conteudo: string): OfxExtrato {
  const blocos = conteudo.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) || [];
  const transacoes: OfxTransacao[] = [];
  for (const bloco of blocos) {
    const fitid = extrairTag(bloco, "FITID");
    const data = parseDataOfx(extrairTag(bloco, "DTPOSTED"));
    const trnAmtRaw = extrairTag(bloco, "TRNAMT");
    if (!fitid || !data || trnAmtRaw == null) continue; // sem isso não dá pra identificar/conciliar a transação
    const valor = Number(trnAmtRaw.replace(",", "."));
    if (!Number.isFinite(valor)) continue;
    const memo = extrairTag(bloco, "MEMO") || "";
    const name = extrairTag(bloco, "NAME") || "";
    transacoes.push({
      fitid,
      data,
      valor,
      descricao: [name, memo].filter(Boolean).join(" — ") || "Sem descrição no extrato",
      tipoOfx: extrairTag(bloco, "TRNTYPE") || "",
    });
  }
  return {
    transacoes,
    contaBanco: extrairTag(conteudo, "ACCTID"),
    dataInicio: parseDataOfx(extrairTag(conteudo, "DTSTART")),
    dataFim: parseDataOfx(extrairTag(conteudo, "DTEND")),
  };
}
