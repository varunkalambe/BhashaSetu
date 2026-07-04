---
title: APNI VAANI - Video Language Translator
emoji: 🎬
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
startup_duration_timeout: 1h
pinned: false
license: mit
---

# 🎬 APNI VAANI - Video Language Translator

**Breaking Language Barriers in Indian Digital Content**

An AI-powered video translation platform that enables seamless conversion of video content across 13 Indian languages with native script support.

[![Smart India Hackathon 2024](https://img.shields.io/badge/SIH-2024-orange)](https://sih.gov.in/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Enabled-blue)](https://www.docker.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 🌟 Features

- **🗣️ Advanced Speech Recognition**: Powered by OpenAI Whisper (base model) for accurate multilingual transcription
- **🌐 13 Indian Languages**: Full support for Hindi, Telugu, Bengali, Tamil, Marathi, Gujarati, Kannada, Malayalam, Punjabi, Odia, Assamese, Urdu, and Sanskrit
- **🎙️ Natural Voice Synthesis**: Microsoft Edge TTS for human-like audio generation in native accents
- **📝 Native Script Subtitles**: Automatic generation in Devanagari, Bengali, Gujarati, Tamil, Telugu, Kannada, and other native scripts
- **🎥 Professional Video Processing**: FFmpeg-based rendering with embedded hardcoded subtitles
- **⚡ Real-Time Status Updates**: Live processing status tracking with progress indicators
- **📱 Responsive Design**: Mobile-friendly interface with multilingual UI support

## 🚀 How to Use

1. **Upload Video**: Select a video file (MP4, AVI, MOV, MKV up to 100MB)
2. **Select Languages**: Choose source and target languages from 13 supported options
3. **Process**: AI processes the video (2-4 minutes for 30-second video)
4. **Download**: Preview and download the translated video with embedded subtitles

## 💻 Technical Stack

- **Backend**: Node.js 18+ with Express 5
- **AI Models**: OpenAI Whisper (base model)
- **TTS**: Microsoft Edge TTS
- **Video Processing**: FFmpeg
- **Translation**: MyMemory API
- **Database**: MongoDB Atlas
- **Deployment**: Docker on Hugging Face Spaces

## 🌐 Supported Languages

| Language | Code | Native Script | Status |
|----------|------|---------------|--------|
| English | `en` | Latin | ✅ |
| Hindi | `hi` | देवनागरी | ✅ |
| Telugu | `te` | తెలుగు | ✅ |
| Bengali | `bn` | বাংলা | ✅ |
| Tamil | `ta` | தமிழ் | ✅ |
| Marathi | `mr` | मराठी | ✅ |
| Gujarati | `gu` | ગુજરાતી | ✅ |
| Kannada | `kn` | ಕನ್ನಡ | ✅ |
| Malayalam | `ml` | മലയാളം | ✅ |
| Punjabi | `pa` | ਪੰਜਾਬੀ | ✅ |
| Odia | `or` | ଓଡ଼ିଆ | ✅ |
| Assamese | `as` | অসমীয়া | ✅ |
| Urdu | `ur` | اردو | ✅ |
| Sanskrit | `sa` | संस्कृतम् | ✅ |

## ⏱️ Performance Metrics

| Video Duration | Processing Time | Stages |
|---------------|-----------------|---------|
| 30 seconds | 2-3 minutes | Audio extraction (10s), Transcription (30s), Translation (20s), TTS (40s), Assembly (60s) |
| 1 minute | 4-5 minutes | Linear scaling with video length |
| 5 minutes | 18-22 minutes | Optimized for batch processing |

## 🏆 Smart India Hackathon 2024

This project was developed for **Smart India Hackathon 2024** addressing the problem statement: **"Language Translation for Indian Regional Content"**.

### Problem Statement
Enable seamless video content translation across Indian languages to promote digital inclusivity and break language barriers in education, entertainment, and government services.

### Solution
APNI VAANI provides an end-to-end automated video translation pipeline with native script subtitle rendering, making regional content accessible to all Indians regardless of their linguistic background.

## 🛠️ Local Development

### Prerequisites
- Node.js 18+
- Python 3.10+
- FFmpeg
- MongoDB

### Installation


