# Save this as: backend/cleanup_whisper_models.py
import os
import shutil
import whisper

def cleanup_whisper_models():
    """Delete all downloaded Whisper models"""
    
    # Get the whisper cache directory
    cache_dir = os.path.expanduser("~/.cache/whisper")
    
    if os.path.exists(cache_dir):
        print(f"Found Whisper cache directory: {cache_dir}")
        
        # List current models
        models = os.listdir(cache_dir)
        print(f"Current models: {models}")
        
        # Calculate total size
        total_size = 0
        for model in models:
            model_path = os.path.join(cache_dir, model)
            if os.path.isfile(model_path):
                size = os.path.getsize(model_path)
                total_size += size
                print(f"  {model}: {size / (1024*1024):.1f} MB")
        
        print(f"Total size: {total_size / (1024*1024):.1f} MB")
        
        # Delete all models
        try:
            shutil.rmtree(cache_dir)
            print("✅ All Whisper models deleted successfully!")
            
            # Recreate empty directory
            os.makedirs(cache_dir, exist_ok=True)
            print("✅ Empty cache directory recreated")
            
        except Exception as e:
            print(f"❌ Error deleting models: {e}")
    else:
        print("No Whisper cache directory found")

if __name__ == "__main__":
    cleanup_whisper_models()
