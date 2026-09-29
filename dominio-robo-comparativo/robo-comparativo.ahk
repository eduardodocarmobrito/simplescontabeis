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
; Re-selecionar o modulo Contabilidade a cada execucao? false = NAO (o app ja fica na
; Contabilidade; re-selecionar recarrega o modulo e quebrava o F8/Favoritos logo depois).
SELECIONAR_MODULO := true
FAV_KEY      := "f"       ; letra do menu FAVORITOS
DOMINIO_WIN  := "ahk_exe AppController.exe"

; Pasta LOCAL do Google Drive (pra CONFERIR se o PDF salvou e repetir se falhar)
PASTA_LOCAL  := "G:\Meu Drive\Relatorios Dominio"
MAX_TENTATIVAS := 3       ; quantas vezes tenta cada empresa se o PDF nao aparecer

; Coordenadas de TELA da janela "Salvar em PDF" (abre em 0,23)
THISPC_X    := 52,   THISPC_Y    := 265
CAMPO_NOME_X:= 250,  CAMPO_NOME_Y:= 388

; Coordenadas de TELA dos campos de periodo no dialogo "Comparativo de Movimento"
PER_INI_X   := 1090, PER_INI_Y   := 721    ; campo Inicial
PER_FIM_X   := 1333, PER_FIM_Y   := 724    ; campo Final

; SELECAO DE MODULO (garante 100% que esta no modulo certo antes de rodar).
; 1) clica o logo DOMINIO (abre o menu de modulos); 2) clica o item do modulo.
; Pros PROXIMOS robos, so trocar MODULO_X/MODULO_Y pro item do modulo dele (Fiscal, Folha...).
LOGO_X      := 40,   LOGO_Y      := 74     ; logo "DOMINIO" (abre menu de modulos)
MODULO_X    := 75,   MODULO_Y    := 308    ; item "Contabilidade" no menu
T_MODULO_CARGA := 10000                    ; espera o modulo carregar (~10s)

; Menu FAVORITOS (barra de cima) e o item "Comparativo de Movimentos" no submenu.
; >>> AJUSTAR com o Window Spy (Screen X,Y): <<<
FAVORITOS_X := 576,  FAVORITOS_Y := 52     ; menu "Favoritos"
COMPMOV_X   := 620,  COMPMOV_Y   := 90     ; item "Comparativo de Movimentos"

T_CURTO  := 700
T_MEDIO  := 2000
T_LONGO  := 4000
T_GERAR_PDF      := 15000
T_ENTRE_EMPRESAS := 15000
T_RENDER_TIMEOUT := 60000

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

; Lista as janelas do Dominio com titulo/classe/tamanho/ativa (diagnostico).
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

; Ativa a janela do APP do Dominio (a que NAO e o launcher "Lista de Programas").
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

; Launcher (app fechado / sessao caiu) esta na frente?
NoLauncher() {
    return InStr(WinGetTitle("A"), "Lista de Programas") || InStr(WinGetTitle("A"), "Dominio Web")
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

; Abre Favoritos > Comparativo de Movimento (Alt+F -> Down -> Enter), com foco antes.
AbrirComparativo() {
    global FAV_KEY, T_CURTO, T_MEDIO
    Click("700 400")             ; foco de teclado (streaming)
    Sleep 400
    Send "!" . FAV_KEY           ; Alt+F -> abre Favoritos
    Sleep T_MEDIO
    Send "{Down}"
    Sleep T_CURTO
    Send "{Enter}"
    Sleep T_MEDIO
}

PreencherEGerar(compIni, compFim) {
    global DIGITAR_PERIODO, T_CURTO, PER_INI_X, PER_INI_Y, PER_FIM_X, PER_FIM_Y
    if (DIGITAR_PERIODO) {
        ; Clica DIRETO em cada campo (sem Tab, que pulava pra aba Contas) e digita.
        ClicarEDigitarPeriodo(PER_INI_X, PER_INI_Y, compIni)   ; Inicial
        Sleep T_CURTO
        ClicarEDigitarPeriodo(PER_FIM_X, PER_FIM_Y, compFim)   ; Final
        Sleep T_CURTO
    }
    Send "!o"
    return EsperarRender()
}

; Campo mascarado MM/AAAA: clica pra focar, seleciona tudo e digita os 6 digitos devagar.
ClicarEDigitarPeriodo(x, y, mmAAAA) {
    Click(x . " " . y)
    Sleep 400
    Click(x . " " . y)           ; 2o clique garante o foco no campo (streaming)
    Sleep 400
    Send "{Home}"
    Sleep 120
    Send "+{End}"                ; seleciona todo o conteudo
    Sleep 120
    for ch in StrSplit(StrReplace(mmAAAA, "/", "")) {
        SendText ch
        Sleep 160
    }
}

; Retorna: "ok" (relatorio renderizou), "sem_dados" (dialogo "Sem dados para emitir")
; ou "timeout" (nada abriu - ex.: Favoritos nao abriu a tela do Comparativo).
EsperarRender() {
    global T_RENDER_TIMEOUT
    inicio := A_TickCount
    while (A_TickCount - inicio < T_RENDER_TIMEOUT) {
        ; relatorio renderizou? (texto escuro na area do relatorio)
        if (PixelSearch(&px, &py, 130, 150, 1600, 520, 0x000000, 70)) {
            Sleep 1500
            return "ok"
        }
        ; dialogo "Sem dados para emitir" (modal cinza claro no centro, area do relatorio em branco)?
        if (PixelSearch(&dx, &dy, 1150, 720, 1420, 880, 0xF0F0F0, 12)) {
            Sleep 400
            return "sem_dados"
        }
        Sleep 800
    }
    return "timeout"
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

; Garante o modulo Contabilidade. Se JA estiver nele, NAO mexe (o clique no logo/item
; as vezes derruba pro launcher). So seleciona se estiver noutro modulo/launcher.
SelecionarModulo() {
    global LOGO_X, LOGO_Y, MODULO_X, MODULO_Y, T_MODULO_CARGA, T_MEDIO
    FecharErroSistema()
    Click(LOGO_X . " " . LOGO_Y)      ; logo DOMINIO -> abre o menu de modulos
    Sleep T_MEDIO
    Click(MODULO_X . " " . MODULO_Y)  ; clica no modulo (Contabilidade)
    Sleep T_MODULO_CARGA              ; espera carregar (~10s)
    FecharErroSistema()
}

ProcessarEmpresa(codigo, compIni, compFim) {
    global T_CURTO, T_MEDIO, T_LONGO, T_GERAR_PDF, CAMPO_NOME_X, CAMPO_NOME_Y
    Logar("Empresa " . codigo . ": iniciando")
    FecharErroSistema()
    Sleep 500
    LimparTelas()
    Click("700 400")                 ; clica no app (canvas vazio) pra dar FOCO DE TECLADO (streaming)
    Sleep 500
    Logar("  [1] apos LimparTelas+foco: " . ListarJanelasDominio())
    TrocarEmpresa(codigo)
    Logar("  [2] apos F8/troca empresa: " . ListarJanelasDominio())
    AbrirComparativo()
    Logar("  [3] apos Favoritos/Comparativo: " . ListarJanelasDominio())
    st := PreencherEGerar(compIni, compFim)
    Logar("  [4] apos gerar: " . st)
    if (st != "ok") {
        ; "Sem dados para emitir" OU Favoritos nao abriu a tela do Comparativo.
        ; Sequencia: OK -> 5s -> Esc (fecha a tela) -> 5s -> confirma "Deseja cancelar?" (Yes) -> proxima.
        Logar("Empresa " . codigo . ": sem relatorio (" . st . ") - OK/Esc e proxima")
        Send "{Enter}"                ; OK no "Sem dados para emitir!"
        Sleep 5000                    ; espera 5s
        Send "{Esc}"                  ; fecha a tela do Comparativo (abre "Deseja cancelar?")
        Sleep 5000                    ; espera mais 5s
        Send "{Enter}"                ; Yes no "Deseja cancelar?" (botao em foco) -> volta pra tela principal
        Sleep 2000
        LimparTelas()                 ; garante tela limpa antes da proxima empresa
        return "pular"
    }
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
    Logar("Empresa " . codigo . ": fluxo concluido")
    return "ok"
}

; Roda a empresa e CONFIRMA que o PDF apareceu no Google Drive local. Se nao aparecer
; (navegacao/periodo/nome falhou por causa do streaming), reseta e REPETE ate MAX_TENTATIVAS.
ProcessarEmpresaVerificado(codigo, compIni, compFim) {
    global PASTA_LOCAL, MAX_TENTATIVAS, T_MEDIO
    caminho := PASTA_LOCAL . "\" . MontarNome(codigo, compIni, compFim)
    Loop MAX_TENTATIVAS {
        try FileDelete(caminho)          ; remove a versao anterior (vamos regerar)
        st := ProcessarEmpresa(codigo, compIni, compFim)
        if (st = "pular") {              ; sem dados / tela nao abriu -> NAO repete, segue pra proxima
            Logar("Empresa " . codigo . ": pulada (sem dados / tela nao abriu)")
            return "pular"
        }
        inicio := A_TickCount
        while (A_TickCount - inicio < 60000) {   ; espera o PDF aparecer no Drive (ate 60s)
            if (FileExist(caminho)) {
                Logar("Empresa " . codigo . ": PDF confirmado (tentativa " . A_Index . ")")
                return "ok"
            }
            Sleep 2000
        }
        Logar("Empresa " . codigo . ": PDF NAO apareceu (tentativa " . A_Index . "/" . MAX_TENTATIVAS . ") - resetando e repetindo")
        LimparTelas()
        Sleep T_MEDIO
    }
    Logar("Empresa " . codigo . ": FALHOU apos " . MAX_TENTATIVAS . " tentativas")
    return "falhou"
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
    global DOMINIO_WIN, T_ENTRE_EMPRESAS, SELECIONAR_MODULO
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
    AtivarApp()                      ; traz o APP pra frente (nao o launcher)
    Sleep 1500
    Logar("Janelas: " . ListarJanelasDominio())
    ; TRAVA: se o launcher (app fechado/sessao caiu) estiver na frente, cancela.
    if NoLauncher() {
        Logar("ERRO: Dominio no launcher (Lista de Programas) - app nao esta aberto. Cancelado.")
        ReportarProgresso(false, total, 0, "", false)
        return
    }
    if (SELECIONAR_MODULO) {
        Logar("Selecionando modulo Contabilidade...")
        SelecionarModulo()
    }
    FecharErroSistema()
    resultados := []
    feitas := 0
    for e in empresas {
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
