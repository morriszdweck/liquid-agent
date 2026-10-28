import AVFoundation
import Foundation
import Speech

/// On-device speech in and out. Recognition is forced on-device so audio never
/// leaves the Mac.
@MainActor
final class VoiceController: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    @Published var listening = false
    @Published var speaking = false
    @Published var partial = ""
    @Published var level: Float = 0
    @Published var error: String?

    private let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var silenceTimer: Timer?
    private let synth = AVSpeechSynthesizer()
    private var onUtterance: ((String) -> Void)?
    private var onSpoken: (() -> Void)?

    override init() {
        super.init()
        synth.delegate = self
    }

    func requestAccess() async -> Bool {
        let speech = await withCheckedContinuation { c in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) }
        }
        let mic = await AVCaptureDevice.requestAccess(for: .audio)
        return speech && mic
    }

    /// Listens until ~1.4s of silence, then calls `onUtterance` with the text.
    func listen(onUtterance: @escaping (String) -> Void) {
        guard !listening else { return }
        Task {
            guard await requestAccess() else {
                error = "Microphone or speech recognition permission denied."
                return
            }
            guard let recognizer, recognizer.isAvailable else {
                error = "On-device speech recognition unavailable."
                return
            }
            self.onUtterance = onUtterance
            do { try start(recognizer) } catch { self.error = error.localizedDescription }
        }
    }

    private func start(_ recognizer: SFSpeechRecognizer) throws {
        stopSpeaking()
        partial = ""
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true
        self.request = request

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            request.append(buffer)
            let level = Self.rms(buffer)
            Task { @MainActor in self?.level = level }
        }
        engine.prepare()
        try engine.start()
        listening = true

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }
                if let result {
                    self.partial = result.bestTranscription.formattedString
                    self.armSilenceTimer()
                    if result.isFinal { self.finish() }
                }
                if error != nil, self.listening { self.finish() }
            }
        }
    }

    private func armSilenceTimer() {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: 1.4, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.finish() }
        }
    }

    private func finish() {
        guard listening else { return }
        let text = partial.trimmed
        stopListening()
        if !text.isEmpty { onUtterance?(text) }
    }

    func stopListening() {
        silenceTimer?.invalidate()
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        listening = false
        level = 0
    }

    func speak(_ text: String, then: (() -> Void)? = nil) {
        let clean = text.replacingOccurrences(of: "```[\\s\\S]*?```", with: " code block. ", options: .regularExpression)
            .replacingOccurrences(of: "[*_#`>]", with: "", options: .regularExpression)
        guard !clean.trimmed.isEmpty else { then?(); return }
        onSpoken = then
        let utterance = AVSpeechUtterance(string: clean)
        utterance.rate = 0.52
        speaking = true
        synth.speak(utterance)
    }

    func stopSpeaking() {
        onSpoken = nil
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        speaking = false
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.speaking = false
            let next = self.onSpoken
            self.onSpoken = nil
            next?()
        }
    }

    nonisolated static func rms(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let data = buffer.floatChannelData?[0] else { return 0 }
        let n = Int(buffer.frameLength)
        guard n > 0 else { return 0 }
        var sum: Float = 0
        for i in 0..<n { sum += data[i] * data[i] }
        return min(1, sqrt(sum / Float(n)) * 12)
    }
}
