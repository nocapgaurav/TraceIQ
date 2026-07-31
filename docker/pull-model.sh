#!/bin/sh
# Pulls the configured model into the Ollama volume, once.
#
# Runs to completion before the API starts, because the API resolves its model at startup and exits if the
# provider does not hold it — so pulling afterwards would be too late.
#
# **A no-op when no model is configured.** That is the default, and it is deliberate: a model is gigabytes,
# and a fresh `docker compose up` should not begin with a multi-gigabyte download nobody asked for. Chat is
# then disabled and every other part of TraceIQ works; the API says `ai-not-configured` and the web UI shows
# what to do about it.
set -eu

if [ -z "${TRACEIQ_MODEL:-}" ]; then
  echo "no TRACEIQ_MODEL set — skipping the model download; chat will report ai-not-configured"
  exit 0
fi

# Already present is the common case on every start after the first, and `ollama pull` would otherwise spend
# time verifying a multi-gigabyte artefact each time.
if ollama list 2>/dev/null | awk 'NR > 1 { print $1 }' | grep -qx "${TRACEIQ_MODEL}"; then
  echo "${TRACEIQ_MODEL} is already present"
  exit 0
fi

echo "pulling ${TRACEIQ_MODEL} — this is a one-time download of several gigabytes"
ollama pull "${TRACEIQ_MODEL}"
echo "pulled ${TRACEIQ_MODEL}"
