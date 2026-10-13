#Requires AutoHotkey v2.0
#SingleInstance Force
SetTitleMatchMode 2
SetKeyDelay 60, 60
CoordMode "Pixel", "Screen"
CoordMode "Mouse", "Screen"

; ============================================================================
;  AGENTE "DEMONSTRATIVO MENSAL" - Dominio Escrita Fiscal (streaming)
;
;  3o robo do Dominio (depois do Comparativo e da Programacao de Ferias).
;  Fica rodando sozinho e PERGUNTA AO SITE a cada 10s se deve rodar (manual ou
;  automatico por intervalo). Ao rodar, puxa as empresas marcadas no site,
;  processa uma a uma e REPORTA O PROGRESSO (barra na tela do site).
;
;  PRE-REQUISITOS: Dominio ABERTO e LOGADO; F8 em modo "Codigo"; "Demonstrativo
;  Mensal" no menu FAVORITOS (e o ULTIMO item); nenhuma janela cobrindo o canto
;  sup. esquerdo.
;
;  Iniciar automatico no login: Agendador de Tarefas (ver LEIA-ME).
;  SAIR: Ctrl+Alt+Q.
; ============================================================================

; ---------------------------------------------------------------- CONFIGURACAO
SITE_URL     := "https://simplescontabeis-production.up.railway.app"
AGENTE_TOKEN := "COLE_AQUI_O_TOKEN_DO_AGENTE"

POLL_SEGUNDOS := 10       ; de quanto em quanto tempo pergunta ao site

; true = digita o periodo que o site mandar (padrao 01/ano vigente ate a competencia
; anterior, ou o customizado na tela). Clica DIRETO em cada campo (sem Tab) e digita os
; 6 digitos devagar (streaming). Coords PER_* vindas do Window Spy (prints do dialogo).
DIGITAR_PERIODO := true
; Re-selecionar o modulo Escrita Fiscal a cada execucao? true = garante o modulo certo.
SELECIONAR_MODULO := true
FAV_KEY      := "f"       ; letra do menu FAVORITOS
DOMINIO_WIN  := "ahk_exe AppController.exe"

; Pasta LOCAL do Google Drive (pra CONFERIR se o PDF salvou e repetir se falhar)
PASTA_LOCAL  := "G:\Meu Drive\Relatorios Dominio"
MAX_TENTATIVAS := 3       ; quantas vezes tenta cada empresa se o PDF nao aparecer

; Coordenadas de TELA da janela "Salvar em PDF" (abre em 0,23)
THISPC_X    := 52,   THISPC_Y    := 265
CAMPO_NOME_X:= 250,  CAMPO_NOME_Y:= 388

; Coordenadas de TELA dos campos de periodo no dialogo "Demonstrativo Mensal"
; (Window Spy, prints do usuario). Inicial em cima, Final logo abaixo (empilhados).
PER_INI_X   := 1207, PER_INI_Y   := 821    ; campo Inicial (01/AAAA)
PER_FIM_X   := 1210, PER_FIM_Y   := 843    ; campo Final   (MM/AAAA)

; Centro do dialogo "Sem dados para emitir !" (clique pra dar FOCO de teclado antes do Enter/OK)
SEMDADOS_X  := 1286, SEMDADOS_Y  := 796

; SELECAO DE MODULO: 1) clica o logo DOMINIO (abre o menu de modulos); 2) clica "Escrita Fiscal".
LOGO_X      := 49,   LOGO_Y      := 83     ; logo "DOMINIO" (abre menu de modulos)
MODULO_X    := 80,   MODULO_Y    := 252    ; item "Escrita Fiscal" no menu de modulos
T_MODULO_CARGA := 10000                    ; espera o modulo carregar (~10s)

T_CURTO  := 700
T_MEDIO  := 2000
T_LONGO  := 4000
T_GERAR_PDF      := 15000
T_ENTRE_EMPRESAS := 15000
T_RENDER_TIMEOUT := 90000                  ; espera o relatorio renderizar ate 90s; senao trata como sem dados

LOGFILE := A_ScriptDir "\robo-demonstrativo-mensal.log"

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
; Periodo padrao (fallback, so se o site nao mandar): 01/ano vigente ate a COMPETENCIA
; ANTERIOR (mes passado) - igual ao Comparativo e ao default do dialogo do Demonstrativo.
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

ListarJanelasDominio() {
    s := ""
    a := WinExist("A")
    for hwnd in WinGetList("ahk_exe AppController.exe") {
        w := 0, h := 0
        try WinGetPos(, , &w, &h, "ahk_id " . hwnd)
        s .= "{'" . WinGetTitle("ahk_id " . hwnd) . "' " . w . "x" . h . (hwnd = a ? " ATIVO" : "") . "} "
    }
    return s
}

DialogoSemDados() {
    for hwnd in WinGetList("ahk_exe AppController.exe") {
        t := WinGetTitle("ahk_id " . hwnd)
        if !(InStr(t, "Aviso") || InStr(t, "Sem dados"))
            continue
        w := 0, h := 0
        try WinGetPos(, , &w, &h, "ahk_id " . hwnd)
        if (w > 60 && h > 60 && w <= 900 && h <= 600)
            return true
    }
    return false
}

DominioAberto() {
    for hwnd in WinGetList("ahk_exe AppController.exe") {
        if !InStr(WinGetTitle("ahk_id " . hwnd), "Lista de Programas")
            return true
    }
    return false
}

AtivarApp() {
    global DOMINIO_WIN
    alvo := 0
    for hwnd in WinGetList("ahk_exe AppController.exe") {
        if !InStr(WinGetTitle("ahk_id " . hwnd), "Lista de Programas") {
            alvo := hwnd
            break
        }
    }
    if (alvo) {
        try WinActivate("ahk_id " . alvo)
    } else if WinExist(DOMINIO_WIN) {
        WinActivate(DOMINIO_WIN)
    }
}

NoLauncher() {
    return InStr(WinGetTitle("A"), "Lista de Programas") || InStr(WinGetTitle("A"), "Dominio Web")
}

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

; Abre Favoritos > Demonstrativo Mensal. O item e o ULTIMO do menu, entao
; Alt+F -> Up (da a volta e vai pro ultimo) -> Enter. Foco antes (streaming).
AbrirDemonstrativo() {
    global FAV_KEY, T_CURTO, T_MEDIO
    Click("700 400")             ; foco de teclado (streaming)
    Sleep 400
    Send "!" . FAV_KEY           ; Alt+F -> abre Favoritos
    Sleep T_MEDIO
    Send "{Up}"                  ; sobe 1 = ultimo item (Demonstrativo Mensal)
    Sleep T_CURTO
    Send "{Enter}"
    Sleep T_MEDIO
}

PreencherEGerar(compIni, compFim) {
    global DIGITAR_PERIODO, T_CURTO, PER_INI_X, PER_INI_Y, PER_FIM_X, PER_FIM_Y
    if (DIGITAR_PERIODO) {
        ClicarEDigitarPeriodo(PER_INI_X, PER_INI_Y, compIni)   ; Inicial
        Sleep T_CURTO
        ClicarEDigitarPeriodo(PER_FIM_X, PER_FIM_Y, compFim)   ; Final
        Sleep T_CURTO
    }
    Send "!o"                    ; botao OK (Alt+O)
    return EsperarRender()
}

ClicarEDigitarPeriodo(x, y, mmAAAA) {
    Click(x . " " . y)
    Sleep 400
    Click(x . " " . y)
    Sleep 400
    Send "{Home}"
    Sleep 120
    Send "+{End}"
    Sleep 120
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
            return "ok"
        }
        if (DialogoSemDados()) {
            Sleep 1200
            if (DialogoSemDados() && !PixelSearch(&px2, &py2, 130, 150, 1600, 520, 0x000000, 70)) {
                Logar("  'Sem dados' (Aviso) detectado (pulo rapido)")
                return "sem_dados"
            }
        }
        Sleep 800
    }
    Logar("  render TIMEOUT (nao renderizou em " . (T_RENDER_TIMEOUT // 1000) . "s) - janelas: " . ListarJanelasDominio())
    return "sem_dados"
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
    Logar("    nav: clicando This PC (" . THISPC_X . "," . THISPC_Y . ")")
    Click(THISPC_X . " " . THISPC_Y)   ; "This PC" (barra esquerda) - reset de qualquer pasta
    Sleep 4500
    Send "+{Tab}"                      ; foca a lista de drives/pastas
    Sleep 4500
    ; "client g" e o ponto mais fragil: o streaming perde o 'g' e cai no "Client C" -> Recovery.
    ; Digita BEM devagar (150ms/char) com folga antes/depois.
    SelecionarPastaPorNome("client g", 150, 2000)
    SelecionarPastaPorNome("meu drive", 90, 1500)
    SelecionarPastaPorNome("relatorios dominio", 90, 1500)
    Logar("    nav: terminou a navegacao")
}

SelecionarPastaPorNome(nome, msPorChar := 90, folga := 1500) {
    Sleep folga
    for ch in StrSplit(nome) {
        SendText ch
        Sleep msPorChar
    }
    Sleep folga
    Send "{Enter}"
    Sleep 4000
    Logar("    nav: '" . nome . "' -> Enter | SalvarPDF aberta: " . (WinExist("Salvar em PDF") ? "sim" : "NAO") . " | janelas: " . ListarJanelasDominio())
}

FecharPrevia() {
    global T_CURTO
    Loop 2 {
        Send "{Esc}"
        Sleep T_CURTO
    }
}

MontarNome(codigo, compIni, compFim) {
    bruto := "Demonstrativo_Mensal_" . codigo . "_" . StrReplace(compIni, "/", "") . "_" . StrReplace(compFim, "/", "")
    limpo := RegExReplace(bruto, "[^A-Za-z0-9_]", "")
    return limpo . ".pdf"
}

LimparTelas() {
    global T_CURTO
    FecharErroSistema()
    Loop 6 {
        Send "{Esc}"
        Sleep T_CURTO
        FecharErroSistema()
    }
}

; Garante o modulo Escrita Fiscal.
SelecionarModulo() {
    global LOGO_X, LOGO_Y, MODULO_X, MODULO_Y, T_MODULO_CARGA, T_MEDIO
    FecharErroSistema()
    Click(LOGO_X . " " . LOGO_Y)      ; logo DOMINIO -> abre o menu de modulos
    Sleep T_MEDIO
    Click(MODULO_X . " " . MODULO_Y)  ; clica no modulo (Escrita Fiscal)
    Sleep T_MODULO_CARGA
    FecharErroSistema()
}

ProcessarEmpresa(codigo, compIni, compFim) {
    global T_CURTO, T_MEDIO, T_LONGO, T_GERAR_PDF, CAMPO_NOME_X, CAMPO_NOME_Y, SEMDADOS_X, SEMDADOS_Y
    Logar("Empresa " . codigo . ": iniciando")
    FecharErroSistema()
    Sleep 500
    LimparTelas()
    Click("700 400")
    Sleep 500
    Logar("  [1] apos LimparTelas+foco: " . ListarJanelasDominio())
    TrocarEmpresa(codigo)
    Logar("  [2] apos F8/troca empresa: " . ListarJanelasDominio())
    AbrirDemonstrativo()
    Logar("  [3] apos Favoritos/Demonstrativo: " . ListarJanelasDominio())
    st := PreencherEGerar(compIni, compFim)
    Logar("  [4] apos gerar: " . st)
    if (st != "ok") {
        Logar("Empresa " . codigo . ": sem relatorio (" . st . ") - OK/Esc e proxima")
        Click(SEMDADOS_X . " " . SEMDADOS_Y)
        Sleep 600
        Send "{Enter}"
        Sleep 5000
        Send "{Esc}"
        Sleep T_CURTO
        Send "{Esc}"
        Sleep 2000
        LimparTelas()
        return "pular"
    }
    ; --- Salvar em PDF ---
    Sleep 8000
    Click("700 260")
    Sleep T_CURTO
    Send "^d"
    ini := A_TickCount
    while (!WinExist("Salvar em PDF") && (A_TickCount - ini) < 30000)
        Sleep 500
    if !WinExist("Salvar em PDF") {
        Send "{Enter}"
        Sleep 5000
        ini := A_TickCount
        while (!WinExist("Salvar em PDF") && (A_TickCount - ini) < 20000)
            Sleep 500
    }
    if WinExist("Salvar em PDF")
        Logar("  Salvar em PDF ABRIU - navegando ate a pasta")
    else
        Logar("  AVISO: Salvar em PDF NAO detectada apos Ctrl+D - vou tentar navegar mesmo assim")
    Sleep 4000
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
    nomeArq := MontarNome(codigo, compIni, compFim)
    Logar("    nav: digitando nome '" . nomeArq . "' | SalvarPDF aberta: " . (WinExist("Salvar em PDF") ? "sim" : "NAO"))
    DigitarTexto(nomeArq)
    Sleep T_CURTO
    Send "{Enter}"
    Sleep T_CURTO
    Send "{Enter}"
    Sleep T_GERAR_PDF
    FecharPrevia()
    Logar("Empresa " . codigo . ": fluxo concluido")
    return "ok"
}

ProcessarEmpresaVerificado(codigo, compIni, compFim) {
    global PASTA_LOCAL, MAX_TENTATIVAS, T_MEDIO
    caminho := PASTA_LOCAL . "\" . MontarNome(codigo, compIni, compFim)
    Loop MAX_TENTATIVAS {
        try FileDelete(caminho)
        st := ProcessarEmpresa(codigo, compIni, compFim)
        if (st = "pular") {
            Logar("Empresa " . codigo . ": pulada (sem dados / tela nao abriu)")
            return "pular"
        }
        inicio := A_TickCount
        while (A_TickCount - inicio < 60000) {
            if (FileExist(caminho)) {
                Logar("Empresa " . codigo . ": PDF confirmado (tentativa " . A_Index . ")")
                return "ok"
            }
            Sleep 2000
        }
        naPasta := ""
        try {
            Loop Files, PASTA_LOCAL . "\*_" . codigo . "_*.pdf"
                naPasta .= A_LoopFileName . "; "
        }
        Logar("Empresa " . codigo . ": PDF NAO apareceu (tentativa " . A_Index . "/" . MAX_TENTATIVAS . ") - esperava '" . MontarNome(codigo, compIni, compFim) . "' - na pasta c/ codigo: " . (naPasta != "" ? naPasta : "(nenhum)"))
        LimparTelas()
        Sleep T_MEDIO
    }
    Logar("Empresa " . codigo . ": FALHOU apos " . MAX_TENTATIVAS . " tentativas")
    return "falhou"
}

; ------------------------------------------------------------- SITE (comandos)
ExtrairStr(body, chave) {
    if RegExMatch(body, '"' . chave . '":"([^"]*)"', &m)
        return m[1]
    return ""
}

ExtrairNum(body, chave) {
    if RegExMatch(body, '"' . chave . '":(\d+)', &m)
        return Integer(m[1])
    return 0
}

AtualizarTempos(body) {
    global T_CURTO, T_MEDIO, T_LONGO, T_GERAR_PDF, T_ENTRE_EMPRESAS, T_RENDER_TIMEOUT, T_MODULO_CARGA
    v := ExtrairNum(body, "tCurtoMs")
    if (v > 0)
        T_CURTO := v
    v := ExtrairNum(body, "tMedioMs")
    if (v > 0)
        T_MEDIO := v
    v := ExtrairNum(body, "tLongoMs")
    if (v > 0)
        T_LONGO := v
    v := ExtrairNum(body, "tGerarPdfMs")
    if (v > 0)
        T_GERAR_PDF := v
    v := ExtrairNum(body, "tEntreEmpresasMs")
    if (v > 0)
        T_ENTRE_EMPRESAS := v
    v := ExtrairNum(body, "tRenderTimeoutMs")
    if (v > 0)
        T_RENDER_TIMEOUT := v
    v := ExtrairNum(body, "tModuloCargaMs")
    if (v > 0)
        T_MODULO_CARGA := v
}

DevePararSite() {
    body := HttpReq("GET", "/api/dominio-agent/demonstrativo-comando")
    return InStr(body, '"parar":true') ? true : false
}

ReportarProgresso(rodando, total, feitas, atual, iniciando) {
    atualJson := atual != "" ? '"' . JsonEscape(atual) . '"' : "null"
    json := '{"rodando":' . (rodando ? "true" : "false") . ',"total":' . total . ',"feitas":' . feitas
          . ',"atual":' . atualJson . ',"iniciando":' . (iniciando ? "true" : "false") . "}"
    HttpReq("POST", "/api/dominio-agent/demonstrativo-progresso", json)
}

PegarEmpresas() {
    body := HttpReq("GET", "/api/dominio-agent/empresas-demonstrativo")
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
    HttpReq("POST", "/api/dominio-agent/demonstrativo-status", '{"itens":[' . s . "]}")
}

RodarCiclo(compIni, compFim) {
    global DOMINIO_WIN, T_ENTRE_EMPRESAS, SELECIONAR_MODULO
    if !DominioAberto() {
        Logar("ERRO: Dominio nao esta aberto - execucao cancelada.")
        ReportarProgresso(true, 0, 0, "", true)
        ReportarProgresso(false, 0, 0, "", false)
        MsgBox("A Dominio nao esta aberta.`n`nAbra o Dominio Web, faca o login e tente de novo.", "Robo do Demonstrativo Mensal", "Icon! T60")
        return
    }
    empresas := PegarEmpresas()
    total := empresas.Length
    Logar("=== EXECUCAO: " . total . " empresa(s), periodo " . compIni . " a " . compFim . " ===")
    ReportarProgresso(true, total, 0, "", true)
    if (total = 0) {
        ReportarProgresso(false, 0, 0, "", false)
        return
    }
    AtivarApp()
    Sleep 1500
    Logar("Janelas: " . ListarJanelasDominio())
    if NoLauncher() {
        Logar("ERRO: Dominio no launcher (Lista de Programas) - app nao esta aberto. Cancelado.")
        ReportarProgresso(false, total, 0, "", false)
        return
    }
    if (SELECIONAR_MODULO) {
        Logar("Selecionando modulo Escrita Fiscal...")
        SelecionarModulo()
    }
    FecharErroSistema()
    resultados := []
    feitas := 0
    for e in empresas {
        if (DevePararSite()) {
            Logar("=== PARADO pelo site (freio de emergencia) apos " . feitas . "/" . total . " ===")
            break
        }
        if (feitas > 0)
            Sleep T_ENTRE_EMPRESAS
        ReportarProgresso(true, total, feitas, e.codigo . " - " . e.nome, false)
        res := "falhou"
        try {
            res := ProcessarEmpresaVerificado(e.codigo, compIni, compFim)
        } catch as err {
            Logar("Empresa " . e.codigo . ": ERRO " . err.Message)
        }
        if (res = "ok")
            resultados.Push({ codigo: e.codigo, ok: true })
        else if (res = "pular")
            resultados.Push({ codigo: e.codigo, ok: false, erro: "Sem dados / tela nao abriu - pulada" })
        else
            resultados.Push({ codigo: e.codigo, ok: false, erro: "PDF nao confirmado apos as tentativas" })
        feitas++
        ReportarProgresso(true, total, feitas, "", false)
    }
    ReportarStatus(resultados)
    ReportarProgresso(false, total, feitas, "", false)
    Logar("=== EXECUCAO concluida (" . feitas . "/" . total . ") ===")
}

; ==================================================================== MAIN
Logar("=== Agente iniciado ===")
SetTimer(FecharErroSistema, 400)
OnExit(AoSair)
AoSair(*) {
    try ReportarProgresso(false, 0, 0, "", false)
}

Loop {
    body := HttpReq("GET", "/api/dominio-agent/demonstrativo-comando")
    AtualizarTempos(body)
    if (InStr(body, '"deveRodar":true')) {
        compIni := ExtrairStr(body, "periodoIni")
        compFim := ExtrairStr(body, "periodoFim")
        if (compIni = "" || compFim = "")
            CalcularPeriodo(&compIni, &compFim)
        RodarCiclo(compIni, compFim)
    }
    Sleep POLL_SEGUNDOS * 1000
}
