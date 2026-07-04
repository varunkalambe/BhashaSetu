#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Universal Script Fixer for Whisper Transcriptions"""

import sys
import json
import re

SCRIPT_PATTERNS = {
    'arabic': r'[\u0600-\u06FF]',
    'devanagari': r'[\u0900-\u097F]',
    'gujarati': r'[\u0A80-\u0AFF]',
    'bengali': r'[\u0980-\u09FF]',
    'tamil': r'[\u0B80-\u0BFF]',
    'telugu': r'[\u0C00-\u0C7F]',
    'kannada': r'[\u0C80-\u0CFF]',
    'malayalam': r'[\u0D00-\u0D7F]',
}

LANGUAGE_SCRIPT_MAP = {
    'hi': 'devanagari',
    'ur': 'arabic',
    'gu': 'gujarati',
    'bn': 'bengali',
    'ta': 'tamil',
    'te': 'telugu',
    'kn': 'kannada',
    'ml': 'malayalam',
}

def detect_script(text):
    detected_scripts = {}
    for script_name, pattern in SCRIPT_PATTERNS.items():
        matches = len(re.findall(pattern, text))
        if matches > 0:
            detected_scripts[script_name] = matches
    
    if not detected_scripts:
        return 'latin'
    
    return max(detected_scripts, key=detected_scripts.get)

def check_script_mismatch(text, expected_language):
    detected_script = detect_script(text)
    expected_script = LANGUAGE_SCRIPT_MAP.get(expected_language, 'latin')
    mismatch = detected_script != expected_script
    return mismatch, detected_script

def process_transcription(input_path, output_path, expected_language):
    try:
        with open(input_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        text = data.get('text', '')
        has_mismatch, detected_script = check_script_mismatch(text, expected_language)
        
        if has_mismatch:
            expected_script = LANGUAGE_SCRIPT_MAP.get(expected_language, 'latin')
            print(f"WARNING: SCRIPT MISMATCH DETECTED!", file=sys.stderr)
            print(f"Expected: {expected_script} for language '{expected_language}'", file=sys.stderr)
            print(f"Detected: {detected_script}", file=sys.stderr)
            print(f"NEEDS_RETRANSCRIPTION", file=sys.stderr)
            
            data['script_issue'] = {
                'has_mismatch': True,
                'expected_script': expected_script,
                'detected_script': detected_script,
                'needs_retranscription': True
            }
        else:
            print(f"SUCCESS: Script matches expected: {detected_script}", file=sys.stderr)
            data['script_issue'] = {'has_mismatch': False, 'detected_script': detected_script}
        
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        
        return 0
        
    except Exception as e:
        print(f"ERROR: {str(e)}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(f"Usage: python {sys.argv[0]} <input_json> <output_json> <language_code>", file=sys.stderr)
        sys.exit(1)
    
    sys.exit(process_transcription(sys.argv[1], sys.argv[2], sys.argv[3]))
