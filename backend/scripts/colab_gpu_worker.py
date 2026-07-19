import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

"""
backend/scripts/colab_gpu_worker.py

Remote GPU worker for the "offload Demucs + Wav2Lip to a free GPU" mitigation from the
original architecture proposal. Runs INSIDE a Google Colab (free T4) or Kaggle Notebook
(free T4/P100) GPU runtime, not on your laptop. Your laptop's Node backend talks to this
over HTTP via services/gpuOffloadClient.js.

============================== ONE-TIME NOTEBOOK SETUP ==============================
Paste this into a Colab notebook cell (Runtime > Change runtime type > GPU), or a Kaggle
Notebook with GPU accelerator enabled, then run it:

    !pip install -q fastapi "uvicorn[standard]" pyngrok python-multipart
    !pip install -q -U demucs
    !git clone https://github.com/Rudrabha/Wav2Lip.git
    !pip install -q -r Wav2Lip/requirements.txt
    # Wav2Lip checkpoint is license-gated (BBC LRS2 data) - download it yourself and
    # upload to Wav2Lip/checkpoints/wav2lip_gan.pth in the Colab file browser, e.g. from
    # https://huggingface.co/Nekochu/Wav2Lip/blob/main/wav2lip_gan.pth
    # (This manual step cannot be automated here - see the earlier gap analysis: Wav2Lip's
    # checkpoint is exactly the "requires your explicit action given license terms" item.)

    from pyngrok import ngrok
    ngrok.set_auth_token("YOUR_NGROK_TOKEN")  # free at https://dashboard.ngrok.com

    # Upload this file (colab_gpu_worker.py) to the Colab/Kaggle filesystem, then:
    import subprocess, time
    server = subprocess.Popen(["uvicorn", "colab_gpu_worker:app", "--host", "0.0.0.0", "--port", "8000"])
    time.sleep(3)
    public_url = ngrok.connect(8000)
    print(f"GPU_OFFLOAD_URL={public_url}")
    # Copy that URL into your laptop's .env as GPU_OFFLOAD_URL=<public_url>

The notebook session (and this tunnel) dies after Colab's ~12hr free-tier limit or on
disconnect - that's a genuine limitation of the free tier, not this code; the Node client
(gpuOffloadClient.js) detects an unreachable/dead tunnel via its health check and falls
back to local CPU processing automatically, so a dropped Colab session degrades the
pipeline back to its current behavior rather than breaking it.
=======================================================================================
"""

import base64
import os
import shutil
import subprocess
import tempfile
import traceback

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="BhashaSetu GPU Offload Worker")


@app.get("/health")
def health():
    try:
        import torch
        gpu_available = torch.cuda.is_available()
        gpu_name = torch.cuda.get_device_name(0) if gpu_available else None
    except Exception:
        gpu_available = False
        gpu_name = None
    return {"status": "ok", "gpu_available": gpu_available, "gpu_name": gpu_name}


# ===================== DEMUCS (VOCAL/BGM SEPARATION) =====================

class DemucsRequest(BaseModel):
    audio_b64: str
    filename: str = "audio.wav"
    quality: str = "fast"  # "fast" -> mdx_extra_q, "high" -> htdemucs


@app.post("/demucs")
def demucs_endpoint(req: DemucsRequest):
    workdir = tempfile.mkdtemp(prefix="demucs_job_")
    try:
        audio_path = os.path.join(workdir, req.filename)
        with open(audio_path, "wb") as f:
            f.write(base64.b64decode(req.audio_b64))

        model = "mdx_extra_q" if req.quality == "fast" else "htdemucs"
        output_dir = os.path.join(workdir, "out")
        cmd = [
            "python", "-m", "demucs",
            "-n", model,
            "--two-stems", "vocals",
            "-o", output_dir,
            audio_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        if result.returncode != 0:
            raise RuntimeError(f"Demucs failed: {result.stderr[-2000:]}")

        stem = os.path.splitext(os.path.basename(audio_path))[0]
        stem_dir = os.path.join(output_dir, model, stem)
        vocals_path = os.path.join(stem_dir, "vocals.wav")
        bgm_path = os.path.join(stem_dir, "no_vocals.wav")

        if not os.path.exists(vocals_path) or not os.path.exists(bgm_path):
            raise RuntimeError(f"Demucs did not produce expected stems in {stem_dir}")

        with open(vocals_path, "rb") as f:
            vocals_b64 = base64.b64encode(f.read()).decode("utf-8")
        with open(bgm_path, "rb") as f:
            bgm_b64 = base64.b64encode(f.read()).decode("utf-8")

        return {"success": True, "vocals_b64": vocals_b64, "bgm_b64": bgm_b64}

    except Exception as e:
        traceback.print_exc()
        return {"success": False, "error": str(e)}
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


# ===================== WAV2LIP (LIP SYNC) =====================

class Wav2LipRequest(BaseModel):
    video_b64: str
    video_filename: str = "video.mp4"
    audio_b64: str
    audio_filename: str = "audio.wav"


@app.post("/wav2lip")
def wav2lip_endpoint(req: Wav2LipRequest):
    workdir = tempfile.mkdtemp(prefix="wav2lip_job_")
    try:
        video_path = os.path.join(workdir, req.video_filename)
        audio_path = os.path.join(workdir, req.audio_filename)
        output_path = os.path.join(workdir, "result.mp4")

        with open(video_path, "wb") as f:
            f.write(base64.b64decode(req.video_b64))
        with open(audio_path, "wb") as f:
            f.write(base64.b64decode(req.audio_b64))

        wav2lip_dir = os.environ.get("WAV2LIP_PATH", "./Wav2Lip")
        checkpoint_path = os.path.join(wav2lip_dir, "checkpoints", "wav2lip_gan.pth")
        if not os.path.exists(checkpoint_path):
            raise RuntimeError(
                f"Wav2Lip checkpoint not found at {checkpoint_path}. Upload it to the "
                f"notebook filesystem first (see the setup docstring at the top of this file)."
            )

        # On a real GPU runtime these batch sizes can be much larger than the CPU
        # fallback values used in lipSyncService.js - this is the whole point of offloading.
        cmd = [
            "python", os.path.join(wav2lip_dir, "inference.py"),
            "--checkpoint_path", checkpoint_path,
            "--face", video_path,
            "--audio", audio_path,
            "--outfile", output_path,
            "--fps", "25",
            "--pads", "0", "10", "0", "0",
            "--face_det_batch_size", "16",
            "--wav2lip_batch_size", "128",
            "--resize_factor", "1",
            "--nosmooth"
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=580)
        if result.returncode != 0:
            raise RuntimeError(f"Wav2Lip failed: {result.stderr[-2000:]}")

        if not os.path.exists(output_path):
            raise RuntimeError("Wav2Lip did not produce an output file")

        with open(output_path, "rb") as f:
            output_b64 = base64.b64encode(f.read()).decode("utf-8")

        return {"success": True, "output_b64": output_b64}

    except Exception as e:
        traceback.print_exc()
        return {"success": False, "error": str(e)}
    finally:
        shutil.rmtree(workdir, ignore_errors=True)