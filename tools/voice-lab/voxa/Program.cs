using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.ML.OnnxRuntime;
using Voxa.Audio.Onnx;
using Voxa.Audio.SileroVad;
using Voxa.Frames;
using Voxa.Pipelines;
using Voxa.Processors;
using Voxa.Speech;
using Voxa.Speech.Kokoro;
using Voxa.Speech.WhisperCpp;
using Voxa.Transports.WebSocket;

var builder = WebApplication.CreateSlimBuilder(args);
builder.Logging.ClearProviders();
var port = int.Parse(Environment.GetEnvironmentVariable("VOXA_LAB_PORT")!);
var token = Environment.GetEnvironmentVariable("VOXA_LAB_CAPABILITY") ?? throw new Exception("Missing lab capability");
var root = Environment.GetEnvironmentVariable("VOXA_LAB_MODELS")!;
var espeak = Environment.GetEnvironmentVariable("VOXA_LAB_ESPEAK")!;
var whisper = Environment.GetEnvironmentVariable("VOXA_LAB_WHISPER")!;
var bridge = new HttpClient { BaseAddress = new Uri(Environment.GetEnvironmentVariable("VOXA_LAB_BRIDGE")!), Timeout = TimeSpan.FromSeconds(135) };
bridge.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
builder.WebHost.ConfigureKestrel(server => server.Listen(System.Net.IPAddress.Loopback, port));
var app = builder.Build();
app.Use(async (context, next) => {
    if (context.Request.Headers.Authorization != "Bearer " + token) { context.Response.StatusCode = 401; return; }
    await next(context);
});
app.UseWebSockets();
var sources = new ConcurrentDictionary<string, WebSocketAudioSource>();
var cache = new VoxaModelCache(new VoxaModelCacheOptions(Path.Combine(root, ".unused-voxa-cache"), true));
// Match the Python audition's Kokoro CPU session settings before the engine's
// shared host loads it. Both readers use the exact same model and style files.
new OnnxModelHost().Load(Path.Combine(root, "model_quantized.onnx"), OnnxDevice.Cpu,
    (options, _, _) => { options.GraphOptimizationLevel = GraphOptimizationLevel.ORT_DISABLE_ALL; options.IntraOpNumThreads = 4; });

app.MapGet("/health", () => Results.Json(new { ready = true, engine = "voxa" }));
app.MapPost("/text/{sid}", async (string sid, JsonElement body, CancellationToken ct) => {
    if (!sources.TryGetValue(sid, out var source)) return Results.NotFound();
    var text = body.GetProperty("text").GetString()!;
    if (text.Length is < 1 or > 12000) return Results.BadRequest();
    Frame frame = body.TryGetProperty("background", out var background) && background.GetBoolean()
        ? new BackgroundTaskCompletedFrame(Guid.NewGuid().ToString("N"), text)
        : new TranscriptionFrame(text, true);
    await source.IngestAsync(frame, ct);
    return Results.Ok();
});
app.Map("/voice/{sid}", async (HttpContext http, string sid) => {
    if (!http.WebSockets.IsWebSocketRequest || sources.ContainsKey(sid)) { http.Response.StatusCode = 409; return; }
    var voice = http.Request.Query["voice"].ToString();
    if (!new[] { "bf_emma", "bm_george", "af_bella", "af_nicole", "am_adam", "am_michael" }.Contains(voice)) { http.Response.StatusCode = 400; return; }
    using var socket = await http.WebSockets.AcceptWebSocketAsync();
    var source = new WebSocketAudioSource(socket, new WebSocketAudioOptions { InputSampleRate = 16000 });
    sources[sid] = source;
    var driver = new OpenCodeDriver(bridge, sid);
    var tts = new KokoroTtsEngine(new KokoroOptions {
        ModelPath = Path.Combine(root, "model_quantized.onnx"), Voice = voice,
        VoicePath = Path.Combine(root, "voices", voice + ".bin"), EspeakPath = espeak,
        EspeakDataPath = Path.Combine(Path.GetDirectoryName(espeak)!, "share"), MaxConcurrentSyntheses = 1,
    }, cache);
    var pipeline = Pipeline.Build().Source(source)
        .Then(new SileroVadProcessor(new SileroVadOptions { StopDuration = TimeSpan.FromMilliseconds(650) }))
        .Then(new LabTap(bridge, sid, "vad"))
        .Then(new SpeechToTextProcessor(new WhisperCppSttEngine(new WhisperCppOptions { ModelPath = whisper, Threads = 4 }, cache)))
        .Then(new LabTap(bridge, sid, "stt"))
        .Then(new AgentLoopProcessor(driver))
        .Then(new SentenceAggregator())
        .Then(new TextToSpeechProcessor(tts))
        .Then(new LabTap(bridge, sid, "output"))
        .Sink(new WebSocketAudioSink(socket));
    await using var runner = new PipelineRunner(pipeline, http.RequestAborted);
    try {
        await runner.StartAsync();
        await source.IngestAsync(new SessionInfoFrame(16000, 24000));
        await runner.WaitAsync();
    } catch (OperationCanceledException) { }
    finally { sources.TryRemove(sid, out _); }
});
await app.RunAsync();

sealed class OpenCodeDriver(HttpClient bridge, string sid) : IAgentTurnDriver
{
    public async IAsyncEnumerable<Frame> RunTurnAsync(VoiceTurnContext ctx, [EnumeratorCancellation] CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/internal/turn/" + sid) {
            Content = JsonContent.Create(new { text = ctx.Trigger == TurnTrigger.BackgroundResult ? ctx.BackgroundResult!.ResultText : ctx.UserText })
        };
        using var response = await bridge.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(ct));
        while (await reader.ReadLineAsync(ct) is { } line) {
            if (!line.StartsWith("data: ")) continue;
            var data = JsonDocument.Parse(line[6..]).RootElement;
            if (data.TryGetProperty("text", out var text)) yield return new LlmTextChunkFrame(text.GetString()!);
            if (data.TryGetProperty("error", out _)) throw new InvalidOperationException("OpenCode lab turn failed");
        }
    }
}

sealed class LabTap(HttpClient bridge, string sid, string stage) : FrameProcessor("LabEvidence")
{
    private bool outputStarted;
    protected override async ValueTask ProcessFrameAsync(Frame frame, CancellationToken ct)
    {
        object? evidence = (stage, frame) switch {
            ("vad", UserStartedSpeakingFrame) => new { type = "user-speaking", active = true },
            ("vad", UserStoppedSpeakingFrame) => new { type = "speech-ended" },
            ("stt", TranscriptionFrame text) when text.IsFinal => new { type = "transcript", text = text.Text },
            ("output", AudioRawFrame) when !outputStarted => new { type = "bot-speaking", active = true },
            ("output", BotStoppedSpeakingFrame) => new { type = "bot-speaking", active = false },
            ("output", InterruptionFrame) => new { type = "interrupted" },
            // Voxa's browser client also flushes on this speaking edge when
            // the LLM has finished but its generated audio is still playing.
            ("output", UserStartedSpeakingFrame) => new { type = "interrupted" },
            (_, ErrorFrame) => new { type = "error", message = "Voxa audio pipeline failed" },
            _ => null,
        };
        if (stage == "output" && frame is AudioRawFrame) outputStarted = true;
        if (stage == "output" && frame is BotStoppedSpeakingFrame or InterruptionFrame) outputStarted = false;
        if (evidence is not null) {
            using var response = await bridge.PostAsJsonAsync("/internal/event/" + sid, evidence, ct);
            response.EnsureSuccessStatusCode();
        }
        await PushFrameAsync(frame, ct);
    }
}
