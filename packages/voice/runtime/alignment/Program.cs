using System.Text;
using System.Text.Json;
using Arke.LocalAlignment;

// One bounded stdin request per owned helper process. No HTTP listener, credentials,
// world access or recording files; the speech service retains its native reservation.
Console.OutputEncoding = new UTF8Encoding(false);
var json = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
object result;
try {
    if (args is ["--self-test"]) {
        AlignmentChecks.Run();
        result = new { status = 200, checks = "passed" };
    } else {
        if (args is not ["--model", var modelPath] || !Path.IsPathFullyQualified(modelPath)) throw new SidecarUnavailableException("The verified alignment model is unavailable.");
        using var stop = new CancellationTokenSource(TimeSpan.FromMinutes(5));
        using var input = Console.OpenStandardInput();
        using var bytes = new MemoryStream();
        var buffer = new byte[65536];
        while (await input.ReadAsync(buffer, stop.Token) is var count && count > 0) {
            if (bytes.Length + count > 600L * 16000 * 2) throw new WordTimingRejectedException("Invalid audio duration.");
            await bytes.WriteAsync(buffer.AsMemory(0, count), stop.Token);
        }
        await using var engine = new NativeWordTranscriber();
        var heard = await engine.TranscribeAsync(modelPath, bytes.ToArray(), stop.Token);
        if (heard.Words.Count == 0 || heard.Words.Count > 20000 || heard.Text.Length > 64000)
            throw new WordTimingRejectedException("The recognizer returned text without usable word timings.");
        result = new { status = 200, data = heard };
    }
} catch (WordTimingRejectedException error) {
    result = new { status = 422, detail = error.Message };
} catch (Exception) {
    if (args is ["--self-test"]) Environment.ExitCode = 1;
    // Native exception details can contain the model path or transcript.
    result = new { status = 503, detail = "Local acoustic word alignment is unavailable." };
}
Console.WriteLine(JsonSerializer.Serialize(result, json));

internal static class AlignmentChecks {
    public static void Run() {
        static void Check(bool value) { if (!value) throw new Exception("Alignment check failed."); }
        static void Reject(Action action) { try { action(); } catch (WordTimingRejectedException) { return; } throw new Exception("Expected alignment refusal."); }
        var valid = new[] { new NativeWordTranscriber.MeasuredToken(" Hello", 0, .3, .9), new NativeWordTranscriber.MeasuredToken(" world.", .4, .8, .8) };
        var words = NativeWordTranscriber.ComposeWords(valid, 1);
        Check(words.Count == 2 && words[1].Text == "world." && words[1].Probability == .8);
        Reject(() => NativeWordTranscriber.ComposeWords([new("two words", 0, 1, .9)], 1));
        Reject(() => NativeWordTranscriber.ComposeWords([new(" x", 0, 0, .9)], 1));
        Reject(() => NativeWordTranscriber.ComposeWords([new(" x", 0, 2, .9)], 1));
        Reject(() => NativeWordTranscriber.ComposeWords([new(" x", double.NaN, 1, .9)], 1));
        Reject(() => NativeWordTranscriber.ComposeWords([new(" x", 0, 1, 1.1)], 1));
        Reject(() => NativeWordTranscriber.ComposeWords([new(" x", 0, .8, .9), new(" y", .7, 1, .9)], 1));
        var loud = Enumerable.Repeat(.1f, 60 * 16000).ToArray();
        Array.Clear(loud, 20 * 16000, 4800); Array.Clear(loud, 40 * 16000, 4800);
        var windows = NativeWordTranscriber.AlignmentWindows(loud);
        Check(windows.Count == 3 && windows.All(window => window.Length <= 28 * 16000));
        Reject(() => NativeWordTranscriber.AlignmentWindows(Enumerable.Repeat(.1f, 40 * 16000).ToArray()));
        var sample = Enumerable.Repeat(.1f, 2 * 16000).ToArray(); Array.Clear(sample, 12800, 8000);
        var trimmed = NativeWordTranscriber.TrimAtAcousticPause([new("word", .2, 2, .9)], sample);
        Check(trimmed[0].EndSec == .8);
        try { NativeWordTranscriber.AlignmentHeads(new string('0', 64)); throw new Exception("Expected model refusal."); }
        catch (SidecarUnavailableException) { }
    }
}
