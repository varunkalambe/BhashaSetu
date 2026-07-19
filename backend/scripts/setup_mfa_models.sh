#!/usr/bin/env bash
# Downloads MFA acoustic models + pronunciation dictionaries for every
# language this project supports where MFA has coverage. Run once after
# `conda env create -f environment-mfa.yml && conda activate bhashasetu-mfa`.
set -e

echo "🔎 Checking MFA installation..."
if ! command -v mfa &> /dev/null; then
    echo "❌ 'mfa' not found. Install via: conda install -c conda-forge montreal-forced-aligner"
    exit 1
fi

# Languages confirmed to exist in MFA's public model index at the time of writing.
# hi/mr share hindi_mfa (Devanagari phonetics). English kept for source-side alignment.
declare -A LANG_MODELS=(
  ["hi"]="hindi_mfa"
  ["mr"]="hindi_mfa"
  ["bn"]="bengali_mfa"
  ["ta"]="tamil_mfa"
  ["te"]="telugu_mfa"
  ["gu"]="gujarati_mfa"
  ["kn"]="kannada_mfa"
  ["ml"]="malayalam_mfa"
  ["pa"]="punjabi_mfa"
  ["ur"]="urdu_mfa"
  ["en"]="english_mfa"
)

echo "📥 Downloading acoustic models + dictionaries..."
FAILED=()
for lang in "${!LANG_MODELS[@]}"; do
  model="${LANG_MODELS[$lang]}"
  echo "  -> [$lang] $model"
  if mfa model download acoustic "$model" 2>/dev/null && mfa model download dictionary "$model" 2>/dev/null; then
    echo "     ✅ $model installed"
  else
    echo "     ⚠️ $model not available in MFA's index, will fall back to Whisper alignment for $lang"
    FAILED+=("$lang")
  fi
done

echo ""
echo "===== SUMMARY ====="
echo "✅ Available for MFA forced alignment: $(( ${#LANG_MODELS[@]} - ${#FAILED[@]} )) / ${#LANG_MODELS[@]}"
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "⚠️ Not available, will use Whisper-word-timestamp fallback: ${FAILED[*]}"
fi
echo ""
echo "⚠️ Sindhi (sd) and Manipuri (mni) are NOT in MFA's public model index as of this"
echo "   writing — there is no known off-the-shelf MFA acoustic model/dictionary for"
echo "   either. run_mfa_align.py will fail for these and the pipeline already falls"
echo "   back to alignTranslatedAudio() (Whisper word timestamps) automatically."
echo ""
echo "Set MFA_ACOUSTIC_MODEL / MFA_DICTIONARY env vars to override the auto-mapped"
echo "'<language>_mfa' naming convention run_mfa_align.py assumes, if you install"
echo "custom-trained models instead."