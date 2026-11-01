#!/bin/bash
# Installs Liquid Agent, or updates it. Run:
#
#   curl -fsSL https://raw.githubusercontent.com/morriszdweck/liquid-agent/main/install.sh | bash
#
# Works on macOS and on Linux (x86_64 or arm64). The app goes in ~/.liquid-agent.
# It is all Rust (the server, the launcher and the Web helper's browser control), so
# nothing else needs installing, and it keeps itself up to date after this.
# It adds "Liquid Agent" to the app menu (Linux; on macOS the Mac app opens it) and a
# `liquid-agent` command, then opens the setup screen. Models are downloaded from there.
set -euo pipefail

REPO="${LIQUID_AGENT_REPO:-morriszdweck/liquid-agent}"
BRANCH="${LIQUID_AGENT_BRANCH:-main}"
ROOT="${LIQUID_AGENT_HOME:-$HOME/.liquid-agent}"
PORT="${LIQUID_AGENT_PORT:-8170}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\033[36m→\033[0m %s\n' "$*"; }
fail() {
  printf '\033[31m%s\033[0m\n' "$*" >&2
  exit 1
}

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin)
    DATA="$HOME/Library/Application Support/LiquidAgent"
    [ "$ARCH" = "arm64" ] || bold "$(msg apple_slow)"
    ;;
  Linux)
    DATA="${XDG_DATA_HOME:-$HOME/.local/share}/liquid-agent"
    case "$ARCH" in
      x86_64 | aarch64 | arm64) ;;
      *) fail "$(msg arch_no "$ARCH")" ;;
    esac
    ;;
  *) fail "$(msg only_mac_linux)" ;;
esac
command -v curl >/dev/null || fail "$(msg missing_tool curl)"
command -v tar >/dev/null || fail "$(msg missing_tool tar)"
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{ print $1 }'; }


# The installer's messages, in the language of this computer (from LANG); English for anything else.
LOC="${LIQUID_AGENT_LANG:-${LANG:-en}}"
LOC="${LOC%%[_.@-]*}"
msg() {
  local key="$1" en es pt fr de it zh ja out
  case "$key" in
    installing) en="Installing Liquid Agent"; es="Instalando Liquid Agent"; pt="Instalando o Liquid Agent"; fr="Installation de Liquid Agent"; de="Liquid Agent wird installiert"; it="Installazione di Liquid Agent"; zh="正在安装 Liquid Agent"; ja="Liquid Agent をインストールしています" ;;
    stopping) en="Stopping the running Liquid Agent"; es="Deteniendo Liquid Agent en ejecución"; pt="Parando o Liquid Agent em execução"; fr="Arrêt de Liquid Agent en cours d'exécution"; de="Laufendes Liquid Agent wird beendet"; it="Arresto di Liquid Agent in esecuzione"; zh="正在停止运行中的 Liquid Agent"; ja="動作中の Liquid Agent を停止しています" ;;
    downloading) en="Downloading the app"; es="Descargando la aplicación"; pt="Baixando o aplicativo"; fr="Téléchargement de l'application"; de="App wird heruntergeladen"; it="Download dell'app"; zh="正在下载应用"; ja="アプリをダウンロードしています" ;;
    no_github) en="Couldn't reach GitHub to download Liquid Agent. Check your connection and try again."; es="No se pudo conectar con GitHub para descargar Liquid Agent. Revisa tu conexión e inténtalo de nuevo."; pt="Não foi possível acessar o GitHub para baixar o Liquid Agent. Verifique sua conexão e tente de novo."; fr="Impossible de joindre GitHub pour télécharger Liquid Agent. Vérifiez votre connexion et réessayez."; de="GitHub war nicht erreichbar, um Liquid Agent herunterzuladen. Prüfe deine Verbindung und versuche es erneut."; it="Impossibile raggiungere GitHub per scaricare Liquid Agent. Controlla la connessione e riprova."; zh="无法连接 GitHub 下载 Liquid Agent。请检查网络连接后重试。"; ja="Liquid Agent をダウンロードするために GitHub に接続できませんでした。接続を確認して、もう一度お試しください。" ;;
    unfinished) en="The download didn't finish. Try again."; es="La descarga no terminó. Inténtalo de nuevo."; pt="O download não terminou. Tente de novo."; fr="Le téléchargement ne s'est pas terminé. Réessayez."; de="Der Download wurde nicht beendet. Versuche es erneut."; it="Il download non è terminato. Riprova."; zh="下载未完成，请重试。"; ja="ダウンロードが完了しませんでした。もう一度お試しください。" ;;
    checksum) en="The download didn't match its checksum. Try again."; es="La descarga no coincide con su suma de comprobación. Inténtalo de nuevo."; pt="O download não bate com a soma de verificação. Tente de novo."; fr="Le téléchargement ne correspond pas à sa somme de contrôle. Réessayez."; de="Der Download stimmt nicht mit der Prüfsumme überein. Versuche es erneut."; it="Il download non corrisponde al suo checksum. Riprova."; zh="下载内容的校验和不匹配，请重试。"; ja="ダウンロードのチェックサムが一致しません。もう一度お試しください。" ;;
    feed_bad) en="The update feed doesn't look like Liquid Agent's."; es="La fuente de actualizaciones no parece ser la de Liquid Agent."; pt="O feed de atualizações não parece ser o do Liquid Agent."; fr="Le flux de mises à jour ne semble pas être celui de Liquid Agent."; de="Der Update-Feed sieht nicht nach Liquid Agent aus."; it="Il feed di aggiornamento non sembra quello di Liquid Agent."; zh="更新信息看起来不是 Liquid Agent 的。"; ja="アップデート情報が Liquid Agent のものではないようです。" ;;
    download_bad) en="That download doesn't look like Liquid Agent."; es="Esa descarga no parece ser de Liquid Agent."; pt="Esse download não parece ser do Liquid Agent."; fr="Ce téléchargement ne semble pas être celui de Liquid Agent."; de="Dieser Download sieht nicht nach Liquid Agent aus."; it="Questo download non sembra essere di Liquid Agent."; zh="这个下载内容看起来不是 Liquid Agent。"; ja="そのダウンロードは Liquid Agent のものではないようです。" ;;
    no_server) en="This bundle does not contain a server for %s."; es="Este paquete no contiene un servidor para %s."; pt="Este pacote não contém um servidor para %s."; fr="Ce paquet ne contient pas de serveur pour %s."; de="Dieses Paket enthält keinen Server für %s."; it="Questo pacchetto non contiene un server per %s."; zh="此安装包不包含 %s 的服务器。"; ja="このバンドルには %s 用のサーバーが含まれていません。" ;;
    no_launcher) en="This bundle does not contain a launcher for %s."; es="Este paquete no contiene un lanzador para %s."; pt="Este pacote não contém um iniciador para %s."; fr="Ce paquet ne contient pas de lanceur pour %s."; de="Dieses Paket enthält keinen Starter für %s."; it="Questo pacchetto non contiene un launcher per %s."; zh="此安装包不包含 %s 的启动器。"; ja="このバンドルには %s 用のランチャーが含まれていません。" ;;
    no_platform) en="No launcher is available for %s %s."; es="No hay un lanzador disponible para %s %s."; pt="Não há iniciador disponível para %s %s."; fr="Aucun lanceur n'est disponible pour %s %s."; de="Für %s %s gibt es keinen Starter."; it="Nessun launcher disponibile per %s %s."; zh="%s %s 没有可用的启动器。"; ja="%s %s 用のランチャーはありません。" ;;
    only_mac_linux) en="Liquid Agent runs on macOS and Linux."; es="Liquid Agent funciona en macOS y Linux."; pt="O Liquid Agent funciona no macOS e no Linux."; fr="Liquid Agent fonctionne sous macOS et Linux."; de="Liquid Agent läuft unter macOS und Linux."; it="Liquid Agent funziona su macOS e Linux."; zh="Liquid Agent 可在 macOS 和 Linux 上运行。"; ja="Liquid Agent は macOS と Linux で動作します。" ;;
    arch_no) en="Liquid Agent runs on 64-bit Intel, AMD or ARM computers. This one is %s."; es="Liquid Agent funciona en ordenadores de 64 bits Intel, AMD o ARM. Este es %s."; pt="O Liquid Agent funciona em computadores de 64 bits Intel, AMD ou ARM. Este é %s."; fr="Liquid Agent fonctionne sur les ordinateurs 64 bits Intel, AMD ou ARM. Celui-ci est %s."; de="Liquid Agent läuft auf 64-Bit-Computern mit Intel-, AMD- oder ARM-Prozessor. Dieser ist %s."; it="Liquid Agent funziona su computer a 64 bit Intel, AMD o ARM. Questo è %s."; zh="Liquid Agent 可在 64 位 Intel、AMD 或 ARM 电脑上运行。此电脑为 %s。"; ja="Liquid Agent は 64 ビットの Intel、AMD、ARM のコンピューターで動作します。このコンピューターは %s です。" ;;
    missing_tool) en="%s is missing."; es="Falta %s."; pt="Falta %s."; fr="%s est absent."; de="%s fehlt."; it="Manca %s."; zh="缺少 %s。"; ja="%s が見つかりません。" ;;
    apple_slow) en="Heads up: Liquid Agent is built for Apple silicon. It will be slow on this Mac."; es="Ojo: Liquid Agent está hecho para Apple silicon. Será lento en este Mac."; pt="Atenção: o Liquid Agent foi feito para Apple silicon. Ele será lento neste Mac."; fr="Attention : Liquid Agent est conçu pour les puces Apple silicon. Il sera lent sur ce Mac."; de="Achtung: Liquid Agent ist für Apple-Silicon gebaut. Auf diesem Mac wird es langsam sein."; it="Attenzione: Liquid Agent è pensato per Apple silicon. Su questo Mac sarà lento."; zh="注意：Liquid Agent 是为 Apple 芯片构建的，在这台 Mac 上会比较慢。"; ja="注意：Liquid Agent は Apple シリコン向けです。この Mac では動作が遅くなります。" ;;
    installed) en="Liquid Agent is installed."; es="Liquid Agent está instalado."; pt="O Liquid Agent está instalado."; fr="Liquid Agent est installé."; de="Liquid Agent ist installiert."; it="Liquid Agent è installato."; zh="Liquid Agent 已安装。"; ja="Liquid Agent のインストールが完了しました。" ;;
    open_any) en="Open \"Liquid Agent\" any time from %s, or run: liquid-agent"; es="Abre «Liquid Agent» cuando quieras desde %s, o ejecuta: liquid-agent"; pt="Abra o \"Liquid Agent\" quando quiser em %s, ou execute: liquid-agent"; fr="Ouvrez « Liquid Agent » à tout moment depuis %s, ou lancez : liquid-agent"; de="Öffne „Liquid Agent“ jederzeit über %s oder führe aus: liquid-agent"; it="Apri «Liquid Agent» in qualsiasi momento da %s, oppure esegui: liquid-agent"; zh="随时可以从 %s 打开“Liquid Agent”，或运行：liquid-agent"; ja="%s からいつでも「Liquid Agent」を開けます。またはコマンド liquid-agent を実行してください。" ;;
    where_spotlight) en="Applications or Spotlight"; es="Aplicaciones o Spotlight"; pt="Aplicativos ou Spotlight"; fr="Applications ou Spotlight"; de="Programme oder Spotlight"; it="Applicazioni o Spotlight"; zh="“应用程序”或聚焦搜索"; ja="アプリケーションフォルダや Spotlight" ;;
    where_mac_app) en="the Mac app (get it at liquid-agent.mincoffical.codes)"; es="la app de Mac (descárgala en liquid-agent.mincoffical.codes)"; pt="o app do Mac (baixe em liquid-agent.mincoffical.codes)"; fr="l'application Mac (disponible sur liquid-agent.mincoffical.codes)"; de="der Mac-App (erhältlich unter liquid-agent.mincoffical.codes)"; it="l'app per Mac (su liquid-agent.mincoffical.codes)"; zh="Mac 应用（见 liquid-agent.mincoffical.codes）"; ja="Mac アプリ（liquid-agent.mincoffical.codes で入手）" ;;
    where_menu) en="your app menu"; es="el menú de aplicaciones"; pt="o menu de aplicativos"; fr="le menu des applications"; de="dem App-Menü"; it="il menu delle app"; zh="应用菜单"; ja="アプリメニュー" ;;
    extras) en="Optional extras for the clipboard, audio files and reminders:"; es="Extras opcionales para el portapapeles, los archivos de audio y los recordatorios:"; pt="Extras opcionais para a área de transferência, arquivos de áudio e lembretes:"; fr="Compléments facultatifs pour le presse-papiers, les fichiers audio et les rappels :"; de="Optionale Zusatzpakete für Zwischenablage, Audiodateien und Erinnerungen:"; it="Extra facoltativi per appunti, file audio e promemoria:"; zh="剪贴板、音频文件和提醒的可选组件："; ja="クリップボード、音声ファイル、リマインダーのための任意の追加パッケージ：" ;;
    path_hint) en="(To use the liquid-agent command, add ~/.local/bin to your PATH.)"; es="(Para usar el comando liquid-agent, añade ~/.local/bin a tu PATH.)"; pt="(Para usar o comando liquid-agent, adicione ~/.local/bin ao seu PATH.)"; fr="(Pour utiliser la commande liquid-agent, ajoutez ~/.local/bin à votre PATH.)"; de="(Um den Befehl liquid-agent zu nutzen, füge ~/.local/bin zu deinem PATH hinzu.)"; it="(Per usare il comando liquid-agent, aggiungi ~/.local/bin al tuo PATH.)"; zh="（要使用 liquid-agent 命令，请将 ~/.local/bin 加入 PATH。）"; ja="（liquid-agent コマンドを使うには、~/.local/bin を PATH に追加してください。）" ;;
    opening_setup) en="Opening the setup screen"; es="Abriendo la pantalla de configuración"; pt="Abrindo a tela de configuração"; fr="Ouverture de l'écran de configuration"; de="Setup-Bildschirm wird geöffnet"; it="Apertura della schermata di configurazione"; zh="正在打开设置界面"; ja="セットアップ画面を開いています" ;;
    *) en="$key"; es="$key"; pt="$key"; fr="$key"; de="$key"; it="$key"; zh="$key"; ja="$key" ;;
  esac
  case "$LOC" in
    es) out="$es" ;; pt) out="$pt" ;; fr) out="$fr" ;; de) out="$de" ;;
    it) out="$it" ;; zh) out="$zh" ;; ja) out="$ja" ;; *) out="$en" ;;
  esac
  shift
  # The translations only ever use %s, so the values go in order.
  printf "$out" "$@"
}

bold "$(msg installing)"
mkdir -p "$ROOT/bin" "$DATA/logs"

# ---- The app ----

# Stop a running copy first so its files can be replaced.
if curl -fs --max-time 2 "http://127.0.0.1:$PORT/healthz" 2>/dev/null | grep -q liquid-agent; then
  step "$(msg stopping)"
  pkill -f "$ROOT/app/bin/liquid-server-" 2>/dev/null || true
  sleep 2
fi

step "$(msg downloading)"
tmp="$(mktemp -d)"
if [ -n "${LIQUID_AGENT_BUNDLE:-}" ]; then
  cp "$LIQUID_AGENT_BUNDLE" "$tmp/app.tar.gz" # a local bundle, for testing
else
  # Every push to main publishes a ready-to-run bundle, so nothing is built here.
  curl -fsSL "https://github.com/$REPO/releases/latest/download/latest.json" -o "$tmp/latest.json" ||
    fail "$(msg no_github)"
  # latest.json is written by scripts/bundle.mjs: one "key": "value" pair per line.
  json_value() { grep -o "\"$1\": *\"[^\"]*\"" "$2" | head -1 | sed 's/.*: *"\([^"]*\)"$/\1/'; }
  url="$(json_value url "$tmp/latest.json")"
  expected="$(json_value sha256 "$tmp/latest.json")"
  [ -n "$url" ] && [ -n "$expected" ] || fail "$(msg feed_bad)"
  curl -fsSL "$url" -o "$tmp/app.tar.gz" || fail "$(msg unfinished)"
  [ "$(sha256 "$tmp/app.tar.gz")" = "$expected" ] || fail "$(msg checksum)"
fi
tar -xzf "$tmp/app.tar.gz" -C "$tmp"
case "$OS-$ARCH" in
  Linux-x86_64) native="linux-x64" ;;
  Linux-aarch64|Linux-arm64) native="linux-arm64" ;;
  Darwin-arm64) native="darwin-arm64" ;;
  Darwin-x86_64) native="darwin-x64" ;;
  *) fail "$(msg no_platform "$OS" "$ARCH")" ;;
esac
[ -f "$tmp/liquid-agent/build.json" ] || fail "$(msg download_bad)"
[ -f "$tmp/liquid-agent/bin/liquid-server-$native" ] || fail "$(msg no_server "$native")"
[ -f "$tmp/liquid-agent/bin/liquid-guardian-$native" ] || fail "$(msg no_launcher "$native")"
rm -rf "$ROOT/app.old" "$ROOT/app.next" "$ROOT/app.download" "$ROOT/app.bad"
[ -d "$ROOT/app" ] && mv "$ROOT/app" "$ROOT/app.old"
mv "$tmp/liquid-agent" "$ROOT/app"
rm -rf "$tmp" "$ROOT/app.old"

# ---- Ways to open it ----

# The release bundle includes a Rust launcher and server for each supported platform.
cp "$ROOT/app/bin/liquid-guardian-$native" "$ROOT/bin/liquid-agent.new"
chmod +x "$ROOT/bin/liquid-agent.new"
mv -f "$ROOT/bin/liquid-agent.new" "$ROOT/bin/liquid-agent"
# The launcher reads these settings; quotes and backslashes in the paths are escaped.
json_string() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
printf '{"root":"%s","data":"%s","port":"%s","repo":"%s","branch":"%s"}\n' \
  "$(json_string "$ROOT")" "$(json_string "$DATA")" "$PORT" "$(json_string "$REPO")" "$(json_string "$BRANCH")" >"$ROOT/bin/launcher.json"

mkdir -p "$HOME/.local/bin"
ln -sf "$ROOT/bin/liquid-agent" "$HOME/.local/bin/liquid-agent"

if [ "$OS" = "Darwin" ]; then
  # The Liquid Agent Mac app (a DMG on the website) is the way to open it on a Mac.
  # Older installs made a small app in ~/Applications that only opened a browser tab: remove it.
  old="$HOME/Applications/Liquid Agent.app"
  if [ -d "$old" ] && [ ! -e "$old/Contents/MacOS/Liquid Agent" ]; then rm -rf "$old"; fi
  if [ -e "/Applications/Liquid Agent.app/Contents/MacOS/Liquid Agent" ]; then WHERE="$(msg where_spotlight)"
  else WHERE="$(msg where_mac_app)"; fi
else
  # An entry in the app menu.
  APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$APPS"
  cat >"$APPS/liquid-agent.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Liquid Agent
Comment=A private AI agent that runs on this computer
Exec="$ROOT/bin/liquid-agent"
Icon=$ROOT/app/web/dist/icon.svg
Terminal=false
Categories=Utility;
EOF
  if command -v update-desktop-database >/dev/null; then update-desktop-database "$APPS" >/dev/null 2>&1 || true; fi
  WHERE="$(msg where_menu)"
fi

bold "$(msg installed)"
printf "$(msg open_any "$WHERE")\n"
if [ "$OS" = "Linux" ]; then
  # Everything works without these; they add the clipboard, audio files and reminder pop-ups.
  if command -v apt-get >/dev/null; then pm="sudo apt install" ffmpeg="ffmpeg" notify="libnotify-bin"
  elif command -v dnf >/dev/null; then pm="sudo dnf install" ffmpeg="ffmpeg-free" notify="libnotify"
  elif command -v pacman >/dev/null; then pm="sudo pacman -S" ffmpeg="ffmpeg" notify="libnotify"
  elif command -v zypper >/dev/null; then pm="sudo zypper install" ffmpeg="ffmpeg" notify="libnotify-tools"
  else pm="" ffmpeg="ffmpeg" notify="notify-send"
  fi
  want=""
  if [ -n "${WAYLAND_DISPLAY:-}" ]; then
    command -v wl-copy >/dev/null || want="$want wl-clipboard"
  else
    command -v xclip >/dev/null || command -v xsel >/dev/null || want="$want xclip"
  fi
  command -v ffmpeg >/dev/null || want="$want $ffmpeg"
  command -v notify-send >/dev/null || want="$want $notify"
  if [ -n "$want" ]; then
    if [ -n "$pm" ]; then printf "%s %s%s\n" "$(msg extras)" "$pm" "$want"
    else printf "%s%s\n" "$(msg extras)" "$want"; fi
  fi
fi
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "$(msg path_hint)" ;;
esac

# The Mac app runs this installer itself and opens Liquid Agent when it's done.
if [ -z "${LIQUID_AGENT_NO_OPEN:-}" ]; then
  step "$(msg opening_setup)"
  "$ROOT/bin/liquid-agent" open
fi
