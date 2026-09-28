#Requires AutoHotkey v2.0
#SingleInstance Force
SetTitleMatchMode 2
SetKeyDelay 60, 60
CoordMode "Pixel", "Screen"
CoordMode "Mouse", "Screen"

; ============================================================================
;  AGENTE "COMPARATIVO DE MOVIMENTO" - Dominio Contabilidade Fiscal (streaming)
;
;  Fica rodando sozinho e PERGUNTA AO SITE a cada 10s se deve rodar (manual ou
;  automatico por intervalo). Ao rodar, puxa as empresas marcadas no site,
;  processa uma a uma e REPORTA O PROGRESSO (barra na tela do site).
;
;  PRE-REQUISITOS: Dominio ABERTO e LOGADO; F8 em modo "Codigo"; "Comparativo de
;  Movimento" no menu FAVORITOS; nenhuma janela cobrindo o canto sup. esquerdo.
;
;  Iniciar automatico no login: Agendador de Tarefas (ver LEIA-ME).
;  SAIR: Ctrl+Alt+Q.
; ============================================================================

; ---------------------------------------------------------------- CONFIGURACAO
SITE_URL     := "https://simplescontabeis-production.up.railway.app"
AGENTE_TOKEN := "COLE_AQUI_O_TOKEN_DO_AGENTE"

POLL_SEGUNDOS := 10       ; de quanto em quanto tempo pergunta ao site

DIGITAR_PERIODO := true   ; digita o periodo que o site mandar (padrao ou customizado)
FAV_KEY      := "f"       ; letra do menu FAVORITOS
DOMINIO_WIN  := "ahk_exe AppController.exe"

; Coordenadas de TELA da janela "Salvar em PDF" (abre em 0,23)
THISPC_X    := 52,   THISPC_Y    := 265
CAMPO_NOME_X:= 250,  CAMPO_NOME_Y:= 388

T_CURTO  := 700
T_MEDIO  := 2000
T_LONGO  := 4000
T_GERAR_PDF      := 15000
T_ENTRE_EMPRESAS := 15000
T_RENDER_TIMEOUT := 120000

LOGFILE := A_ScriptDir "\robo-comparativo.log"

^!q::ExitApp

; ------------------------------------------------------------------- HTTP
HttpReq(metodo, rota, corpo := "") {
    global SITE_URL, AGENTE_TOKEN
    try {
        req := ComObject("WinHttp.WinHttpRequest.5.1")
        req.Open(metodo, SITE_URL . rota, false)
        req.SetTimeouts(10000, 10000, 10000, 15000)
        req.SetRequestHeader("X-Agent-Token", AGENTE_TOKEN)
        if (metodo = "POST")
            req.SetRequestHeader("Content-Type", "application/json")
        req.Send(corpo)
        return req.ResponseText
    } catch as e {
        return ""
    }
}

JsonEscape(s) {
    s := StrReplace(s, "\", "\\")
    s := StrReplace(s, '"', '\"')
    s := StrReplace(s, "`r", " ")
    s := StrReplace(s, "`n", " ")
    return s
}

; ------------------------------------------------------------------- FUNCOES
CalcularPeriodo(&compIni, &compFim) {
    anoAtual := Integer(A_YYYY)
    mes := Integer(A_MM)
    anoFim := anoAtual
    mesFim := mes - 1
    if (mesFim = 0) {
        mesFim := 12
        anoFim := anoAtual - 1
    }
    compIni := "01/" . anoAtual
    compFim := Format("{:02}/{}", mesFim, anoFim)
}

Logar(txt) {
    global LOGFILE
    try FileAppend(FormatTime(A_Now, "yyyy-MM-dd HH:mm:ss") . "  " . txt . "`n", LOGFILE)
}

; VIGIA: fecha erros do Dominio (bug do chatbot) / Windows pelo X, nunca "Finalizar".
FecharErroSistema() {
    static ativo := false
    achou := false
    for titulo in ["Erro de sistema", "Location is not available"] {
        if WinExist(titulo) {
            WinClose(titulo)
            achou := true
        }
    }
    if (achou && !ativo) {
        Logar("AVISO: janela de erro (Dominio/Windows) apareceu - fechando pelo vigia.")
        ativo := true
    } else if (!achou) {
        ativo := false
    }
    if (achou)
        Sleep 300
}

TrocarEmpresa(codigo) {
    global T_CURTO, T_MEDIO, T_LONGO
    Send "{F8}"
    Sleep T_MEDIO
    Send "^a"
    Sleep 200
    SendText codigo
    Sleep T_MEDIO
    Send "{Enter}"
    Sleep T_LONGO
}

AbrirComparativo() {
    global FAV_KEY, T_CURTO, T_MEDIO
    Send "!" . FAV_KEY
    Sleep T_MEDIO
    Send "{Down}"
    Sleep T_CURTO
    Send "{Enter}"
    Sleep T_MEDIO
}

PreencherEGerar(compIni, compFim) {
    global DIGITAR_PERIODO, T_CURTO
    if (DIGITAR_PERIODO) {
        DigitarPeriodo(compIni)   ; Inicial (focado ao abrir o dialogo)
        Sleep T_CURTO
        Send "{Tab}"
        Sleep T_CURTO
        DigitarPeriodo(compFim)   ; Final
        Sleep T_CURTO
    }
    Send "!o"
    EsperarRender()
}

; Campo mascarado MM/AAAA: seleciona todo o conteudo (Home + Shift+End) e digita os
; 6 digitos devagar, deixando a mascara formatar. Evita grudar no valor antigo.
DigitarPeriodo(mmAAAA) {
    Send "{Home}"
    Sleep 150
    Send "+{End}"
    Sleep 150
    for ch in StrSplit(StrReplace(mmAAAA, "/", "")) {
        SendText ch
        Sleep 160
    }
}

EsperarRender() {
    global T_RENDER_TIMEOUT
    inicio := A_TickCount
    while (A_TickCount - inicio < T_RENDER_TIMEOUT) {
        if (PixelSearch(&px, &py, 130, 150, 1600, 520, 0x000000, 70)) {
            Sleep 1500
            return true
        }
        Sleep 1000
    }
    return false
}

DigitarCampo(digitos) {
    Send "{Home}"
    Sleep 150
    for ch in StrSplit(digitos) {
        SendText ch
        Sleep 130
    }
}

DigitarTexto(txt) {
    for ch in StrSplit(txt) {
        SendText ch
        Sleep 80
    }
}

LimparCampoNome() {
    Send "{Home}"
    Sleep 150
    Send "+{End}"
    Sleep 150
    Send "{Del}"
    Sleep 250
}

NavegarAtePasta() {
    global THISPC_X, THISPC_Y
    Click(THISPC_X . " " . THISPC_Y)
    Sleep 3000
    Send "+{Tab}"
    Sleep 2500
    SelecionarPastaPorNome("client g")
    SelecionarPastaPorNome("meu drive")
    SelecionarPastaPorNome("relatorios dominio")
}

SelecionarPastaPorNome(nome) {
    Sleep 800
    for ch in StrSplit(nome) {
        SendText ch
        Sleep 70
    }
    Sleep 900
    Send "{Enter}"
    Sleep 3000
}

FecharPrevia() {
    global T_CURTO
    Loop 2 {
        Send "{Esc}"
        Sleep T_CURTO
    }
}

MontarNome(codigo, compIni, compFim) {
    bruto := "Comparativo_" . codigo . "_" . StrReplace(compIni, "/", "") . "_" . StrReplace(compFim, "/", "")
    limpo := RegExReplace(bruto, "[^A-Za-z0-9_]", "")
    return limpo . ".pdf"
}

LimparTelas() {
    global T_CURTO
    FecharErroSistema()
    Loop 2 {
        Send "^{F4}"
        Sleep T_CURTO
        FecharErroSistema()
    }
    Loop 4 {
        Send "{Esc}"
        Sleep T_CURTO
        FecharErroSistema()
    }
}

ProcessarEmpresa(codigo, compIni, compFim) {
    global T_CURTO, T_MEDIO, T_LONGO, T_GERAR_PDF, CAMPO_NOME_X, CAMPO_NOME_Y
    Logar("Empresa " . codigo . ": iniciando")
    FecharErroSistema()
    Sleep 500
    LimparTelas()
    TrocarEmpresa(codigo)
    AbrirComparativo()
    PreencherEGerar(compIni, compFim)
    ; --- Salvar em PDF ---
    Sleep T_MEDIO
    Click("700 260")
    Sleep T_CURTO
    Send "^d"
    Sleep T_LONGO
    if !WinExist("Salvar em PDF") {   ; so manda Enter (OK no erro) se houve erro de caminho
        Send "{Enter}"
        Sleep T_LONGO
    }
    NavegarAtePasta()
    Sleep T_MEDIO
    try WinActivate("Salvar em PDF")
    Sleep 500
    MouseMove(CAMPO_NOME_X, CAMPO_NOME_Y)
    Sleep 400
    Click(CAMPO_NOME_X . " " . CAMPO_NOME_Y)
    Sleep 500
    Click(CAMPO_NOME_X . " " . CAMPO_NOME_Y)
    Sleep 500
    LimparCampoNome()
    DigitarTexto(MontarNome(codigo, compIni, compFim))
    Sleep T_CURTO
    Send "{Enter}"
    Sleep T_CURTO
    Send "{Enter}"
    Sleep T_GERAR_PDF
    FecharPrevia()
    Logar("Empresa " . codigo . ": PDF salvo")
}

; ------------------------------------------------------------- SITE (comandos)
; Extrai o valor string de uma chave do JSON: "chave":"valor"
ExtrairStr(body, chave) {
    if RegExMatch(body, '"' . chave . '":"([^"]*)"', &m)
        return m[1]
    return ""
}

ReportarProgresso(rodando, total, feitas, atual, iniciando) {
    atualJson := atual != "" ? '"' . JsonEscape(atual) . '"' : "null"
    json := '{"rodando":' . (rodando ? "true" : "false") . ',"total":' . total . ',"feitas":' . feitas
          . ',"atual":' . atualJson . ',"iniciando":' . (iniciando ? "true" : "false") . "}"
    HttpReq("POST", "/api/dominio-agent/comparativo-progresso", json)
}

PegarEmpresas() {
    body := HttpReq("GET", "/api/dominio-agent/empresas-comparativo")
    lista := []
    pos := 1
    pat := '"codigoDominio":"([^"]*)","nome":"([^"]*)"'
    while (pos := RegExMatch(body, pat, &m, pos)) {
        lista.Push({ codigo: m[1], nome: m[2] })
        pos += StrLen(m[0])
    }
    return lista
}

ReportarStatus(itens) {
    if (itens.Length = 0)
        return
    partes := []
    for it in itens {
        erroJson := it.HasOwnProp("erro") && it.erro != "" ? ',"erro":"' . JsonEscape(it.erro) . '"' : ""
        partes.Push('{"codigoDominio":"' . it.codigo . '","ok":' . (it.ok ? "true" : "false") . erroJson . "}")
    }
    s := ""
    for i, v in partes
        s .= (i > 1 ? "," : "") . v
    HttpReq("POST", "/api/dominio-agent/comparativo-status", '{"itens":[' . s . "]}")
}

RodarCiclo(compIni, compFim) {
    global DOMINIO_WIN, T_ENTRE_EMPRESAS
    empresas := PegarEmpresas()
    total := empresas.Length
    Logar("=== EXECUCAO: " . total . " empresa(s), periodo " . compIni . " a " . compFim . " ===")
    ReportarProgresso(true, total, 0, "", true)      ; iniciando (limpa "executar agora" no site)
    if (total = 0) {
        ReportarProgresso(false, 0, 0, "", false)
        return
    }
    if !WinExist(DOMINIO_WIN) {
        Logar("ERRO: Dominio nao esta aberto - execucao cancelada.")
        ReportarProgresso(false, total, 0, "", false)
        return
    }
    WinActivate(DOMINIO_WIN)
    Sleep 1000
    resultados := []
    feitas := 0
    for e in empresas {
        if (feitas > 0)
            Sleep T_ENTRE_EMPRESAS
        ReportarProgresso(true, total, feitas, e.codigo . " - " . e.nome, false)
        try {
            ProcessarEmpresa(e.codigo, compIni, compFim)
            resultados.Push({ codigo: e.codigo, ok: true })
        } catch as err {
            Logar("Empresa " . e.codigo . ": ERRO " . err.Message)
            resultados.Push({ codigo: e.codigo, ok: false, erro: err.Message })
        }
        feitas++
        ReportarProgresso(true, total, feitas, "", false)
    }
    ReportarStatus(resultados)
    ReportarProgresso(false, total, feitas, "", false)
    Logar("=== EXECUCAO concluida (" . feitas . "/" . total . ") ===")
}

; ==================================================================== MAIN
Logar("=== Agente iniciado ===")
SetTimer(FecharErroSistema, 400)     ; vigia do erro do chatbot, sempre ativo

Loop {
    body := HttpReq("GET", "/api/dominio-agent/comparativo-comando")
    if (InStr(body, '"deveRodar":true')) {
        compIni := ExtrairStr(body, "periodoIni")
        compFim := ExtrairStr(body, "periodoFim")
        if (compIni = "" || compFim = "")
            CalcularPeriodo(&compIni, &compFim)   ; fallback se o site nao mandou
        RodarCiclo(compIni, compFim)
    }
    Sleep POLL_SEGUNDOS * 1000
}
