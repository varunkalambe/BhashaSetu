import whisper_timestamped as whisper
import argparse
import json
import os

def transcribe_audio(audio_path, output_path, language_code):
    """
    Transcribes an audio file using whisper_timestamped to get word-level timings.
    """
    print(f"[+] Starting transcription for: {audio_path}")
    try:
        # Ensure the output directory exists
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        audio = whisper.load_audio(audio_path)
        # You can change the model size here if needed (e.g., "base", "medium")
        model = whisper.load_model("tiny", device="cpu") 

        result = whisper.transcribe(model, audio, language=language_code)

        # Save the full result as a JSON file
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

        print(f"[+] Transcription successful. Output saved to: {output_path}")

    except Exception as e:
        print(f"❌ An error occurred: {e}")
        # Create an empty error file to signal failure
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump({"error": str(e)}, f, ensure_ascii=False, indent=2)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Transcribe audio with word-level timestamps.")
    parser.add_argument("audio_path", type=str, help="Path to the audio file.")
    parser.add_argument("output_path", type=str, help="Path to save the output JSON.")
    parser.add_argument("--language", type=str, default="en", help="Language code (e.g., 'en', 'hi', 'gu').")

    args = parser.parse_args()

    transcribe_audio(args.audio_path, args.output_path, args.language)