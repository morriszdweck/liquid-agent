//! What the models are told, and the words the server makes that the user reads.
//!
//! Every language is one `Strings` value. The compiler makes sure none of them is
//! missing a field, so a new language can't ship half-translated. Tool names and
//! parameters stay in English: they are the protocol the models answer in.

use serde_json::Value;

/// One language's prompts and the labels the server shows.
pub struct Strings {
    /// The language's own name for itself, used in "Reply in …".
    pub name: &'static str,
    pub persona: &'static str,
    pub markdown: &'static str,
    /// Personality key ("friendly", "concise", "playful", "professional") and its instruction.
    pub personalities: &'static [(&'static str, &'static str)],
    pub reply_same: &'static str,
    /// Contains {language}.
    pub reply_in: &'static str,
    pub direct: &'static str,
    pub attachments: &'static str,
    /// Contains {name}.
    pub user_name: &'static str,
    /// Contains {facts}.
    pub user_facts: &'static str,
    pub tools_intro: &'static str,
    pub tools_list: &'static str,
    pub tools_after: &'static str,
    pub media_tools: &'static str,
    pub browser_tools: &'static str,
    /// Voice assistant instructions. Contains {style} and {name}.
    pub voice: &'static str,
    pub voice_earlier: &'static str,
    /// Action labels by tool name. {v} is the main argument (a path, a command, a URL…).
    pub labels: &'static [(&'static str, &'static str)],
    pub decided_auto: &'static str,
    pub decided_you: &'static str,
    pub decided_no: &'static str,
    /// Contains {risk}.
    pub guardian_unsure: &'static str,
    pub guardian_unready: &'static str,
    /// Starter routines by id: name and prompt. Ids: morning, tidy, news, check_mac, check_computer.
    pub starters: &'static [(&'static str, &'static str, &'static str)],
    pub no_reply: &'static str,
    pub tools_unavailable: &'static str,
    /// Told to the model when the user refuses an action.
    pub declined: &'static str,
    pub decided_free: &'static str,
    pub decided_full: &'static str,
    pub decided_safe: &'static str,
    pub settings_changed: &'static str,
    /// Contains {n}.
    pub step_limit: &'static str,
    /// Who said each line, in the transcript the voice model reads.
    pub speaker_user: &'static str,
    pub speaker_you: &'static str,
    /// "For You": the instructions for writing the idea cards. Contains {device}.
    pub ideas_system: &'static str,
    /// Contains {facts}.
    pub ideas_known: &'static str,
    pub ideas_need_brain: &'static str,
    /// What the computer is called in sentences: "Mac" is the same everywhere.
    pub device_computer: &'static str,
    /// Whether the everyday model's "For You" cards are good enough in this language; if not, the starter cards are shown.
    pub ideas_model_ok: bool,
    /// Four fixed cards (title, request) for a language where the model's cards are not good enough.
    pub ideas_starter: &'static [(&'static str, &'static str)],
}

/// The languages the app is written in, in the order the settings list them.
pub const CODES: [&str; 8] = ["en", "es", "pt", "fr", "de", "it", "zh", "ja"];

pub fn supported(code: &str) -> bool {
    CODES.contains(&code)
}

/// The prompts and labels for a language code; anything unknown gets English.
pub fn table(code: &str) -> &'static Strings {
    match code {
        "es" => &ES,
        "pt" => &PT,
        "fr" => &FR,
        "de" => &DE,
        "it" => &IT,
        "zh" => &ZH,
        "ja" => &JA,
        _ => &EN,
    }
}

/// Which language to speak. "auto" follows the user's writing, and the interface language sets the words.
pub struct Reply {
    pub strings: &'static Strings,
    pub follows_user: bool,
}

pub fn reply_for(settings: &Value) -> Reply {
    let chosen = settings["language"].as_str().unwrap_or("auto");
    if supported(chosen) && chosen != "auto" {
        return Reply {
            strings: table(chosen),
            follows_user: false,
        };
    }
    let interface = settings["uiLanguage"]
        .as_str()
        .filter(|c| supported(c))
        .unwrap_or("en");
    Reply {
        strings: table(interface),
        follows_user: true,
    }
}

impl Reply {
    /// The sentence that tells the model which language to answer in.
    pub fn directive(&self) -> String {
        if self.follows_user {
            self.strings.reply_same.to_owned()
        } else {
            self.strings
                .reply_in
                .replace("{language}", self.strings.name)
        }
    }

    pub fn personality(&self, key: &str) -> &'static str {
        self.strings
            .personalities
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, text)| *text)
            .unwrap_or("")
    }
}

/// The argument a tool's label shows.
fn principal(tool: &str) -> &'static str {
    match tool {
        "shell" => "command",
        "read_file" | "write_file" | "list_dir" | "look_at_image" | "transcribe_audio" => "path",
        "remember" => "fact",
        "recall" | "web_search" => "query",
        "open" | "browser_click" | "browser_type" => "target",
        "reminder" => "text",
        "fetch_url" | "browser_goto" => "url",
        _ => "",
    }
}

/// The label for a tool call, in the given language.
pub fn label(strings: &Strings, tool: &str, args: &Value) -> String {
    let find = |list: &'static [(&'static str, &'static str)], name: &str| {
        list.iter()
            .find(|(key, _)| *key == name)
            .map(|(_, text)| *text)
    };
    let template = find(strings.labels, tool)
        .or_else(|| find(EN.labels, tool))
        .or_else(|| find(strings.labels, "unknown"))
        .unwrap_or("Unknown action");
    let value: String = args[principal(tool)]
        .as_str()
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(80)
        .collect();
    template.replace("{v}", &value)
}

static EN: Strings = Strings {
    name: "English",
    persona: "You are Liquid Agent, a private assistant running locally.",
    markdown: "Use Markdown when it helps.",
    personalities: &[
        ("friendly", "Be warm, clear and patient. Explain simply."),
        ("concise", "Be extremely brief. No filler."),
        ("playful", "Be witty and fun, but still helpful."),
        ("professional", "Be precise and professional."),
    ],
    reply_same: "Reply in the same language as the user.",
    reply_in: "Reply in {language}.",
    direct: " Answer directly. Tools are not available for this request; never claim to have executed an action.",
    attachments: " You can see and hear attachments.",
    user_name: " The user's name is {name}.",
    user_facts: "User facts: {facts}",
    tools_intro: "When the request needs files, the computer, or memory, reply with one tool call only:",
    tools_list: "Tools:",
    tools_after: "After a result, answer as soon as you know enough; use another tool only if needed.",
    media_tools: "Media tools:",
    browser_tools: "Browser tools:",
    voice: "You are Liquid Agent, a private local voice assistant. {style}{name} Answer in one or two short natural spoken sentences. Use tools for actions and current information. Camera notes describe the user's surroundings.",
    voice_earlier: "Earlier in this chat:",
    labels: &[
        ("shell", "Run `{v}`"),
        ("read_file", "Read {v}"),
        ("write_file", "Write {v}"),
        ("list_dir", "List {v}"),
        ("remember", "Remember “{v}”"),
        ("recall", "Recall “{v}”"),
        ("open", "Open {v}"),
        ("clipboard", "Read the clipboard"),
        ("look_at_image", "Look at {v}"),
        ("look_at_screen", "Look at the screen"),
        ("transcribe_audio", "Listen to {v}"),
        ("set_clipboard", "Copy to the clipboard"),
        ("reminder", "Set a reminder: {v}"),
        ("web_search", "Search the web for “{v}”"),
        ("fetch_url", "Read {v}"),
        ("browser_goto", "Open {v} in the browser"),
        ("browser_read", "Read the browser page"),
        ("browser_click", "Click “{v}”"),
        ("browser_type", "Type into “{v}”"),
        ("unknown", "Unknown action"),
    ],
    decided_auto: "Auto 150M approved",
    decided_you: "You approved",
    decided_no: "You said no",
    guardian_unsure: "Auto 150M wasn't sure this is safe ({risk}% risky).",
    guardian_unready: "Auto 150M isn't ready yet, so I need your OK.",
    starters: &[
        ("morning", "Morning briefing", "Give me a short morning briefing: today's date, the weather where I live if you know it, and three top news headlines. Search the web for the news."),
        ("tidy", "Tidy Downloads", "Look at my ~/Downloads folder and suggest how to tidy it: group the files by type and point out old installers and duplicates. Don't move or delete anything yet."),
        ("news", "Today's news", "Search the web for today's most important news and summarize the five biggest stories in one or two sentences each."),
        ("check_mac", "Check my Mac", "Check my Mac's health: free disk space, memory pressure, battery condition and uptime. Use shell commands, then explain the results simply."),
        ("check_computer", "Check my computer", "Check my computer's health: free disk space, memory use, battery condition if it has one, uptime and failed system services. Use shell commands, then explain the results simply."),
    ],
    no_reply: "I couldn't come up with a reply. Try asking another way.",
    tools_unavailable: "Tool actions are not available for this request.",
    declined: "The user said no to this action. Don't retry it; tell the user.",
    decided_free: "Automatic",
    decided_full: "Full Auto",
    decided_safe: "Read-only, safe",
    settings_changed: "The approval settings changed, so I need your OK.",
    step_limit: "I stopped after {n} steps. Say **continue** if you want me to keep going.",
    speaker_user: "User",
    speaker_you: "You",
    ideas_system: "You suggest things a personal AI agent on a {device} could do for this user right now. It can chat, search the web, use files and apps, set reminders, browse websites and see the screen. Write exactly 4 lines. Each line is a short title, a vertical bar |, then the full request the user would type. Example line: Tidy Downloads | Sort the files in my Downloads folder into folders by type. No numbering, nothing else, all in English.",
    ideas_known: "What I know about the user: {facts}",
    ideas_need_brain: "Ideas need the Everyday brain. Set it up in Settings → Downloads.",
    device_computer: "Linux computer",
    ideas_model_ok: true,
    ideas_starter: &[
        ("Tidy Downloads", "Sort the files in my Downloads folder into folders by type."),
        ("Set a reminder", "Remind me to take a break in one hour."),
        ("Search the web", "Find the latest news about a topic I name."),
        ("Summarize a page", "Open a website and summarize what it says."),
    ],
};

static ES: Strings = Strings {
    name: "Español",
    persona: "Eres Liquid Agent, un asistente privado que funciona en local.",
    markdown: "Usa Markdown cuando ayude.",
    personalities: &[
        ("friendly", "Sé cálido, claro y paciente. Explica con sencillez."),
        ("concise", "Sé muy breve. Sin relleno."),
        ("playful", "Sé ingenioso y divertido, pero sigue siendo útil."),
        ("professional", "Sé preciso y profesional."),
    ],
    reply_same: "Responde en el mismo idioma que el usuario.",
    reply_in: "Responde en {language}.",
    direct: " Responde directamente. Las herramientas no están disponibles para esta petición; nunca digas que has ejecutado una acción.",
    attachments: " Puedes ver y escuchar los archivos adjuntos.",
    user_name: " El nombre del usuario es {name}.",
    user_facts: "Datos del usuario: {facts}",
    tools_intro: "Cuando la petición necesite archivos, el equipo o la memoria, responde con una sola llamada a herramienta:",
    tools_list: "Herramientas:",
    tools_after: "Después de un resultado, responde en cuanto tengas suficiente información; usa otra herramienta solo si hace falta.",
    media_tools: "Herramientas de medios:",
    browser_tools: "Herramientas del navegador:",
    voice: "Eres Liquid Agent, un asistente de voz privado que funciona en local. {style}{name} Responde en una o dos frases cortas y naturales. Usa herramientas para acciones e información actual. Las notas de la cámara describen el entorno del usuario.",
    voice_earlier: "Antes en este chat:",
    labels: &[
        ("shell", "Ejecutar `{v}`"),
        ("read_file", "Leer {v}"),
        ("write_file", "Escribir {v}"),
        ("list_dir", "Listar {v}"),
        ("remember", "Recordar “{v}”"),
        ("recall", "Buscar en la memoria “{v}”"),
        ("open", "Abrir {v}"),
        ("clipboard", "Leer el portapapeles"),
        ("look_at_image", "Mirar {v}"),
        ("look_at_screen", "Mirar la pantalla"),
        ("transcribe_audio", "Escuchar {v}"),
        ("set_clipboard", "Copiar al portapapeles"),
        ("reminder", "Crear un recordatorio: {v}"),
        ("web_search", "Buscar en la web “{v}”"),
        ("fetch_url", "Leer {v}"),
        ("browser_goto", "Abrir {v} en el navegador"),
        ("browser_read", "Leer la página del navegador"),
        ("browser_click", "Hacer clic en “{v}”"),
        ("browser_type", "Escribir en “{v}”"),
        ("unknown", "Acción desconocida"),
    ],
    decided_auto: "Aprobado por Auto 150M",
    decided_you: "Aprobado por ti",
    decided_no: "Dijiste que no",
    guardian_unsure: "Auto 150M no está seguro de que sea seguro ({risk} % de riesgo).",
    guardian_unready: "Auto 150M aún no está listo, así que necesito tu permiso.",
    starters: &[
        ("morning", "Resumen de la mañana", "Dame un breve resumen de la mañana: la fecha de hoy, el tiempo donde vivo si lo sabes y tres titulares de noticias. Busca las noticias en la web."),
        ("tidy", "Ordenar Descargas", "Mira mi carpeta ~/Downloads y sugiere cómo ordenarla: agrupa los archivos por tipo y señala los instaladores antiguos y los duplicados. No muevas ni borres nada todavía."),
        ("news", "Noticias de hoy", "Busca en la web las noticias más importantes de hoy y resume las cinco más importantes en una o dos frases cada una."),
        ("check_mac", "Revisar mi Mac", "Revisa el estado de mi Mac: espacio libre en disco, presión de memoria, estado de la batería y tiempo de actividad. Usa comandos de shell y luego explica los resultados de forma sencilla."),
        ("check_computer", "Revisar mi equipo", "Revisa el estado de mi equipo: espacio libre en disco, uso de memoria, estado de la batería si tiene una, tiempo de actividad y servicios del sistema fallidos. Usa comandos de shell y luego explica los resultados de forma sencilla."),
    ],
    no_reply: "No se me ocurrió una respuesta. Prueba a preguntarlo de otra forma.",
    tools_unavailable: "Las acciones con herramientas no están disponibles para esta petición.",
    declined: "El usuario dijo que no a esta acción. No la repitas; díselo al usuario.",
    decided_free: "Automático",
    decided_full: "Automático total",
    decided_safe: "Solo lectura, seguro",
    settings_changed: "Los ajustes de aprobación han cambiado, así que necesito tu permiso.",
    step_limit: "Me detuve después de {n} pasos. Di **continúa** si quieres que siga.",
    speaker_user: "Usuario",
    speaker_you: "Tú",
    ideas_system: "Sugieres cosas que un agente de IA personal en un {device} podría hacer por este usuario ahora mismo. Puede charlar, buscar en la web, usar archivos y aplicaciones, poner recordatorios, navegar por sitios web y ver la pantalla. Escribe exactamente 4 líneas. Cada línea es un título corto, una barra vertical |, y la petición completa que escribiría el usuario. Ejemplo de línea: Ordenar Descargas | Ordena los archivos de mi carpeta Descargas en carpetas por tipo. Sin numeración ni nada más, todo en español.",
    ideas_known: "Lo que sé del usuario: {facts}",
    ideas_need_brain: "Las ideas necesitan el cerebro cotidiano. Configúralo en Ajustes → Descargas.",
    device_computer: "ordenador Linux",
    ideas_model_ok: true,
    ideas_starter: &[
        ("Ordenar Descargas", "Ordena los archivos de mi carpeta Descargas en carpetas por tipo."),
        ("Crear un recordatorio", "Recuérdame tomar un descanso dentro de una hora."),
        ("Buscar en la web", "Busca las noticias más recientes sobre un tema que te diga."),
        ("Resumir una página", "Abre un sitio web y resume lo que dice."),
    ],
};

static PT: Strings = Strings {
    name: "Português",
    persona: "Você é o Liquid Agent, um assistente privado que roda localmente.",
    markdown: "Use Markdown quando ajudar.",
    personalities: &[
        ("friendly", "Seja acolhedor, claro e paciente. Explique de forma simples."),
        ("concise", "Seja extremamente breve. Sem enrolação."),
        ("playful", "Seja espirituoso e divertido, mas continue útil."),
        ("professional", "Seja preciso e profissional."),
    ],
    reply_same: "Responda no mesmo idioma que o usuário.",
    reply_in: "Responda em {language}.",
    direct: " Responda diretamente. As ferramentas não estão disponíveis para este pedido; nunca diga que executou uma ação.",
    attachments: " Você pode ver e ouvir os anexos.",
    user_name: " O nome do usuário é {name}.",
    user_facts: "Fatos sobre o usuário: {facts}",
    tools_intro: "Quando o pedido precisar de arquivos, do computador ou da memória, responda com uma única chamada de ferramenta:",
    tools_list: "Ferramentas:",
    tools_after: "Depois de um resultado, responda assim que tiver informação suficiente; use outra ferramenta só se for preciso.",
    media_tools: "Ferramentas de mídia:",
    browser_tools: "Ferramentas do navegador:",
    voice: "Você é o Liquid Agent, um assistente de voz privado que roda localmente. {style}{name} Responda em uma ou duas frases curtas e naturais. Use ferramentas para ações e informações atuais. As notas da câmera descrevem o ambiente do usuário.",
    voice_earlier: "Antes nesta conversa:",
    labels: &[
        ("shell", "Executar `{v}`"),
        ("read_file", "Ler {v}"),
        ("write_file", "Escrever {v}"),
        ("list_dir", "Listar {v}"),
        ("remember", "Lembrar “{v}”"),
        ("recall", "Buscar na memória “{v}”"),
        ("open", "Abrir {v}"),
        ("clipboard", "Ler a área de transferência"),
        ("look_at_image", "Ver {v}"),
        ("look_at_screen", "Ver a tela"),
        ("transcribe_audio", "Ouvir {v}"),
        ("set_clipboard", "Copiar para a área de transferência"),
        ("reminder", "Criar um lembrete: {v}"),
        ("web_search", "Pesquisar na web “{v}”"),
        ("fetch_url", "Ler {v}"),
        ("browser_goto", "Abrir {v} no navegador"),
        ("browser_read", "Ler a página do navegador"),
        ("browser_click", "Clicar em “{v}”"),
        ("browser_type", "Digitar em “{v}”"),
        ("unknown", "Ação desconhecida"),
    ],
    decided_auto: "Aprovado pelo Auto 150M",
    decided_you: "Aprovado por você",
    decided_no: "Você recusou",
    guardian_unsure: "O Auto 150M não tem certeza de que isto é seguro ({risk}% de risco).",
    guardian_unready: "O Auto 150M ainda não está pronto, então preciso da sua permissão.",
    starters: &[
        ("morning", "Resumo da manhã", "Me dê um resumo curto da manhã: a data de hoje, o tempo onde eu moro se você souber e três principais manchetes. Pesquise as notícias na web."),
        ("tidy", "Organizar Downloads", "Olhe minha pasta ~/Downloads e sugira como organizá-la: agrupe os arquivos por tipo e aponte instaladores antigos e duplicados. Não mova nem apague nada ainda."),
        ("news", "Notícias de hoje", "Pesquise na web as notícias mais importantes de hoje e resuma as cinco principais em uma ou duas frases cada."),
        ("check_mac", "Verificar meu Mac", "Verifique a saúde do meu Mac: espaço livre em disco, pressão de memória, condição da bateria e tempo de atividade. Use comandos de shell e depois explique os resultados de forma simples."),
        ("check_computer", "Verificar meu computador", "Verifique a saúde do meu computador: espaço livre em disco, uso de memória, condição da bateria, se houver, tempo de atividade e serviços do sistema com falha. Use comandos de shell e depois explique os resultados de forma simples."),
    ],
    no_reply: "Não consegui formular uma resposta. Tente perguntar de outra forma.",
    tools_unavailable: "Ações com ferramentas não estão disponíveis para este pedido.",
    declined: "O usuário recusou esta ação. Não tente de novo; informe o usuário.",
    decided_free: "Automático",
    decided_full: "Automático total",
    decided_safe: "Somente leitura, seguro",
    settings_changed: "As configurações de aprovação mudaram, então preciso da sua permissão.",
    step_limit: "Parei após {n} passos. Diga **continue** se quiser que eu siga.",
    speaker_user: "Usuário",
    speaker_you: "Você",
    ideas_system: "Você sugere coisas que um agente de IA pessoal num {device} poderia fazer por este usuário agora. Ele pode conversar, pesquisar na web, usar arquivos e aplicativos, criar lembretes, navegar em sites e ver a tela. Escreva exatamente 4 linhas. Cada linha é um título curto, uma barra vertical |, e o pedido completo que o usuário digitaria. Exemplo de linha: Organizar Downloads | Organize os arquivos da minha pasta Downloads em pastas por tipo. Sem numeração e nada mais, tudo em português.",
    ideas_known: "O que sei sobre o usuário: {facts}",
    ideas_need_brain: "As ideias precisam do cérebro do dia a dia. Configure em Configurações → Downloads.",
    device_computer: "computador Linux",
    ideas_model_ok: true,
    ideas_starter: &[
        ("Organizar Downloads", "Organize os arquivos da minha pasta Downloads em pastas por tipo."),
        ("Criar um lembrete", "Me lembre de fazer uma pausa daqui a uma hora."),
        ("Pesquisar na web", "Pesquise as notícias mais recentes sobre um assunto que eu disser."),
        ("Resumir uma página", "Abra um site e resuma o que ele diz."),
    ],
};

static FR: Strings = Strings {
    name: "Français",
    persona: "Tu es Liquid Agent, un assistant privé qui fonctionne en local.",
    markdown: "Utilise Markdown quand c'est utile.",
    personalities: &[
        ("friendly", "Sois chaleureux, clair et patient. Explique simplement."),
        ("concise", "Sois extrêmement bref. Pas de remplissage."),
        ("playful", "Sois plein d'esprit et amusant, mais reste utile."),
        ("professional", "Sois précis et professionnel."),
    ],
    reply_same: "Réponds dans la même langue que l'utilisateur.",
    reply_in: "Réponds en {language}.",
    direct: " Réponds directement. Les outils ne sont pas disponibles pour cette demande ; ne prétends jamais avoir exécuté une action.",
    attachments: " Tu peux voir et entendre les pièces jointes.",
    user_name: " Le nom de l'utilisateur est {name}.",
    user_facts: "Faits sur l'utilisateur : {facts}",
    tools_intro: "Quand la demande concerne des fichiers, l'ordinateur ou la mémoire, réponds avec un seul appel d'outil :",
    tools_list: "Outils :",
    tools_after: "Après un résultat, réponds dès que tu as assez d'informations ; n'utilise un autre outil que si c'est nécessaire.",
    media_tools: "Outils média :",
    browser_tools: "Outils du navigateur :",
    voice: "Tu es Liquid Agent, un assistant vocal privé qui fonctionne en local. {style}{name} Réponds en une ou deux phrases courtes et naturelles. Utilise les outils pour les actions et les informations actuelles. Les notes de la caméra décrivent l'environnement de l'utilisateur.",
    voice_earlier: "Plus tôt dans cette discussion :",
    labels: &[
        ("shell", "Exécuter `{v}`"),
        ("read_file", "Lire {v}"),
        ("write_file", "Écrire {v}"),
        ("list_dir", "Lister {v}"),
        ("remember", "Retenir « {v} »"),
        ("recall", "Rechercher « {v} » en mémoire"),
        ("open", "Ouvrir {v}"),
        ("clipboard", "Lire le presse-papiers"),
        ("look_at_image", "Regarder {v}"),
        ("look_at_screen", "Regarder l'écran"),
        ("transcribe_audio", "Écouter {v}"),
        ("set_clipboard", "Copier dans le presse-papiers"),
        ("reminder", "Créer un rappel : {v}"),
        ("web_search", "Rechercher sur le web « {v} »"),
        ("fetch_url", "Lire {v}"),
        ("browser_goto", "Ouvrir {v} dans le navigateur"),
        ("browser_read", "Lire la page du navigateur"),
        ("browser_click", "Cliquer sur « {v} »"),
        ("browser_type", "Saisir dans « {v} »"),
        ("unknown", "Action inconnue"),
    ],
    decided_auto: "Approuvé par Auto 150M",
    decided_you: "Approuvé par vous",
    decided_no: "Vous avez refusé",
    guardian_unsure: "Auto 150M n'est pas sûr que ce soit sans danger ({risk} % de risque).",
    guardian_unready: "Auto 150M n'est pas encore prêt, j'ai donc besoin de votre accord.",
    starters: &[
        ("morning", "Point du matin", "Fais-moi un court point du matin : la date d'aujourd'hui, la météo là où je vis si tu la connais, et trois gros titres. Cherche les actualités sur le web."),
        ("tidy", "Ranger les Téléchargements", "Regarde mon dossier ~/Downloads et propose comment le ranger : regroupe les fichiers par type et signale les anciens installeurs et les doublons. Ne déplace ni ne supprime rien pour l'instant."),
        ("news", "Actualités du jour", "Cherche sur le web les actualités les plus importantes d'aujourd'hui et résume les cinq plus grandes en une ou deux phrases chacune."),
        ("check_mac", "Vérifier mon Mac", "Vérifie l'état de mon Mac : espace disque libre, pression mémoire, état de la batterie et durée de fonctionnement. Utilise des commandes shell, puis explique simplement les résultats."),
        ("check_computer", "Vérifier mon ordinateur", "Vérifie l'état de mon ordinateur : espace disque libre, utilisation de la mémoire, état de la batterie s'il en a une, durée de fonctionnement et services système en échec. Utilise des commandes shell, puis explique simplement les résultats."),
    ],
    no_reply: "Je n'ai pas pu formuler de réponse. Essaie de poser la question autrement.",
    tools_unavailable: "Les actions avec outils ne sont pas disponibles pour cette demande.",
    declined: "L'utilisateur a refusé cette action. Ne la relance pas ; informe l'utilisateur.",
    decided_free: "Automatique",
    decided_full: "Automatique",
    decided_safe: "Lecture seule, sûr",
    settings_changed: "Les réglages d'autorisation ont changé, j'ai donc besoin de votre accord.",
    step_limit: "Je me suis arrêté après {n} étapes. Dites « continue » si vous voulez que je poursuive.",
    speaker_user: "Utilisateur",
    speaker_you: "Vous",
    ideas_system: "Tu proposes des choses qu'un agent IA personnel sur un {device} pourrait faire pour cet utilisateur maintenant. Il peut discuter, chercher sur le web, utiliser des fichiers et des applications, programmer des rappels, naviguer sur des sites et voir l'écran. Écris exactement 4 lignes. Chaque ligne est un titre court, une barre verticale |, puis la demande complète que l'utilisateur taperait. Exemple de ligne : Ranger les Téléchargements | Trie les fichiers de mon dossier Téléchargements par type dans des dossiers. Sans numérotation, rien d'autre, tout en français.",
    ideas_known: "Ce que je sais de l'utilisateur : {facts}",
    ideas_need_brain: "Les idées demandent le cerveau du quotidien. Configurez-le dans Réglages → Téléchargements.",
    device_computer: "ordinateur Linux",
    ideas_model_ok: true,
    ideas_starter: &[
        ("Ranger les Téléchargements", "Trie les fichiers de mon dossier Téléchargements par type."),
        ("Créer un rappel", "Rappelle-moi de faire une pause dans une heure."),
        ("Chercher sur le web", "Cherche les dernières nouvelles sur un sujet que je te donne."),
        ("Résumer une page", "Ouvre un site web et résume ce qu'il dit."),
    ],
};

static DE: Strings = Strings {
    name: "Deutsch",
    persona: "Du bist Liquid Agent, ein privater Assistent, der lokal läuft.",
    markdown: "Verwende Markdown, wenn es hilft.",
    personalities: &[
        ("friendly", "Sei herzlich, klar und geduldig. Erkläre einfach."),
        ("concise", "Sei äußerst knapp. Keine Füllwörter."),
        ("playful", "Sei witzig und unterhaltsam, aber bleibe hilfreich."),
        ("professional", "Sei präzise und professionell."),
    ],
    reply_same: "Antworte in derselben Sprache wie der Nutzer.",
    reply_in: "Antworte auf {language}.",
    direct: " Antworte direkt. Für diese Anfrage stehen keine Werkzeuge zur Verfügung; behaupte niemals, eine Aktion ausgeführt zu haben.",
    attachments: " Du kannst Anhänge sehen und hören.",
    user_name: " Der Name des Nutzers ist {name}.",
    user_facts: "Fakten über den Nutzer: {facts}",
    tools_intro: "Wenn die Anfrage Dateien, den Computer oder das Gedächtnis betrifft, antworte mit genau einem Werkzeugaufruf:",
    tools_list: "Werkzeuge:",
    tools_after: "Antworte, sobald du genug weißt, nachdem ein Ergebnis vorliegt; verwende ein anderes Werkzeug nur, wenn nötig.",
    media_tools: "Medien-Werkzeuge:",
    browser_tools: "Browser-Werkzeuge:",
    voice: "Du bist Liquid Agent, ein privater Sprachassistent, der lokal läuft. {style}{name} Antworte in ein oder zwei kurzen, natürlichen Sätzen. Verwende Werkzeuge für Aktionen und aktuelle Informationen. Kamerahinweise beschreiben die Umgebung des Nutzers.",
    voice_earlier: "Früher in diesem Chat:",
    labels: &[
        ("shell", "`{v}` ausführen"),
        ("read_file", "{v} lesen"),
        ("write_file", "{v} schreiben"),
        ("list_dir", "{v} auflisten"),
        ("remember", "Merken: „{v}“"),
        ("recall", "Erinnern: „{v}“"),
        ("open", "{v} öffnen"),
        ("clipboard", "Zwischenablage lesen"),
        ("look_at_image", "{v} ansehen"),
        ("look_at_screen", "Bildschirm ansehen"),
        ("transcribe_audio", "{v} anhören"),
        ("set_clipboard", "In die Zwischenablage kopieren"),
        ("reminder", "Erinnerung setzen: {v}"),
        ("web_search", "Im Web suchen nach „{v}“"),
        ("fetch_url", "{v} lesen"),
        ("browser_goto", "{v} im Browser öffnen"),
        ("browser_read", "Browserseite lesen"),
        ("browser_click", "„{v}“ anklicken"),
        ("browser_type", "In „{v}“ eingeben"),
        ("unknown", "Unbekannte Aktion"),
    ],
    decided_auto: "Von Auto 150M genehmigt",
    decided_you: "Von dir genehmigt",
    decided_no: "Du hast abgelehnt",
    guardian_unsure: "Auto 150M ist sich nicht sicher, dass das unbedenklich ist ({risk} % Risiko).",
    guardian_unready: "Auto 150M ist noch nicht bereit, deshalb brauche ich deine Zustimmung.",
    starters: &[
        ("morning", "Morgenüberblick", "Gib mir einen kurzen Morgenüberblick: das heutige Datum, das Wetter, wo ich wohne, falls du es weißt, und drei wichtige Schlagzeilen. Suche die Nachrichten im Web."),
        ("tidy", "Downloads aufräumen", "Schau dir meinen Ordner ~/Downloads an und schlage vor, wie man ihn aufräumt: gruppiere die Dateien nach Typ und weise auf alte Installer und Duplikate hin. Verschiebe oder lösche vorerst nichts."),
        ("news", "Nachrichten von heute", "Suche im Web nach den wichtigsten Nachrichten von heute und fasse die fünf größten Meldungen mit jeweils ein bis zwei Sätzen zusammen."),
        ("check_mac", "Meinen Mac prüfen", "Prüfe den Zustand meines Macs: freier Speicherplatz, Speicherdruck, Akkuzustand und Betriebszeit. Verwende Shell-Befehle und erkläre die Ergebnisse danach einfach."),
        ("check_computer", "Meinen Computer prüfen", "Prüfe den Zustand meines Computers: freier Speicherplatz, Speichernutzung, Akkuzustand, falls vorhanden, Betriebszeit und fehlgeschlagene Systemdienste. Verwende Shell-Befehle und erkläre die Ergebnisse danach einfach."),
    ],
    no_reply: "Mir ist keine Antwort eingefallen. Versuche, es anders zu fragen.",
    tools_unavailable: "Werkzeug-Aktionen sind für diese Anfrage nicht verfügbar.",
    declined: "Der Nutzer hat diese Aktion abgelehnt. Versuche sie nicht erneut; sag es dem Nutzer.",
    decided_free: "Automatisch",
    decided_full: "Vollautomatisch",
    decided_safe: "Nur lesen, sicher",
    settings_changed: "Die Genehmigungseinstellungen haben sich geändert, deshalb brauche ich deine Zustimmung.",
    step_limit: "Ich habe nach {n} Schritten angehalten. Sag **weiter**, wenn ich fortfahren soll.",
    speaker_user: "Nutzer",
    speaker_you: "Du",
    ideas_system: "Du schlägst Dinge vor, die ein persönlicher KI-Agent auf einem {device} gerade für diesen Nutzer tun könnte. Er kann chatten, im Web suchen, Dateien und Apps nutzen, Erinnerungen setzen, Websites durchsuchen und den Bildschirm sehen. Schreibe genau 4 Zeilen. Jede Zeile ist ein kurzer Titel, ein senkrechter Strich |, dann die vollständige Anfrage, die der Nutzer eintippen würde. Beispielzeile: Downloads aufräumen | Sortiere die Dateien in meinem Downloads-Ordner nach Typ in Ordner. Keine Nummerierung, nichts weiter, alles auf Deutsch.",
    ideas_known: "Was ich über den Nutzer weiß: {facts}",
    ideas_need_brain: "Ideen brauchen das Alltagsgehirn. Richte es unter Einstellungen → Downloads ein.",
    device_computer: "Linux-Computer",
    ideas_model_ok: false,
    ideas_starter: &[
        ("Downloads aufräumen", "Sortiere die Dateien in meinem Downloads-Ordner nach Typ in Ordner."),
        ("Erinnerung setzen", "Erinnere mich in einer Stunde daran, eine Pause zu machen."),
        ("Im Web suchen", "Suche die neuesten Nachrichten zu einem Thema, das ich dir nenne."),
        ("Eine Seite zusammenfassen", "Öffne eine Webseite und fasse zusammen, was sie sagt."),
    ],
};

static IT: Strings = Strings {
    name: "Italiano",
    persona: "Sei Liquid Agent, un assistente privato che funziona in locale.",
    markdown: "Usa Markdown quando aiuta.",
    personalities: &[
        ("friendly", "Sii cordiale, chiaro e paziente. Spiega in modo semplice."),
        ("concise", "Sii estremamente breve. Niente riempitivi."),
        ("playful", "Sii arguto e divertente, ma resta utile."),
        ("professional", "Sii preciso e professionale."),
    ],
    reply_same: "Rispondi nella stessa lingua dell'utente.",
    reply_in: "Rispondi in {language}.",
    direct: " Rispondi direttamente. Gli strumenti non sono disponibili per questa richiesta; non dire mai di aver eseguito un'azione.",
    attachments: " Puoi vedere e ascoltare gli allegati.",
    user_name: " Il nome dell'utente è {name}.",
    user_facts: "Informazioni sull'utente: {facts}",
    tools_intro: "Quando la richiesta riguarda file, il computer o la memoria, rispondi con una sola chiamata a uno strumento:",
    tools_list: "Strumenti:",
    tools_after: "Dopo un risultato, rispondi appena hai abbastanza informazioni; usa un altro strumento solo se serve.",
    media_tools: "Strumenti multimediali:",
    browser_tools: "Strumenti del browser:",
    voice: "Sei Liquid Agent, un assistente vocale privato che funziona in locale. {style}{name} Rispondi in una o due frasi brevi e naturali. Usa gli strumenti per le azioni e le informazioni attuali. Le note della fotocamera descrivono l'ambiente dell'utente.",
    voice_earlier: "Prima in questa chat:",
    labels: &[
        ("shell", "Esegui `{v}`"),
        ("read_file", "Leggi {v}"),
        ("write_file", "Scrivi {v}"),
        ("list_dir", "Elenca {v}"),
        ("remember", "Ricorda “{v}”"),
        ("recall", "Cerca nella memoria “{v}”"),
        ("open", "Apri {v}"),
        ("clipboard", "Leggi gli appunti"),
        ("look_at_image", "Guarda {v}"),
        ("look_at_screen", "Guarda lo schermo"),
        ("transcribe_audio", "Ascolta {v}"),
        ("set_clipboard", "Copia negli appunti"),
        ("reminder", "Imposta un promemoria: {v}"),
        ("web_search", "Cerca sul web “{v}”"),
        ("fetch_url", "Leggi {v}"),
        ("browser_goto", "Apri {v} nel browser"),
        ("browser_read", "Leggi la pagina del browser"),
        ("browser_click", "Clicca “{v}”"),
        ("browser_type", "Scrivi in “{v}”"),
        ("unknown", "Azione sconosciuta"),
    ],
    decided_auto: "Approvato da Auto 150M",
    decided_you: "Approvato da te",
    decided_no: "Hai detto di no",
    guardian_unsure: "Auto 150M non è sicuro che sia sicuro ({risk}% di rischio).",
    guardian_unready: "Auto 150M non è ancora pronto, quindi mi serve il tuo ok.",
    starters: &[
        ("morning", "Riepilogo del mattino", "Fammi un breve riepilogo del mattino: la data di oggi, il meteo dove vivo se lo sai, e tre notizie principali. Cerca le notizie sul web."),
        ("tidy", "Riordina i Download", "Guarda la mia cartella ~/Downloads e suggerisci come riordinarla: raggruppa i file per tipo e segnala vecchi installer e duplicati. Per ora non spostare né eliminare niente."),
        ("news", "Notizie di oggi", "Cerca sul web le notizie più importanti di oggi e riassumi le cinque più importanti in una o due frasi ciascuna."),
        ("check_mac", "Controlla il mio Mac", "Controlla lo stato del mio Mac: spazio libero su disco, pressione della memoria, condizione della batteria e tempo di attività. Usa comandi shell, poi spiega i risultati in modo semplice."),
        ("check_computer", "Controlla il mio computer", "Controlla lo stato del mio computer: spazio libero su disco, uso della memoria, condizione della batteria se ne ha una, tempo di attività e servizi di sistema falliti. Usa comandi shell, poi spiega i risultati in modo semplice."),
    ],
    no_reply: "Non sono riuscito a formulare una risposta. Prova a chiederlo in un altro modo.",
    tools_unavailable: "Le azioni con strumenti non sono disponibili per questa richiesta.",
    declined: "L'utente ha rifiutato questa azione. Non riprovarla; dillo all'utente.",
    decided_free: "Automatico",
    decided_full: "Automatico",
    decided_safe: "Sola lettura, sicuro",
    settings_changed: "Le impostazioni di approvazione sono cambiate, quindi mi serve il tuo ok.",
    step_limit: "Mi sono fermato dopo {n} passi. Di' **continua** se vuoi che vada avanti.",
    speaker_user: "Utente",
    speaker_you: "Tu",
    ideas_system: "Suggerisci cose che un agente IA personale su un {device} potrebbe fare per questo utente adesso. Può chattare, cercare sul web, usare file e app, impostare promemoria, navigare nei siti e vedere lo schermo. Scrivi esattamente 4 righe. Ogni riga è un titolo breve, una barra verticale |, poi la richiesta completa che l'utente scriverebbe. Esempio di riga: Riordina i Download | Sposta i file della mia cartella Download in cartelle per tipo. Niente numerazione, nient'altro, tutto in italiano.",
    ideas_known: "Ciò che so dell'utente: {facts}",
    ideas_need_brain: "Le idee richiedono il cervello di tutti i giorni. Configuralo in Impostazioni → Download.",
    device_computer: "computer Linux",
    ideas_model_ok: false,
    ideas_starter: &[
        ("Riordina i Download", "Sposta i file della mia cartella Download in cartelle per tipo."),
        ("Imposta un promemoria", "Ricordami di fare una pausa tra un'ora."),
        ("Cerca sul web", "Cerca le notizie più recenti su un argomento che ti indico."),
        ("Riassumi una pagina", "Apri un sito web e riassumi quello che dice."),
    ],
};

static ZH: Strings = Strings {
    name: "中文",
    persona: "你是 Liquid Agent，一个在本地运行的私人助手。",
    markdown: "有帮助时使用 Markdown。",
    personalities: &[
        ("friendly", "语气温和、清晰、有耐心，解释要简单。"),
        ("concise", "极其简短，不说废话。"),
        ("playful", "机智有趣，但依然有用。"),
        ("professional", "准确、专业。"),
    ],
    reply_same: "请使用与用户相同的语言回复。",
    reply_in: "请用{language}回复。",
    direct: " 请直接回答。本次请求不能使用工具；不要声称已经执行了任何操作。",
    attachments: " 你可以看到和听到附件。",
    user_name: " 用户的名字是{name}。",
    user_facts: "关于用户的信息：{facts}",
    tools_intro: "当请求需要文件、电脑或记忆时，只用一次工具调用来回复：",
    tools_list: "工具：",
    tools_after: "得到结果后，只要信息足够就立即回答；只有必要时才使用其他工具。",
    media_tools: "媒体工具：",
    browser_tools: "浏览器工具：",
    voice: "你是 Liquid Agent，一个在本地运行的私人语音助手。{style}{name} 用一两句简短自然的口语回答。对于操作和当前信息，请使用工具。摄像头备注描述用户周围的环境。",
    voice_earlier: "此对话中较早的内容：",
    labels: &[
        ("shell", "运行 `{v}`"),
        ("read_file", "读取 {v}"),
        ("write_file", "写入 {v}"),
        ("list_dir", "列出 {v}"),
        ("remember", "记住“{v}”"),
        ("recall", "回忆“{v}”"),
        ("open", "打开 {v}"),
        ("clipboard", "读取剪贴板"),
        ("look_at_image", "查看 {v}"),
        ("look_at_screen", "查看屏幕"),
        ("transcribe_audio", "听取 {v}"),
        ("set_clipboard", "复制到剪贴板"),
        ("reminder", "设置提醒：{v}"),
        ("web_search", "在网上搜索“{v}”"),
        ("fetch_url", "阅读 {v}"),
        ("browser_goto", "在浏览器中打开 {v}"),
        ("browser_read", "阅读浏览器页面"),
        ("browser_click", "点击“{v}”"),
        ("browser_type", "输入到“{v}”"),
        ("unknown", "未知操作"),
    ],
    decided_auto: "由 Auto 150M 批准",
    decided_you: "由你批准",
    decided_no: "你拒绝了",
    guardian_unsure: "Auto 150M 不能确定这是否安全（风险 {risk}%）。",
    guardian_unready: "Auto 150M 尚未就绪，因此需要你的同意。",
    starters: &[
        ("morning", "晨间简报", "请给我一份简短的晨间简报：今天的日期、我所在地的天气（如果你知道），以及三条主要新闻头条。请在网上搜索新闻。"),
        ("tidy", "整理下载", "看看我的 ~/Downloads 文件夹，建议如何整理：按类型分组，并指出旧的安装程序和重复文件。暂时不要移动或删除任何东西。"),
        ("news", "今日新闻", "在网上搜索今天最重要的新闻，并用一两句话概括最重要的五条。"),
        ("check_mac", "检查我的 Mac", "检查我的 Mac 的状态：可用磁盘空间、内存压力、电池状况和运行时间。请使用 shell 命令，然后简单地解释结果。"),
        ("check_computer", "检查我的电脑", "检查我的电脑的状态：可用磁盘空间、内存使用、电池状况（如果有）、运行时间和失败的系统服务。请使用 shell 命令，然后简单地解释结果。"),
    ],
    no_reply: "我没能想出回复。请换个方式再问。",
    tools_unavailable: "本次请求不能使用工具操作。",
    declined: "用户拒绝了此操作。不要重试；请告知用户。",
    decided_free: "自动",
    decided_full: "全自动",
    decided_safe: "只读，安全",
    settings_changed: "批准设置已更改，因此需要你的同意。",
    step_limit: "我在 {n} 步后停止了。如果希望我继续，请说 **继续**。",
    speaker_user: "用户",
    speaker_you: "你",
    ideas_system: "你要建议一个运行在{device}上的个人 AI 助手现在可以为这位用户做的事情。它可以聊天、搜索网页、使用文件和应用、设置提醒、浏览网站并查看屏幕。请恰好写 4 行。每行是一个简短标题、一个竖线 |，然后是用户会输入的完整请求。例如：整理下载 | 把我的下载文件夹里的文件按类型分到不同文件夹。不要编号，不要其他内容，全部用中文。",
    ideas_known: "用户的信息：{facts}",
    ideas_need_brain: "想法需要“日常大脑”。请在 设置 → 下载 中设置。",
    device_computer: "Linux 电脑",
    ideas_model_ok: false,
    ideas_starter: &[
        ("整理下载文件夹", "把我的下载文件夹里的文件按类型分到不同文件夹。"),
        ("设置提醒", "一小时后提醒我休息一下。"),
        ("搜索网页", "搜索我指定的主题的最新新闻。"),
        ("总结网页", "打开一个网页，并总结其中的内容。"),
    ],
};

static JA: Strings = Strings {
    name: "日本語",
    persona: "あなたは Liquid Agent です。ローカルで動くプライベートなアシスタントです。",
    markdown: "役立つ場合は Markdown を使ってください。",
    personalities: &[
        ("friendly", "温かく、分かりやすく、根気強く話してください。説明は簡単に。"),
        ("concise", "とても簡潔に。余計な言葉は省いてください。"),
        ("playful", "機知に富んで楽しく、それでも役に立つように。"),
        ("professional", "正確で、プロフェッショナルに。"),
    ],
    reply_same: "ユーザーと同じ言語で返答してください。",
    reply_in: "{language}で返答してください。",
    direct: " 直接答えてください。このリクエストではツールは使えません。操作を実行したと決して主張しないでください。",
    attachments: " 添付ファイルを見たり聞いたりできます。",
    user_name: " ユーザーの名前は{name}です。",
    user_facts: "ユーザーについて：{facts}",
    tools_intro: "リクエストがファイル、コンピューター、またはメモリに関するものなら、ツール呼び出しを 1 つだけ返してください：",
    tools_list: "ツール：",
    tools_after: "結果を得たら、十分に分かった時点で答えてください。他のツールは必要な場合だけ使ってください。",
    media_tools: "メディアツール：",
    browser_tools: "ブラウザツール：",
    voice: "あなたは Liquid Agent です。ローカルで動くプライベートな音声アシスタントです。{style}{name} 短く自然な話し言葉で、一、二文で答えてください。操作や最新の情報にはツールを使ってください。カメラのメモはユーザーの周囲の様子を表します。",
    voice_earlier: "このチャットでこれより前の内容：",
    labels: &[
        ("shell", "`{v}` を実行"),
        ("read_file", "{v} を読む"),
        ("write_file", "{v} を書く"),
        ("list_dir", "{v} の一覧"),
        ("remember", "「{v}」を覚える"),
        ("recall", "「{v}」を思い出す"),
        ("open", "{v} を開く"),
        ("clipboard", "クリップボードを読む"),
        ("look_at_image", "{v} を見る"),
        ("look_at_screen", "画面を見る"),
        ("transcribe_audio", "{v} を聞き取る"),
        ("set_clipboard", "クリップボードにコピー"),
        ("reminder", "リマインダーを設定：{v}"),
        ("web_search", "「{v}」をウェブで検索"),
        ("fetch_url", "{v} を読む"),
        ("browser_goto", "ブラウザで {v} を開く"),
        ("browser_read", "ブラウザのページを読む"),
        ("browser_click", "「{v}」をクリック"),
        ("browser_type", "「{v}」に入力"),
        ("unknown", "不明な操作"),
    ],
    decided_auto: "Auto 150M が承認",
    decided_you: "あなたが承認",
    decided_no: "あなたが拒否",
    guardian_unsure: "Auto 150M は安全かどうか確信が持てません（危険度 {risk}%）。",
    guardian_unready: "Auto 150M の準備がまだのため、あなたの許可が必要です。",
    starters: &[
        ("morning", "朝のブリーフィング", "短い朝のブリーフィングをください：今日の日付、住んでいる場所の天気（分かれば）、主要なニュースの見出し 3 つ。ニュースはウェブで検索してください。"),
        ("tidy", "ダウンロードを整理", "私の ~/Downloads フォルダを見て、整理の方法を提案してください：ファイルを種類ごとにまとめ、古いインストーラーや重複を指摘してください。まだ何も移動や削除はしないでください。"),
        ("news", "今日のニュース", "今日の最も重要なニュースをウェブで検索し、大きな 5 つの話題をそれぞれ一、二文で要約してください。"),
        ("check_mac", "Mac の状態を確認", "私の Mac の状態を確認してください：空きディスク容量、メモリの圧迫、バッテリーの状態、稼働時間。シェルコマンドを使い、結果をやさしく説明してください。"),
        ("check_computer", "コンピューターの状態を確認", "私のコンピューターの状態を確認してください：空きディスク容量、メモリ使用量、バッテリーの状態（ある場合）、稼働時間、失敗したシステムサービス。シェルコマンドを使い、結果をやさしく説明してください。"),
    ],
    no_reply: "返答をまとめられませんでした。別の聞き方で試してください。",
    tools_unavailable: "このリクエストではツール操作は利用できません。",
    declined: "ユーザーはこの操作を拒否しました。再試行せず、ユーザーに伝えてください。",
    decided_free: "自動",
    decided_full: "全自動",
    decided_safe: "読み取りのみ、安全",
    settings_changed: "承認の設定が変わったため、あなたの許可が必要です。",
    step_limit: "{n} ステップで止めました。続けてほしい場合は **続けて** と言ってください。",
    speaker_user: "ユーザー",
    speaker_you: "あなた",
    ideas_system: "{device}上で動く個人向けAIエージェントが、今このユーザーのためにできることを提案してください。チャット、ウェブ検索、ファイルやアプリの利用、リマインダーの設定、サイトの閲覧、画面の確認ができます。ちょうど 4 行で書いてください。各行は短いタイトル、縦線 |、ユーザーが入力するであろう完全な依頼文の順です。例：ダウンロードを整理 | ダウンロードフォルダのファイルを種類ごとにフォルダへ分けて。番号や他の文章は付けず、すべて日本語で書いてください。",
    ideas_known: "ユーザーについて知っていること：{facts}",
    ideas_need_brain: "アイデアには「日常の頭脳」が必要です。設定 → ダウンロード で設定してください。",
    device_computer: "Linux コンピューター",
    ideas_model_ok: false,
    ideas_starter: &[
        ("ダウンロードを整理", "ダウンロードフォルダのファイルを種類ごとにフォルダへ分けて。"),
        ("リマインダーを設定", "1時間後に休憩するよう知らせて。"),
        ("ウェブで検索", "私が指定したテーマの最新ニュースを探して。"),
        ("ページを要約", "ウェブサイトを開いて、内容を要約して。"),
    ],
};

/// The few lines a person reads in the terminal when they run `liquid-agent` or start the server.
pub struct Console {
    /// Contains {url}.
    pub open_in_browser: &'static str,
    /// Contains {url}.
    pub starting: &'static str,
    /// Contains {url}.
    pub running: &'static str,
    /// Contains {url}.
    pub already_running: &'static str,
    /// Contains {port}.
    pub port_in_use: &'static str,
    /// Contains {path}.
    pub data_folder: &'static str,
    pub stopped: &'static str,
    pub not_running: &'static str,
    pub usage: &'static str,
}

const CONSOLE_EN: Console = Console {
    open_in_browser: "Open {url} in your browser.",
    starting: "Starting Liquid Agent at {url}",
    running: "Liquid Agent is running at {url}",
    already_running: "Liquid Agent is already running at {url}",
    port_in_use:
        "Port {port} is in use by another program. Set LIQUID_AGENT_PORT to use a different port.",
    data_folder: "Data: {path}",
    stopped: "Stopped.",
    not_running: "It wasn't running.",
    usage: "Use: liquid-agent [open|stop|update|logs]",
};

const CONSOLE_ES: Console = Console {
    open_in_browser: "Abre {url} en tu navegador.",
    starting: "Iniciando Liquid Agent en {url}",
    running: "Liquid Agent está funcionando en {url}",
    already_running: "Liquid Agent ya está en marcha en {url}",
    port_in_use:
        "El puerto {port} lo usa otro programa. Define LIQUID_AGENT_PORT para usar otro puerto.",
    data_folder: "Datos: {path}",
    stopped: "Detenido.",
    not_running: "No estaba en marcha.",
    usage: "Uso: liquid-agent [open|stop|update|logs]",
};

const CONSOLE_PT: Console = Console {
    open_in_browser: "Abra {url} no seu navegador.",
    starting: "Iniciando o Liquid Agent em {url}",
    running: "O Liquid Agent está rodando em {url}",
    already_running: "O Liquid Agent já está rodando em {url}",
    port_in_use: "A porta {port} está em uso por outro programa. Defina LIQUID_AGENT_PORT para usar outra porta.",
    data_folder: "Dados: {path}",
    stopped: "Parado.",
    not_running: "Ele não estava rodando.",
    usage: "Uso: liquid-agent [open|stop|update|logs]",
};

const CONSOLE_FR: Console = Console {
    open_in_browser: "Ouvrez {url} dans votre navigateur.",
    starting: "Démarrage de Liquid Agent sur {url}",
    running: "Liquid Agent fonctionne sur {url}",
    already_running: "Liquid Agent tourne déjà sur {url}",
    port_in_use: "Le port {port} est utilisé par un autre programme. Définissez LIQUID_AGENT_PORT pour utiliser un autre port.",
    data_folder: "Données : {path}",
    stopped: "Arrêté.",
    not_running: "Il ne tournait pas.",
    usage: "Utilisation : liquid-agent [open|stop|update|logs]",
};

const CONSOLE_DE: Console = Console {
    open_in_browser: "Öffne {url} in deinem Browser.",
    starting: "Liquid Agent wird auf {url} gestartet",
    running: "Liquid Agent läuft auf {url}",
    already_running: "Liquid Agent läuft bereits auf {url}",
    port_in_use: "Port {port} wird von einem anderen Programm benutzt. Setze LIQUID_AGENT_PORT, um einen anderen Port zu verwenden.",
    data_folder: "Daten: {path}",
    stopped: "Beendet.",
    not_running: "Es lief nicht.",
    usage: "Aufruf: liquid-agent [open|stop|update|logs]",
};

const CONSOLE_IT: Console = Console {
    open_in_browser: "Apri {url} nel tuo browser.",
    starting: "Avvio di Liquid Agent su {url}",
    running: "Liquid Agent è in esecuzione su {url}",
    already_running: "Liquid Agent è già in esecuzione su {url}",
    port_in_use: "La porta {port} è usata da un altro programma. Imposta LIQUID_AGENT_PORT per usare un'altra porta.",
    data_folder: "Dati: {path}",
    stopped: "Fermato.",
    not_running: "Non era in esecuzione.",
    usage: "Uso: liquid-agent [open|stop|update|logs]",
};

const CONSOLE_ZH: Console = Console {
    open_in_browser: "请在浏览器中打开 {url}。",
    starting: "正在 {url} 启动 Liquid Agent",
    running: "Liquid Agent 正在 {url} 运行",
    already_running: "Liquid Agent 已经在 {url} 运行",
    port_in_use: "端口 {port} 已被其他程序占用。请设置 LIQUID_AGENT_PORT 以使用其他端口。",
    data_folder: "数据：{path}",
    stopped: "已停止。",
    not_running: "它原本没有在运行。",
    usage: "用法：liquid-agent [open|stop|update|logs]",
};

const CONSOLE_JA: Console = Console {
    open_in_browser: "ブラウザで {url} を開いてください。",
    starting: "Liquid Agent を {url} で起動しています",
    running: "Liquid Agent は {url} で動作中です",
    already_running: "Liquid Agent は {url} で既に動作中です",
    port_in_use: "ポート {port} は別のプログラムが使用中です。別のポートを使うには LIQUID_AGENT_PORT を設定してください。",
    data_folder: "データ：{path}",
    stopped: "停止しました。",
    not_running: "動作していませんでした。",
    usage: "使い方：liquid-agent [open|stop|update|logs]",
};

/// The terminal lines for a language code; anything unknown gets English.
pub fn console(code: &str) -> &'static Console {
    match code {
        "es" => &CONSOLE_ES,
        "pt" => &CONSOLE_PT,
        "fr" => &CONSOLE_FR,
        "de" => &CONSOLE_DE,
        "it" => &CONSOLE_IT,
        "zh" => &CONSOLE_ZH,
        "ja" => &CONSOLE_JA,
        _ => &CONSOLE_EN,
    }
}

/// The terminal language: LIQUID_AGENT_LANG, else the system's LANG (as the installer uses it).
pub fn console_language() -> &'static Console {
    console(terminal_code().as_str())
}

/// The language code of the terminal, from LIQUID_AGENT_LANG or LANG; empty when neither is set.
fn terminal_code() -> String {
    let raw = std::env::var("LIQUID_AGENT_LANG")
        .or_else(|_| std::env::var("LANG"))
        .unwrap_or_default();
    raw.split(['_', '.', '@', '-'])
        .next()
        .unwrap_or("")
        .to_owned()
}

/// Human-readable diagnostics that go to the log or the terminal, as opposed to the protocol output the server reads.
pub struct Diag {
    /// Template for `save_reminders`; see the English line for the placeholders.
    pub save_reminders: &'static str,
    /// Template for `save_routine`; see the English line for the placeholders.
    pub save_routine: &'static str,
    /// Template for `save_chat`; see the English line for the placeholders.
    pub save_chat: &'static str,
    /// Template for `updating`; see the English line for the placeholders.
    pub updating: &'static str,
    /// Template for `move_old`; see the English line for the placeholders.
    pub move_old: &'static str,
    /// Template for `install_update`; see the English line for the placeholders.
    pub install_update: &'static str,
    /// Template for `start_updated`; see the English line for the placeholders.
    pub start_updated: &'static str,
    /// Template for `updated`; see the English line for the placeholders.
    pub updated: &'static str,
    /// Template for `build_not_started`; see the English line for the placeholders.
    pub build_not_started: &'static str,
    /// Template for `activate_safety`; see the English line for the placeholders.
    pub activate_safety: &'static str,
    /// Template for `bridge_ready`; see the English line for the placeholders.
    pub bridge_ready: &'static str,
    /// Template for `guardian_ready`; see the English line for the placeholders.
    pub guardian_ready: &'static str,
    /// Template for `graphics_card`; see the English line for the placeholders.
    pub graphics_card: &'static str,
}

const DIAG_EN: Diag = Diag {
    save_reminders: "Could not save reminders: {error}",
    save_routine: "Could not save routine: {error}",
    save_chat: "Could not save chat: {error}",
    updating: "Updating to build {build}",
    move_old: "Could not move the old app: {error}",
    install_update: "Could not install the update: {error}",
    start_updated: "Could not start updated app: {error}",
    updated: "Updated to build {build}",
    build_not_started: "Build {build} did not start; restoring the previous version.",
    activate_safety: "Could not activate the safety helper: {error}",
    bridge_ready: "[bridge] Web helper on 127.0.0.1:{port}",
    guardian_ready: "[guardian] {model} ready at 127.0.0.1:{port}",
    graphics_card: "graphics card: {gpu}",
};

const DIAG_ES: Diag = Diag {
    save_reminders: "No se pudieron guardar los recordatorios: {error}",
    save_routine: "No se pudo guardar la rutina: {error}",
    save_chat: "No se pudo guardar el chat: {error}",
    updating: "Actualizando a la versión {build}",
    move_old: "No se pudo mover la app anterior: {error}",
    install_update: "No se pudo instalar la actualización: {error}",
    start_updated: "No se pudo iniciar la app actualizada: {error}",
    updated: "Actualizado a la versión {build}",
    build_not_started: "La versión {build} no se inició; se restaura la anterior.",
    activate_safety: "No se pudo activar el asistente de seguridad: {error}",
    bridge_ready: "[bridge] Asistente web en 127.0.0.1:{port}",
    guardian_ready: "[guardian] {model} listo en 127.0.0.1:{port}",
    graphics_card: "tarjeta gráfica: {gpu}",
};

const DIAG_PT: Diag = Diag {
    save_reminders: "Não foi possível salvar os lembretes: {error}",
    save_routine: "Não foi possível salvar a rotina: {error}",
    save_chat: "Não foi possível salvar o chat: {error}",
    updating: "Atualizando para a versão {build}",
    move_old: "Não foi possível mover o aplicativo anterior: {error}",
    install_update: "Não foi possível instalar a atualização: {error}",
    start_updated: "Não foi possível iniciar o aplicativo atualizado: {error}",
    updated: "Atualizado para a versão {build}",
    build_not_started: "A versão {build} não iniciou; restaurando a anterior.",
    activate_safety: "Não foi possível ativar o auxiliar de segurança: {error}",
    bridge_ready: "[bridge] Auxiliar web em 127.0.0.1:{port}",
    guardian_ready: "[guardian] {model} pronto em 127.0.0.1:{port}",
    graphics_card: "placa de vídeo: {gpu}",
};

const DIAG_FR: Diag = Diag {
    save_reminders: "Impossible d'enregistrer les rappels : {error}",
    save_routine: "Impossible d'enregistrer la routine : {error}",
    save_chat: "Impossible d'enregistrer la conversation : {error}",
    updating: "Mise à jour vers la version {build}",
    move_old: "Impossible de déplacer l'ancienne application : {error}",
    install_update: "Impossible d'installer la mise à jour : {error}",
    start_updated: "Impossible de lancer l'application mise à jour : {error}",
    updated: "Mis à jour vers la version {build}",
    build_not_started: "La version {build} n'a pas démarré ; restauration de la précédente.",
    activate_safety: "Impossible d'activer l'assistant de sécurité : {error}",
    bridge_ready: "[bridge] Assistant web sur 127.0.0.1:{port}",
    guardian_ready: "[guardian] {model} prêt sur 127.0.0.1:{port}",
    graphics_card: "carte graphique : {gpu}",
};

const DIAG_DE: Diag = Diag {
    save_reminders: "Erinnerungen konnten nicht gespeichert werden: {error}",
    save_routine: "Routine konnte nicht gespeichert werden: {error}",
    save_chat: "Chat konnte nicht gespeichert werden: {error}",
    updating: "Aktualisierung auf Version {build}",
    move_old: "Die alte App konnte nicht verschoben werden: {error}",
    install_update: "Das Update konnte nicht installiert werden: {error}",
    start_updated: "Die aktualisierte App konnte nicht gestartet werden: {error}",
    updated: "Auf Version {build} aktualisiert",
    build_not_started:
        "Version {build} startete nicht; die vorherige Version wird wiederhergestellt.",
    activate_safety: "Der Sicherheitshelfer konnte nicht aktiviert werden: {error}",
    bridge_ready: "[bridge] Web-Helfer auf 127.0.0.1:{port}",
    guardian_ready: "[guardian] {model} bereit auf 127.0.0.1:{port}",
    graphics_card: "Grafikkarte: {gpu}",
};

const DIAG_IT: Diag = Diag {
    save_reminders: "Impossibile salvare i promemoria: {error}",
    save_routine: "Impossibile salvare la routine: {error}",
    save_chat: "Impossibile salvare la chat: {error}",
    updating: "Aggiornamento alla versione {build}",
    move_old: "Impossibile spostare la vecchia app: {error}",
    install_update: "Impossibile installare l'aggiornamento: {error}",
    start_updated: "Impossibile avviare l'app aggiornata: {error}",
    updated: "Aggiornato alla versione {build}",
    build_not_started: "La versione {build} non è partita; ripristino della precedente.",
    activate_safety: "Impossibile attivare l'assistente di sicurezza: {error}",
    bridge_ready: "[bridge] Assistente web su 127.0.0.1:{port}",
    guardian_ready: "[guardian] {model} pronto su 127.0.0.1:{port}",
    graphics_card: "scheda grafica: {gpu}",
};

const DIAG_ZH: Diag = Diag {
    save_reminders: "无法保存提醒：{error}",
    save_routine: "无法保存例行任务：{error}",
    save_chat: "无法保存聊天：{error}",
    updating: "正在更新到版本 {build}",
    move_old: "无法移动旧版应用：{error}",
    install_update: "无法安装更新：{error}",
    start_updated: "无法启动更新后的应用：{error}",
    updated: "已更新到版本 {build}",
    build_not_started: "版本 {build} 未能启动，正在恢复之前的版本。",
    activate_safety: "无法启用安全助手：{error}",
    bridge_ready: "[bridge] 网页助手位于 127.0.0.1:{port}",
    guardian_ready: "[guardian] {model} 已就绪，位于 127.0.0.1:{port}",
    graphics_card: "显卡：{gpu}",
};

const DIAG_JA: Diag = Diag {
    save_reminders: "リマインダーを保存できませんでした：{error}",
    save_routine: "ルーティンを保存できませんでした：{error}",
    save_chat: "チャットを保存できませんでした：{error}",
    updating: "バージョン {build} に更新しています",
    move_old: "古いアプリを移動できませんでした：{error}",
    install_update: "更新をインストールできませんでした：{error}",
    start_updated: "更新後のアプリを起動できませんでした：{error}",
    updated: "バージョン {build} に更新しました",
    build_not_started: "バージョン {build} が起動しなかったため、前のバージョンに戻します。",
    activate_safety: "安全確認ヘルパーを有効にできませんでした：{error}",
    bridge_ready: "[bridge] ウェブヘルパーは 127.0.0.1:{port} で動作中",
    guardian_ready: "[guardian] {model} は 127.0.0.1:{port} で準備完了",
    graphics_card: "グラフィックカード：{gpu}",
};

/// The diagnostics for a language code; anything unknown gets English.
pub fn diag(code: &str) -> &'static Diag {
    match code {
        "es" => &DIAG_ES,
        "pt" => &DIAG_PT,
        "fr" => &DIAG_FR,
        "de" => &DIAG_DE,
        "it" => &DIAG_IT,
        "zh" => &DIAG_ZH,
        "ja" => &DIAG_JA,
        _ => &DIAG_EN,
    }
}

/// The diagnostics in the terminal language (see `console_language`).
pub fn diag_language() -> &'static Diag {
    diag(terminal_code().as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_language_has_the_protocol_pieces_and_placeholders() {
        for code in CODES {
            let s = table(code);
            assert!(!s.name.is_empty() && !s.persona.is_empty(), "{code}");
            assert_eq!(s.personalities.len(), 4, "{code}");
            assert!(s.reply_in.contains("{language}"), "{code}");
            assert!(s.user_name.contains("{name}"), "{code}");
            assert!(s.user_facts.contains("{facts}"), "{code}");
            assert!(
                s.voice.contains("{style}") && s.voice.contains("{name}"),
                "{code}"
            );
            assert!(s.guardian_unsure.contains("{risk}"), "{code}");
            assert_eq!(s.starters.len(), 5, "{code}");
            for (tool, _) in EN.labels {
                assert!(
                    s.labels.iter().any(|(name, _)| name == tool),
                    "{code} is missing the label for {tool}"
                );
            }
            for (_, template) in s.labels {
                assert!(
                    template.contains("{v}") || !template.contains('{'),
                    "{code}: {template}"
                );
            }
        }
    }

    #[test]
    fn replies_follow_the_user_or_a_chosen_language() {
        let auto = reply_for(&json!({"language":"auto","uiLanguage":"es"}));
        assert!(auto.follows_user);
        assert_eq!(auto.strings.persona, ES.persona);
        assert_eq!(auto.directive(), ES.reply_same);
        let chosen = reply_for(&json!({"language":"ja","uiLanguage":"es"}));
        assert!(!chosen.follows_user);
        assert_eq!(chosen.directive(), "日本語で返答してください。");
        assert_eq!(
            reply_for(&json!({"language":"klingon"})).strings.persona,
            EN.persona
        );
        assert!(supported("zh") && !supported("klingon"));
    }

    #[test]
    fn labels_fill_the_main_argument_in_each_language() {
        let args = json!({"command": "ls -la", "path": "~/Downloads"});
        assert_eq!(label(&EN, "shell", &args), "Run `ls -la`");
        assert_eq!(label(&ES, "list_dir", &args), "Listar ~/Downloads");
        assert_eq!(label(&DE, "shell", &args), "`ls -la` ausführen");
        assert_eq!(label(&EN, "unknown_tool", &args), "Unknown action");
    }
    #[test]
    fn every_language_has_four_starter_cards() {
        for code in CODES {
            let s = table(code);
            assert_eq!(s.ideas_starter.len(), 4, "{code}");
            for (title, request) in s.ideas_starter {
                assert!(
                    !title.is_empty() && request.chars().count() >= 12,
                    "{code}: {title}"
                );
                assert!(
                    !title.ends_with('?') && !request.ends_with('?'),
                    "{code}: {request}"
                );
            }
        }
        assert!(!table("de").ideas_model_ok && table("en").ideas_model_ok);
    }

    #[test]
    fn every_diagnostic_keeps_its_placeholders() {
        for code in CODES {
            let d = diag(code);
            assert!(
                d.save_reminders.contains("{error}") && d.save_routine.contains("{error}"),
                "{code}"
            );
            assert!(
                d.save_chat.contains("{error}") && d.move_old.contains("{error}"),
                "{code}"
            );
            assert!(
                d.install_update.contains("{error}") && d.start_updated.contains("{error}"),
                "{code}"
            );
            assert!(d.activate_safety.contains("{error}"), "{code}");
            assert!(
                d.updating.contains("{build}")
                    && d.updated.contains("{build}")
                    && d.build_not_started.contains("{build}"),
                "{code}"
            );
            assert!(
                d.bridge_ready.contains("{port}")
                    && d.guardian_ready.contains("{port}")
                    && d.guardian_ready.contains("{model}"),
                "{code}"
            );
            assert!(d.graphics_card.contains("{gpu}"), "{code}");
        }
    }

    #[test]
    fn every_console_line_keeps_its_placeholders() {
        for code in CODES {
            let c = console(code);
            assert!(c.open_in_browser.contains("{url}"), "{code}");
            assert!(c.starting.contains("{url}"), "{code}");
            assert!(c.running.contains("{url}"), "{code}");
            assert!(c.already_running.contains("{url}"), "{code}");
            assert!(c.port_in_use.contains("{port}"), "{code}");
            assert!(c.data_folder.contains("{path}"), "{code}");
            assert!(c.usage.contains("liquid-agent"), "{code}");
        }
        assert_eq!(console("klingon").stopped, CONSOLE_EN.stopped);
        assert_eq!(console("ja").stopped, "停止しました。");
    }
}
