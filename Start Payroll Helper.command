#!/bin/bash
# Double-click to run Payroll Helper locally (no internet needed).
# Serves the app on your own computer at http://localhost:8765 so it can be
# installed as a real offline app. Keep this window open while you use it.

cd "$(dirname "$0")" || exit 1
PORT=8765
PY="$(command -v python3 || command -v python)"
URL="http://localhost:${PORT}/payroll-helper.html"

if [ -z "$PY" ]; then
  echo "Python is required but was not found."
  echo "Install it from https://www.python.org/downloads/ then double-click this file again."
  read -r -p "Press Return to close." _
  exit 1
fi

echo "============================================"
echo "  Payroll Helper is running."
echo "  Open:  ${URL}"
echo ""
echo "  In Chrome/Edge: click the Install icon in"
echo "  the address bar to add it as an app."
echo ""
echo "  Keep this window open while using the app."
echo "  Press Control+C (or close this window) to stop."
echo "============================================"

( sleep 1; open "$URL" ) >/dev/null 2>&1 &
exec "$PY" -m http.server "$PORT"
