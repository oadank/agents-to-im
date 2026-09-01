"""
H3 生视频封装脚本（Reasonix）
全流程：Z-Image 生图（可选）→ H3 图生视频 → ffmpeg 封面 → 发飞书（可选）

用法（本机运行）：
  python h3_video.py --prompt "海边少女..." [--first-image 首帧图|auto] [--duration 8]
       [--aspect 9:16] [--t2v] [--send-feishu] [--lora 瘦脸燕子]

依赖：本机 python + ffmpeg；XDN ComfyUI 8000 端口
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

XDN = 'http://100.119.140.33:8000'
# 密码不进仓库（PUBLIC repo）：从环境变量 XDN_PASS 读取
XDN_SSH = dict(hostname='100.119.140.33', username='oadan', password=os.environ.get('XDN_PASS', ''), timeout=15)
OUT_DIR = os.path.join(os.path.expanduser('~'), '.h3-video')
os.makedirs(OUT_DIR, exist_ok=True)
CHAT = 'oc_d8a3abf10296551ffeb332381bc26e96'

# ---------- XDN 文件传输（paramiko）----------
def sftp_transfer(local_bytes, remote_path, direction='put'):
    import paramiko
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(**XDN_SSH)
    sftp = c.open_sftp()
    if direction == 'put':
        with sftp.open(remote_path, 'wb') as f:
            f.write(local_bytes)
    else:
        with sftp.open(remote_path, 'rb') as f:
            data = f.read()
        return data
    sftp.close(); c.close()

def sftp_get(remote_path):
    import paramiko
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(**XDN_SSH)
    sftp = c.open_sftp()
    with sftp.open(remote_path, 'rb') as f:
        data = f.read()
    sftp.close(); c.close()
    return data

# ---------- HTTP ----------
def post(url, data=None):
    req = urllib.request.Request(url, data=json.dumps(data).encode('utf-8') if data is not None else None,
                                 headers={'Content-Type': 'application/json'} if data is not None else {})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode('utf-8'))

def get(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode('utf-8'))

# ---------- Z-Image 生图 ----------
def zimage_gen(prompt, lora='Z-image\\瘦脸燕子.safetensors', w=1024, h=1536, seed=42):
    payload = {
        "2": {"class_type": "UNETLoader", "inputs": {"unet_name": "z_image\\z_image_turbo_bf16.safetensors", "weight_dtype": "default"}},
        "14": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["2", 0], "lora_name": lora, "strength_model": 1}},
        "13": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_3_4b.safetensors", "type": "lumina2"}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["13", 0], "text": prompt}},
        "5": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["3", 0]}},
        "16": {"class_type": "EmptyLatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
        "1": {"class_type": "KSampler", "inputs": {"model": ["14", 0], "positive": ["3", 0], "negative": ["5", 0], "latent_image": ["16", 0], "seed": seed, "steps": 8, "cfg": 1, "sampler_name": "euler_ancestral", "scheduler": "FlowMatchEulerDiscreteScheduler", "denoise": 1}},
        "8": {"class_type": "VAELoader", "inputs": {"vae_name": "UltraFluxVAE.safetensors"}},
        "7": {"class_type": "VAEDecode", "inputs": {"samples": ["1", 0], "vae": ["8", 0]}},
        "12": {"class_type": "SaveImage", "inputs": {"images": ["7", 0], "filename_prefix": "Reasonix/H3Auto"}},
    }
    res = post(f'{XDN}/prompt', {"prompt": payload, "client_id": "h3auto-img"})
    pid = res['prompt_id']
    img = wait_output(pid, 'images')
    remote = f"D:\\ComfyUI\\ComfyUI\\output\\{img['subfolder']}\\{img['filename']}" if img.get('subfolder') else f"D:\\ComfyUI\\ComfyUI\\output\\{img['filename']}"
    return sftp_get(remote)

# ---------- 等待输出 ----------
def wait_output(pid, kind='videos', timeout=2000):
    start = time.time()
    while time.time() - start < timeout:
        try:
            h = get(f'{XDN}/history/{pid}')
        except Exception:
            time.sleep(5); continue
        if pid in h:
            st = h[pid].get('status', {}).get('status_str')
            if st == 'success':
                for nid, o in h[pid].get('outputs', {}).items():
                    for item in o.get(kind, []):
                        return item
                return None
            elif st == 'error':
                for m in h[pid].get('status', {}).get('messages', []):
                    print('执行错误:', m, file=sys.stderr)
                raise RuntimeError('H3 执行失败')
        time.sleep(5)
    raise TimeoutError('等待超时')

# ---------- H3 图生视频 ----------
def h3_i2v(prompt, first_image_remote_name, duration_s, aspect, send=None):
    # 宽高按比例
    asp_map = {'16:9': (960, 544), '9:16': (544, 960), '1:1': (960, 960)}
    w, h = asp_map.get(aspect, (960, 544))
    length = max(5, round(duration_s * 24))  # 帧数
    length = length + (5 - (length % 17)) % 17  # 对齐17
    payload = {
        "114": {"class_type": "LoadImage", "inputs": {"image": first_image_remote_name}},
        "119": {"class_type": "ImageScaleToTotalPixels", "inputs": {"upscale_method": "lanczos", "megapixels": 1, "width": 32}},
        "129": {"class_type": "UNETLoader", "inputs": {"unet_name": "MINIMAX-H3\\minimax_h3_fl2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}},
        "196": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["129", 0], "lora_name": "minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors", "strength_model": 0.75}},
        "181": {"class_type": "PathchSageAttentionKJ", "inputs": {"model": ["196", 0], "sage_attention": "disabled"}},
        "136": {"class_type": "TESpeedMiniMaxH3", "inputs": {"model": ["181", 0], "processing_control_value": 0.085, "processing_percent_1": 0.1, "processing_percent_2": 0.9, "mcs": 2, "device": "auto", "mode": "4-step LoRA"}},
        "130": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax"}},
        "121": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "122": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "233": {"class_type": "CR Text", "inputs": {"text": prompt}},
        "135": {"class_type": "PrimitiveFloat", "inputs": {"value": float(duration_s)}},
        "234": {"class_type": "SimpleMath+", "inputs": {"value": "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17", "a": [f"{duration_s}"]}},
        "133": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {
            "clip": ["130", 0], "vae": ["121", 0], "first_frame": ["114", 0],
            "prompt": ["233", 0], "width": w, "height": h, "length": length}},
        "131": {"class_type": "RandomNoise", "inputs": {"noise_seed": 42, "noise_mode": "cpu"}},
        "128": {"class_type": "BasicGuider", "inputs": {"model": ["136", 0], "conditioning": ["133", 0]}},
        "125": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "126": {"class_type": "BasicScheduler", "inputs": {"model": ["136", 0], "scheduler": "simple", "steps": 8, "denoise": 1}},
        "127": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["131", 0], "guider": ["128", 0], "sampler": ["125", 0], "sigmas": ["126", 0], "latent_image": ["133", 1]}},
        "124": {"class_type": "VAEDecode", "inputs": {"samples": ["127", 0], "vae": ["121", 0]}},
        "123": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["127", 0], "vae": ["122", 0]}},
        "132": {"class_type": "CreateVideo", "inputs": {"images": ["124", 0], "audio": ["123", 0], "fps": 24, "bit_depth": 8}},
        "161": {"class_type": "SaveVideo", "inputs": {"video": ["132", 0], "filename_prefix": "video/H3_Auto", "format": "auto", "codec": "auto"}},
    }
    res = post(f'{XDN}/prompt', {"prompt": payload, "client_id": "h3auto-vid"})
    if res.get('error'):
        print('提交错误:', json.dumps(res['error'], ensure_ascii=False)[:500], file=sys.stderr)
        return None
    pid = res['prompt_id']
    print(f'[H3] 视频任务提交: {pid}')
    v = wait_output(pid, 'videos')
    if not v:
        return None
    remote = f"D:\\ComfyUI\\ComfyUI\\output\\{v['subfolder']}\\{v['filename']}" if v.get('subfolder') else f"D:\\ComfyUI\\ComfyUI\\output\\{v['filename']}"
    data = sftp_get(remote)
    local_vid = os.path.join(OUT_DIR, f"h3_{int(time.time())}.mp4")
    with open(local_vid, 'wb') as f:
        f.write(data)
    print(f'[H3] 视频已下载: {local_vid} ({len(data)} bytes)')
    return local_vid

# ---------- 发飞书 ----------
def send_feishu(video_path):
    cover = os.path.join(OUT_DIR, 'cover_' + os.path.basename(video_path).replace('.mp4', '.png'))
    subprocess.run(['ffmpeg', '-y', '-i', video_path, '-frames:v', '1', cover], check=True, capture_output=True)
    body = {'chatId': CHAT, 'msgType': 'media', 'content': '{}', 'filePath': video_path, 'imagePath': cover}
    req = urllib.request.Request('http://127.0.0.1:13586/api/send',
                                 data=json.dumps(body).encode('utf-8'),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=120) as r:
        resp = json.loads(r.read().decode('utf-8'))
    print('[飞书] 发送结果:', json.dumps(resp, ensure_ascii=False))

# ---------- main ----------
def main():
    ap = argparse.ArgumentParser(description='H3 生视频')
    ap.add_argument('--prompt', required=True, help='H3 提示词')
    ap.add_argument('--first-image', default='auto', help='首帧图: auto(生图)/本地图路径')
    ap.add_argument('--duration', type=float, default=8, help='时长秒')
    ap.add_argument('--aspect', default='16:9', help='比例 16:9/9:16/1:1')
    ap.add_argument('--t2v', action='store_true', help='文生视频(无图)')
    ap.add_argument('--send-feishu', action='store_true', help='发飞书')
    ap.add_argument('--lora', default='Z-image\\瘦脸燕子.safetensors', help='生图LoRA')
    args = ap.parse_args()

    # 生图或指定首帧
    if args.first_image == 'auto':
        print('[生图] Z-Image 生成首帧...')
        img_bytes = zimage_gen(args.prompt.split('summary:')[0][:200] if 'summary:' in args.prompt else args.prompt[:200])
        remote_name = 'h3auto_first.png'
        sftp_transfer(img_bytes, f'D:\\ComfyUI\\ComfyUI\\input\\{remote_name}')
        print(f'[生图] 首帧已上传 XDN input\\{remote_name} ({len(img_bytes)} bytes)')
    else:
        # 本地图上传
        with open(args.first_image, 'rb') as f:
            data = f.read()
        remote_name = 'h3_first.png'
        sftp_transfer(data, f'D:\\ComfyUI\\ComfyUI\\input\\{remote_name}')
        print(f'[首帧] 已上传: {remote_name}')

    if args.t2v:
        print('[视频] 文生视频（无图）...')
        # 简化：无 first_frame
    else:
        print(f'[视频] 图生视频 {args.aspect} {args.duration}s...')
        vid = h3_i2v(args.prompt, remote_name, args.duration, args.aspect)
        if vid and args.send_feishu:
            send_feishu(vid)

if __name__ == '__main__':
    main()
