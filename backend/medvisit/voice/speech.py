"""Small, objective capture measurements; never retain raw microphone samples."""
import math
import struct


class SpeechEvidence:
    def __init__(self):
        self.frames = []

    def observe(self, pcm: bytes, *, playing=None, muted=False):
        samples = struct.unpack("<320h", pcm)
        power = math.sumprod(samples, samples) / len(samples)
        self.frames.append((power, playing, muted))

    def describe(self, start, end) -> dict:
        if any(isinstance(t, bool) or not isinstance(t, (int, float)) or not math.isfinite(t) for t in (start, end)):
            return {"available": False}
        if not 0 <= start < end <= len(self.frames) * 20 + 200:
            return {"available": False}
        frames = self.frames[int(start // 20):int(math.ceil(end / 20))]
        audible = [power for power, _, muted in frames if not muted]
        if not audible:
            return {"available": False}
        def db(power):
            return round(10 * math.log10(max(power, 1) / 32768**2), 1)
        return {
            "available": True, "start_ms": start, "end_ms": end,
            "duration_ms": end - start,
            "rms_dbfs": db(sum(audible) / len(audible)),
            "peak_frame_dbfs": db(max(audible)),
            # Playback is client telemetry, not proof that a person interrupted another.
            "playback_overlap_ms": sum(20 for _, playing, muted in frames if playing and not muted),
            "playback_observed": any(playing is not None for _, playing, _ in frames),
            "tone_audio_assessed": False,
        }
