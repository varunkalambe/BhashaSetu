# ===================================================================
# 🎬 APNI VAANI - Video Translation API Dockerfile
# Hugging Face Spaces Compatible - Smart India Hackathon 2024
# Optimized for CPU deployment with reduced image size
# ===================================================================

FROM node:18-slim

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# ===================================================================
# SYSTEM DEPENDENCIES
# ===================================================================

# Install system dependencies (FFmpeg, Python, Fonts)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    fontconfig \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    wget \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Verify installations
RUN echo "=== Verifying Installations ===" && \
    node --version && \
    npm --version && \
    python3 --version && \
    ffmpeg -version 2>&1 | head -n 1

# ===================================================================
# PYTHON DEPENDENCIES - CPU OPTIMIZED
# ===================================================================

# Create virtual environment and activate it
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install CPU-only PyTorch FIRST (CRITICAL: Prevents CUDA installation)
RUN pip3 install --no-cache-dir \
    torch==2.2.0+cpu \
    torchaudio==2.2.0+cpu \
    --index-url https://download.pytorch.org/whl/cpu

# Install other Python packages with compatible NumPy version (CRITICAL FIX!)
RUN pip3 install --no-cache-dir \
    "numpy<2.0" \
    openai-whisper \
    edge-tts


# Pre-download Whisper model to reduce runtime startup time
RUN echo "=== Downloading Whisper Model ===" && \
    python3 -c "import whisper; model = whisper.load_model('base'); print('✅ Whisper Model Downloaded Successfully')" || \
    (echo "❌ Failed to download Whisper model - retrying..." && sleep 5 && \
     python3 -c "import whisper; model = whisper.load_model('base'); print('✅ Whisper Model Downloaded Successfully')")

# ===================================================================
# DOWNLOAD INDIAN LANGUAGE FONTS
# ===================================================================

# Create fonts directory
RUN mkdir -p /app/backend/fonts

# Download Noto Sans fonts for Indian languages from Google Fonts
RUN echo "=== Downloading Indian Language Fonts ===" && \
    cd /app/backend/fonts && \
    wget -q https://github.com/notofonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf && \
    wget -q https://github.com/notofonts/noto-fonts/raw/main/hinted/ttf/NotoSansDevanagari/NotoSansDevanagari-Regular.ttf && \
    wget -q https://github.com/notofonts/noto-fonts/raw/main/hinted/ttf/NotoSansBengali/NotoSansBengali-Regular.ttf && \
    wget -q https://github.com/notofonts/noto-fonts/raw/main/hinted/ttf/NotoSansTamil/NotoSansTamil-Regular.ttf && \
    wget -q https://github.com/notofonts/noto-fonts/raw/main/hinted/ttf/NotoSansTelugu/NotoSansTelugu-Regular.ttf && \
    wget -q https://github.com/notofonts/noto-fonts/raw/main/hinted/ttf/NotoSansGujarati/NotoSansGujarati-Regular.ttf && \
    wget -q https://github.com/notofonts/noto-fonts/raw/main/hinted/ttf/NotoSansKannada/NotoSansKannada-Regular.ttf && \
    wget -q https://github.com/notofonts/noto-fonts/raw/main/hinted/ttf/NotoSansMalayalam/NotoSansMalayalam-Regular.ttf && \
    wget -q https://github.com/notofonts/noto-fonts/raw/main/hinted/ttf/NotoSansGurmukhi/NotoSansGurmukhi-Regular.ttf && \
    wget -q https://github.com/notofonts/noto-fonts/raw/main/hinted/ttf/NotoSansOriya/NotoSansOriya-Regular.ttf && \
    wget -q https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoNastaliqUrdu/NotoNastaliqUrdu-Regular.ttf && \
    echo "✅ All fonts downloaded successfully"

# Verify fonts were downloaded
RUN ls -lh /app/backend/fonts/ && \
    echo "Font count: $(ls /app/backend/fonts/*.ttf 2>/dev/null | wc -l)"

# ===================================================================
# APPLICATION SETUP
# ===================================================================

# Set working directory
WORKDIR /app

# Copy package files first (better Docker layer caching)
COPY backend/package*.json ./backend/

# Install Node.js dependencies (production only)
WORKDIR /app/backend
RUN npm ci --only=production --omit=dev

# Copy entire project
WORKDIR /app
COPY . .

# Create upload directories with proper permissions
RUN mkdir -p \
    /app/uploads/originals \
    /app/uploads/audio \
    /app/uploads/transcription \
    /app/uploads/translations \
    /app/uploads/translated_audio \
    /app/uploads/captions \
    /app/uploads/transcripts \
    /app/uploads/processed \
    /app/uploads/final \
    /app/uploads/temp && \
    chmod -R 777 /app/uploads /app/backend/fonts


# ===================================================================
# ENVIRONMENT CONFIGURATION
# ===================================================================

# Environment variables
ENV PORT=7860
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1
ENV FFMPEG_PATH=/usr/bin/ffmpeg

# Expose Hugging Face Spaces port
EXPOSE 7860

# ===================================================================
# HEALTH CHECK
# ===================================================================

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:7860/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# ===================================================================
# START APPLICATION
# ===================================================================

# Start the Node.js server
WORKDIR /app/backend
CMD ["node", "server.js"]
