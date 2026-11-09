namespace Arke.LocalAlignment;

internal sealed record WordTimingEngine(string Id, string Version, string Model);
internal sealed record TimedWord(string Text, double StartSec, double EndSec, double Probability);
internal sealed record WordTimingResponse(string Text, double Seconds, WordTimingEngine Engine, IReadOnlyList<TimedWord> Words);
internal sealed class WordTimingRejectedException(string message) : Exception(message);
internal sealed class SidecarUnavailableException(string message) : Exception(message);
