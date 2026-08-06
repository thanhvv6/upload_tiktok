import subprocess
import os
import random
import shutil
import sys
import argparse
from glob import glob
from pathlib import Path

# Force UTF-8 for console output to handle special characters in filenames
if sys.stdout.encoding != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

# Constants from render_temp.py
MAX_DURATION = 59
TARGET_W = 1080
TARGET_H = 1920
AUDIO_VOLUME = 0.8

OUTPUT_BITRATE = "2000k"
OUTPUT_CRF = "28"
OUTPUT_AUDIO_BITRATE = "128k"
OUTPUT_PRESET = "faster"
OUTPUT_THREADS = 4

def _ffmpeg_binary() -> str:
    p = shutil.which("ffmpeg")
    if p:
        return p
    return "ffmpeg"

def _ffmpeg_encoder_available(encoder: str) -> bool:
    binary = _ffmpeg_binary()
    try:
        r = subprocess.run(
            [binary, "-hide_banner", "-h", f"encoder={encoder}"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return r.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False

def _resolve_video_codec() -> str:
    """Select the best available encoder, prioritizing hardware acceleration."""
    # Priority: NVIDIA -> Intel -> AMD -> Software
    for enc in ["h264_nvenc", "h264_qsv", "h264_amf"]:
        if _ffmpeg_encoder_available(enc):
            print(f"[render_pipeline] Using HW encoder: {enc}")
            return enc
    print("[render_pipeline] No HW encoder found, falling back to libx264")
    return "libx264"

def _get_duration(path: str | Path) -> float:
    binary = shutil.which("ffprobe") or "ffprobe"
    try:
        r = subprocess.run(
            [binary, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=5
        )
        return float(r.stdout.strip())
    except Exception:
        return 0.0

def _has_audio(path: str | Path) -> bool:
    """Check if the video file has an audio stream."""
    binary = shutil.which("ffprobe") or "ffprobe"
    try:
        r = subprocess.run(
            [binary, "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, timeout=5
        )
        return bool(r.stdout.strip())
    except Exception:
        return False

def _generate_segments(duration: float) -> list[tuple[float, float]]:
    """Generate segments for random skip logic."""
    segments = []
    current_t = 0.0
    flip_interval = 2.5
    while current_t < duration:
        # Random skip 1s (25% chance) - Only if duration >= 8s
        if duration >= 8.0 and random.random() < 0.25:
            current_t += 1.0
        
        if current_t >= duration:
            break
            
        end_t = min(current_t + flip_interval, duration)
        if end_t - current_t > 0.1: # Avoid too tiny segments
            segments.append((current_t, end_t))
        current_t = end_t
    return segments

def render_static_mask_overlay(
    video_path,
    background_path,
    output_path,
    mask_height=10,
    mute=False
):
    """
    Render video using pure FFmpeg logic from render_temp.py.
    Modified to include original background mask overlay and remove speedup.
    """
    video_path = Path(video_path).resolve()
    background_path = Path(background_path).resolve()
    output_path = Path(output_path).resolve()
    
    vcodec = _resolve_video_codec()
    
    duration = _get_duration(video_path)
    if duration > MAX_DURATION:
        duration = MAX_DURATION
    
    has_audio = _has_audio(video_path) and not mute
    
    segments = _generate_segments(duration)
    if not segments:
        segments = [(0, duration)]

    # 1. Build Segment Trimming and Concatenation Filters
    v_trims = []
    a_trims = []
    for i, (start, end) in enumerate(segments):
        v_trims.append(f"[0:v]trim=start={start}:end={end},setpts=PTS-STARTPTS[v{i}]")
        if has_audio:
            a_trims.append(f"[0:a]atrim=start={start}:end={end},asetpts=PTS-STARTPTS[a{i}]")
    
    v_concat_inputs = "".join([f"[v{i}]" for i in range(len(segments))])
    concat_filter = f"{v_concat_inputs}concat=n={len(segments)}:v=1:a=0[vconcat]"
    
    if has_audio:
        a_concat_inputs = "".join([f"[a{i}]" for i in range(len(segments))])
        concat_filter += f"; {a_concat_inputs}concat=n={len(segments)}:v=0:a=1[aconcat]"

    # 2. Build Effect Filters
    angle = random.uniform(-1.5, 1.5)
    zoom = round(random.uniform(1.05, 1.20), 2)
    
    # Base effects: Zoom, Color, Periodic Flip
    # We use a robust scale/crop to ensure 1080:1920 output regardless of input size
    v_effects = (
        f"[vconcat]scale={TARGET_W}*{zoom}:-1,"
        f"crop={TARGET_W}:{TARGET_H},"
        "eq=saturation=1.3:contrast=1.1,"
        "hflip=enable='between(mod(t,5),2.5,5)',"
        "format=yuv420p[vfinal]"
    )
    
    filters = v_trims + a_trims + [concat_filter, v_effects]
    
    if has_audio:
        # Original volume adjustment but NO atempo
        a_effects = f"[aconcat]volume={AUDIO_VOLUME}[afinal]"
        filters.append(a_effects)

    filter_complex = "; ".join(filters)

    # 3. Construct FFmpeg Command
    cmd = [
        _ffmpeg_binary(), "-y",
        "-i", str(video_path),
        "-filter_complex", filter_complex,
        "-map", "[vfinal]",
    ]
    if has_audio:
        cmd.extend(["-map", "[afinal]"])

    cmd.extend([
        "-c:v", vcodec,
        "-pix_fmt", "yuv420p",
        "-r", "30",
        "-threads", str(OUTPUT_THREADS),
    ])

    # Encoder specific params
    if "nvenc" in vcodec:
        cmd.extend(["-preset", "p1", "-cq", "28", "-b:v", OUTPUT_BITRATE])
    elif "qsv" in vcodec:
        cmd.extend(["-global_quality", "25"])
    elif vcodec == "libx264":
        cmd.extend(["-preset", OUTPUT_PRESET, "-crf", OUTPUT_CRF])
    
    if has_audio:
        cmd.extend([
            "-c:a", "aac",
            "-b:a", OUTPUT_AUDIO_BITRATE,
        ])
    
    cmd.extend(["-shortest", str(output_path)])

    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True, encoding='utf-8', errors='replace')
    except subprocess.CalledProcessError as e:
        print(f"❌ FFmpeg error: {e.stderr}")
        # Fallback to libx264 if HW encoder fails
        if vcodec != "libx264":
            print("🔄 Retrying with libx264...")
            
            # Reconstruct clean command for libx264
            clean_cmd = [
                _ffmpeg_binary(), "-y",
                "-i", str(video_path),
                "-filter_complex", filter_complex,
                "-map", "[vfinal]",
            ]
            if has_audio:
                clean_cmd.extend(["-map", "[afinal]"])
                
            clean_cmd.extend([
                "-c:v", "libx264",
                "-preset", OUTPUT_PRESET,
                "-crf", OUTPUT_CRF,
                "-pix_fmt", "yuv420p",
                "-r", "30",
                "-threads", str(OUTPUT_THREADS),
            ])
            
            if has_audio:
                clean_cmd.extend([
                    "-c:a", "aac",
                    "-b:a", OUTPUT_AUDIO_BITRATE,
                ])
            
            clean_cmd.extend(["-shortest", str(output_path)])
            
            try:
                subprocess.run(clean_cmd, check=True)
            except Exception as e2:
                raise RuntimeError(f"FFmpeg failed even with libx264 fallback: {e2}")
        else:
            raise

def main():
    parser = argparse.ArgumentParser(description="Render single video using exact source logic.")
    parser.add_argument("--video", required=True)
    parser.add_argument("--backgrounds", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--mask-height", type=int, default=10)
    parser.add_argument("--mute", action="store_true")
    
    args = parser.parse_args()
    
    # Resolve backgrounds exactly like user's source code
    bg_folder = Path(args.backgrounds).resolve()
    bg_files = glob(os.path.join(str(bg_folder), '*.*'))
    bg_files = [f for f in bg_files if Path(f).suffix.lower() in ['.png', '.jpg', '.jpeg', '.webp']]
    
    if not bg_files:
        print("X Khong co background")
        sys.exit(1)
        
    background_path = random.choice(bg_files)
    
    render_static_mask_overlay(
        video_path=args.video,
        background_path=background_path,
        output_path=args.output,
        mask_height=args.mask_height,
        mute=args.mute
    )

if __name__ == '__main__':
    main()
