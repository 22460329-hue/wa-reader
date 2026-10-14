#!/bin/sh
# wa-reader instalado como programa del sistema.
# Datos y sesión en ~/.local/share/wa-reader (no se mezclan con el programa).
DATA="$HOME/.local/share/wa-reader"
mkdir -p "$DATA"
exec env WA_DATA_DIR="$DATA" node /usr/lib/wa-reader/chatui.js "$@"
