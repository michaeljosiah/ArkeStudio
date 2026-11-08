"""Exercise the real server over HTTP + WebRTC using a synthetic microphone.

Runs real cloud inference. Does not access the user's microphone or speakers.
Writes evidence only when --output is supplied, outside the repository by default.
"""
import argparse
import asyncio
from fractions import Fraction
import json
from pathlib import Path
import time
import wave

from aiortc import AudioStreamTrack, RTCPeerConnection, RTCSessionDescription, RTCConfiguration
import aiohttp
import av
import numpy as np
import soxr


class Microphone(AudioStreamTrack):
    def __init__(self):
        super().__init__()
        self.samples = np.zeros(0, dtype=np.int16)
        self.position = 0
        self.clock = None

    def play(self, path):
        with wave.open(str(path), "rb") as audio:
            samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2").astype(np.float32)
            self.samples = soxr.resample(samples, audio.getframerate(), 48000).astype(np.int16)

    async def recv(self):
        if self.clock is None:
            self.clock = time.perf_counter()
        await asyncio.sleep(max(0, self.clock + self.position / 48000 - time.perf_counter()))
        samples = np.zeros(960, dtype=np.int16)
        count = min(960, len(self.samples))
        samples[:count] = self.samples[:count]
        self.samples = self.samples[count:]
        frame = av.AudioFrame.from_ndarray(samples.reshape(1, -1), format="s16", layout="mono")
        frame.sample_rate, frame.pts, frame.time_base = 48000, self.position, Fraction(1, 48000)
        self.position += 960
        return frame


async def run(args):
    origin = args.url.rstrip("/")
    events, audio = [], []
    pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    mic = Microphone()
    pc.addTrack(mic)
    ready = asyncio.Event()
    channel = pc.createDataChannel("rtvi-ai")
    channel.on("open", lambda: channel.send(json.dumps({"label": "rtvi-ai", "type": "client-ready", "id": "smoke", "data": {"version": "1.0.0", "about": {"library": "arke-voice-lab-smoke", "library_version": "0.1"}}})))
    @channel.on("message")
    def data(message):
        value = json.loads(message)
        if value.get("type") == "bot-ready":
            ready.set()

    consumers = []
    @pc.on("track")
    def track_started(track):
        async def consume():
            resampler = av.AudioResampler(format="s16", layout="mono", rate=24000)
            try:
                while True:
                    for frame in resampler.resample(await track.recv()):
                        audio.append(frame.to_ndarray().tobytes())
            except Exception:
                pass
        consumers.append(asyncio.create_task(consume()))

    async with aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True)) as http:
        async def request(path, method="GET", value=None):
            async with http.request(method, origin + path, json=value) as response:
                text = await response.text()
                if response.status >= 400:
                    raise RuntimeError(f"HTTP {response.status}: {text[:300]}")
                return json.loads(text) if "json" in response.headers.get("Content-Type", "") else text
        await request("/")
        config = await request("/api/config")
        current = await request("/api/session", "POST", {"model": args.model or config["defaultModel"], "voice": "bf_emma", "delay": 20})
        sid = current["id"]
        async def observe():
            async with http.get(origin + f"/api/events/{sid}") as response:
                async for line in response.content:
                    if line.startswith(b"data: "):
                        event = json.loads(line[6:])
                        events.append(event)
                        if event["type"] not in ("assistant-delta", "tts-ready"):
                            print(json.dumps(event), flush=True)
                        if event["type"] == "assistant-end":
                            print("REPLY: " + "".join(e.get("text", "") for e in events if e["type"] == "assistant-delta")[-1500:], flush=True)
        observation = asyncio.create_task(observe())
        async def until(predicate, timeout=90):
            async with asyncio.timeout(timeout):
                while not predicate():
                    errors = [event for event in events if event["type"] == "error"]
                    if errors:
                        raise RuntimeError(errors[-1]["message"])
                    await asyncio.sleep(.1)
        try:
            offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            answer = await request(f"/api/offer/{sid}", "POST", {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type})
            await pc.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type=answer["type"]))
            await asyncio.wait_for(ready.wait(), 30)
            print("WebRTC and RTVI ready", flush=True)
            await request(f"/api/text/{sid}", "POST", {"text": "Hello. In one short sentence, tell me you are ready for our voice test."})
            await until(lambda: any(e["type"] == "assistant-end" for e in events) and any(np.max(np.abs(np.frombuffer(chunk, dtype="<i2").astype(np.int32))) > 200 for chunk in audio))
            print("Cloud response and received WebRTC audio verified", flush=True)
            if args.background:
                count = sum(e["type"] == "assistant-end" for e in events)
                await request(f"/api/text/{sid}", "POST", {"text": "Use the background task tool to think of three names for a floating city, then keep talking with me. Do not answer the naming task yourself yet."})
                await until(lambda: any(e["type"] == "background-start" for e in events) and sum(e["type"] == "assistant-end" for e in events) > count)
                count += 1
                await request(f"/api/text/{sid}", "POST", {"text": "While that runs, what colour is the sky on a clear day? Answer briefly."})
                await until(lambda: sum(e["type"] == "assistant-end" for e in events) > count)
                assert not any(e["type"] == "background-complete" for e in events), "Background finished before the concurrent conversation was tested"
                await until(lambda: any(e["type"] == "background-complete" for e in events))
                await until(lambda: sum(e["type"] == "assistant-end" for e in events) > count + 1)
                print("Background tool + concurrent conversation + later spoken result verified", flush=True)
            if args.microphone:
                # Wait for actual output speech, then inject a second speaker. This
                # exercises playback interruption, not only cancellation during inference.
                latest_end = max(e["at"] for e in events if e["type"] == "assistant-end")
                await until(lambda: any(e["type"] == "bot-speaking" and e.get("active") and e["at"] >= latest_end for e in events))
                count = sum(e["type"] == "transcript" and not e.get("typed") for e in events)
                mic_start = time.time() * 1000
                mic.play(args.microphone)
                await until(lambda: sum(e["type"] == "transcript" and not e.get("typed") for e in events) > count)
                assert any(e["type"] == "interrupted" and e["at"] >= mic_start for e in events), "Microphone did not interrupt playback"
                count = sum(e["type"] == "assistant-end" for e in events)
                await until(lambda: sum(e["type"] == "assistant-end" for e in events) > count)
                await until(lambda: any(e["type"] == "bot-speaking" and e.get("active") and e["at"] > mic_start for e in events))
                print("Synthetic microphone -> local Whisper -> OpenCode -> local Kokoro verified", flush=True)
            if args.output:
                args.output.mkdir(parents=True, exist_ok=True)
                (args.output / "events.json").write_text(json.dumps({"config": config, "events": events}, indent=2), encoding="utf-8")
                with wave.open(str(args.output / "received-audio.wav"), "wb") as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(24000)
                    wav.writeframes(b"".join(audio))
            print("PASS", flush=True)
        finally:
            if args.output:
                args.output.mkdir(parents=True, exist_ok=True)
                (args.output / "events.json").write_text(json.dumps({"config": config, "events": events}, indent=2), encoding="utf-8")
            await pc.close()
            for consumer in consumers:
                consumer.cancel()
            await asyncio.gather(*consumers, return_exceptions=True)
            await request(f"/api/session/{sid}", "DELETE")
            observation.cancel()
            await asyncio.gather(observation, return_exceptions=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:9075")
    parser.add_argument("--model")
    parser.add_argument("--background", action="store_true")
    parser.add_argument("--microphone", type=Path)
    parser.add_argument("--output", type=Path)
    asyncio.run(run(parser.parse_args()))
