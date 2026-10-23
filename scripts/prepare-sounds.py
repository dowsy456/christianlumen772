"""Prepare notification/call sounds. Requires Python + numpy + FFmpeg.

python scripts/prepare-sounds.py --ffmpeg /path/to/ffmpeg --source /original/mp3s
Only the trailing inaudible tail is removed; pauses within each sound are kept.
See https://ffmpeg.org/ffmpeg-filters.html#loudnorm for the normalization filter.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tempfile
import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument('--ffmpeg', default='ffmpeg')
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'assets' / 'sounds')
parser.add_argument('--names', nargs='+', default=['Message', 'Ping', 'Ringing', 'Called', 'JoinCall', 'LeaveCall', 'StartScreen', 'EndScreen', 'StartWatching', 'StopWatching'])
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
rate = 48000

def run(arguments):
    return subprocess.run([args.ffmpeg, '-hide_banner', '-nostdin', *arguments], check=True, capture_output=True)

def measure(file):
    # EBU loudness needs a 400 ms analysis window even for a very short beep.
    result = run(['-i', str(file), '-af', 'apad=pad_dur=0.5,loudnorm=I=-18:TP=-4:LRA=7:print_format=json', '-f', 'null', '-'])
    return json.loads(re.findall(r'\{[^{}]*"input_i"[^{}]*\}', result.stderr.decode())[-1])

report_path = args.output / 'processing-report.json'
previous = json.loads(report_path.read_text(encoding='utf-8')) if report_path.exists() else {}
results = [entry for entry in previous.get('sounds', []) if Path(entry['file']).stem not in args.names]
with tempfile.TemporaryDirectory() as temporary:
    for name in args.names:
        if not re.fullmatch(r'[A-Za-z]+', name):
            raise ValueError('Sound names must contain letters only')
        source = args.source / (name + '.mp3')
        raw = run(['-i', str(source), '-f', 'f32le', '-ac', '2', '-ar', str(rate), '-']).stdout
        samples = np.frombuffer(raw, dtype='<f4').reshape(-1, 2)
        audible = np.flatnonzero(np.max(np.abs(samples), axis=1) > 10 ** (-55 / 20))
        if not len(audible):
            raise ValueError(f'{name}: no audible samples')
        end = min(len(samples), int(audible[-1]) + 1 + int(rate * .008))
        duration = end / rate
        trimmed = Path(temporary) / (name + '.wav')
        # A tiny fade prevents discontinuities at the end and at loop boundaries.
        run(['-y', '-i', str(source), '-af', f'atrim=end={duration:.6f},afade=t=out:st={max(0,duration-.008):.6f}:d=0.008', '-ar', str(rate), '-ac', '2', '-c:a', 'pcm_f32le', str(trimmed)])
        stats = measure(trimmed)
        normalization = ('apad=pad_dur=0.5,loudnorm=I=-18:TP=-4:LRA=7:linear=true:'
            f'measured_I={stats["input_i"]}:measured_TP={stats["input_tp"]}:'
            f'measured_LRA={stats["input_lra"]}:measured_thresh={stats["input_thresh"]}:'
            f'offset={stats["target_offset"]},atrim=end={duration:.6f}')
        output = args.output / (name + '.mp3')
        run(['-y', '-i', str(trimmed), '-af', normalization, '-ar', str(rate), '-c:a', 'libmp3lame', '-b:a', '192k', '-map_metadata', '-1', str(output)])
        final = measure(output)
        entry = {'file': output.name, 'originalSeconds': round(len(samples) / rate, 4),
            'trimmedSeconds': round(duration, 4), 'removedTailSeconds': round((len(samples)-end)/rate, 4),
            'integratedLUFS': float(final['input_i']), 'truePeakDBTP': float(final['input_tp'])}
        results.append(entry)
        print(json.dumps(entry))
report = {'targetLUFS': -18, 'truePeakCeilingDBTP': -4, 'tailThresholdDBFS': -55, 'sounds': results}
(args.output / 'processing-report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
