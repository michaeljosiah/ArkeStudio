import asyncio
import base64
import json
from types import SimpleNamespace

import pytest

from live import LivePeer, LiveSerializer, SharedSTT
from pipecat.frames.frames import InputAudioRawFrame, InterruptionFrame, OutputAudioRawFrame, TTSSpeakFrame


@pytest.mark.asyncio
async def test_scoped_turn_queue_and_bounded_audio():
    sent = []
    async def send_text(value):
        sent.append(json.loads(value))
    peer = LivePeer(SimpleNamespace(send_text=send_text))
    serializer = LiveSerializer(peer)
    assert isinstance(await serializer.deserialize(json.dumps({"type": "audio", "audio": base64.b64encode(b"\0\0" * 640).decode()})), InputAudioRawFrame)
    for bad in ({"type": "audio", "audio": "invalid!"}, {"type": "audio", "audio": base64.b64encode(b"odd").decode()}, {"type": "not-authorized"}):
        with pytest.raises(ValueError):
            await serializer.deserialize(json.dumps(bad))
    assert isinstance(await serializer.deserialize('{"type":"interrupt"}'), InterruptionFrame)
    peer.turn, peer.pending = "current", asyncio.Queue(maxsize=2)
    peer.receive({"type": "delta", "turn": "stopped", "text": "must not speak"})
    assert peer.pending.empty()
    peer.receive({"type": "delta", "turn": "current", "text": "Hello."})
    peer.receive({"type": "done", "turn": "current"})
    with pytest.raises(ValueError):
        peer.receive({"type": "delta", "turn": "current", "text": "overflow"})
    await peer.disconnect()  # even a full queue can always be stopped
    assert await peer.pending.get() is None
    assert SharedSTT.wants_wav_segments.fget(None) is False
    assert await serializer.serialize(OutputAudioRawFrame(b"\0\0", 24000, 1)) is None
    assert not sent  # disconnected owners never receive audio


@pytest.mark.asyncio
async def test_output_audio_and_message_rate_admission():
    sent = []
    async def send_text(value):
        sent.append(json.loads(value))
    peer = LivePeer(SimpleNamespace(send_text=send_text))
    serializer = LiveSerializer(peer)
    await serializer.serialize(OutputAudioRawFrame(b"\x01\0", 24000, 1))
    assert sent == [{"type": "audio", "audio": "AQA="}]
    frame = {"type": "audio", "audio": "AAA="}
    for _ in range(120):
        peer.receive(frame)
    with pytest.raises(ValueError):
        peer.receive(frame)

def test_silence_does_not_consume_the_speech_segment_bound():
    peer = LivePeer(None)
    frame = {"type": "audio", "audio": base64.b64encode(b"\0" * 1280).decode()}
    for _ in range(1600):
        peer.frames = 0  # emulate the existing independent real-time admission window
        peer.receive(frame)
    assert peer.audio_bytes == 0
    peer.speaking = True
    for _ in range(1500):
        peer.frames = 0
        peer.receive(frame)
    peer.frames = 0
    with pytest.raises(ValueError):
        peer.receive(frame)


@pytest.mark.asyncio
async def test_background_delivery_cannot_overtake_pending_speech_or_replay_a_commit():
    sent = []
    async def send_text(value):
        sent.append(json.loads(value))
    peer = LivePeer(SimpleNamespace(send_text=send_text))
    serializer = LiveSerializer(peer)
    identity = "vop_01J00000000000000000000000"
    offer = json.dumps({"type": "notification-offer", "id": identity})
    commit = json.dumps({"type": "notification-commit", "id": identity, "text": "The source lookup is ready."})
    peer.last_activity = 0
    peer.input_pending = True
    assert await serializer.deserialize(offer) is None
    assert sent[-1]["type"] == "notification-busy"
    peer.input_pending = False
    await serializer.deserialize(offer)
    assert sent[-1]["type"] == "notification-ready"
    peer.speaking = True  # The user wins a race after the host recorded its speech attempt.
    assert await serializer.deserialize(commit) is None
    peer.speaking = False
    await serializer.deserialize(offer)
    frame = await serializer.deserialize(commit)
    assert isinstance(frame, TTSSpeakFrame) and frame.append_to_context is False
    assert await serializer.deserialize(commit) is None
    assert peer.bot_speaking is True
