#!/bin/sh
# Rebuilds the README images (docs/images/*.png) from a throwaway demo Herdr session. See README.md here.
set -e
cd "$(dirname "$0")"
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
[ -x "$CHROME" ] || CHROME=$(command -v google-chrome || command -v chromium)

(cd ../.. && npm run -s compile)
node demo-session.js
trap 'node demo-session.js stop' EXIT
sleep 2
python3 tuicap.py build/tui.raw 104 34
node make-state.js

shot() { # page width,height output
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size="$2" \
    --allow-file-access-from-files --virtual-time-budget=6000 --screenshot="../images/$3" "file://$PWD/$1" 2>/dev/null
  echo "wrote docs/images/$3"
}
mkdir -p ../images
shot vscode.html 1600,960 vscode.png
shot flow.html 1600,780 terminal-to-vscode.png
shot sidebar-feature.html 1200,1080 sidebar.png
