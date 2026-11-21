#!/usr/bin/env bash
# One-command launch: WorldIR 3D studio at / and Video2Sim 3D at /video2sim/
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { cp .env.example .env; echo "Created .env - add your GEMINI_API_KEY"; }
uv sync -q
if [ ! -f video2sim/frontend/dist/index.html ] || [ "${REBUILD:-0}" = "1" ]; then
  (cd video2sim/frontend && npm install --silent && npm run build)
fi
echo "WorldIR 3D:   http://127.0.0.1:8000/"
echo "Video2Sim 3D: http://127.0.0.1:8000/video2sim/"
exec uv run uvicorn world.server:app --host 127.0.0.1 --port "${PORT:-8000}" "$@"
