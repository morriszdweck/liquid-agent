import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct Composer: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var voice: VoiceController
    @State private var text = ""
    @State private var imagePath: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let imagePath, let image = NSImage(contentsOfFile: imagePath) {
                HStack {
                    Image(nsImage: image).resizable().scaledToFill()
                        .frame(width: 48, height: 48).clipShape(RoundedRectangle(cornerRadius: 8))
                    Button { self.imagePath = nil } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.borderless)
                }
            }
            TextField("Message Liquid Agent", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.body)
                .lineLimit(1...8)
                .focused($focused)
                .onSubmit(submit)
            HStack(spacing: 14) {
                Button(action: pickImage) { Image(systemName: "plus") }
                    .disabled(!settings.model.supportsImages)
                    .help(settings.model.supportsImages ? "Attach image" : "Images need LFM3 2B Omni")
                Button {
                    voice.listening ? voice.stopListening() : voice.listen { text = $0; submit() }
                } label: {
                    Image(systemName: voice.listening ? "mic.fill" : "mic")
                        .foregroundStyle(voice.listening ? .red : .primary)
                }
                .help("Dictate")
                Spacer()
                Button(action: state.toggleVoiceChat) {
                    Image(systemName: "waveform")
                        .foregroundStyle(state.voiceChat ? Color.accentColor : .primary)
                }
                .help("Voice chat")
                if state.running {
                    Button(action: state.stop) {
                        Image(systemName: "stop.fill").padding(7).background(Circle().fill(.primary))
                            .foregroundStyle(Color(nsColor: .textBackgroundColor))
                    }
                } else {
                    Button(action: submit) {
                        Image(systemName: "arrow.up").fontWeight(.bold).padding(7)
                            .background(Circle().fill(text.trimmed.isEmpty ? Color.secondary.opacity(0.4) : .primary))
                            .foregroundStyle(Color(nsColor: .textBackgroundColor))
                    }
                    .disabled(text.trimmed.isEmpty)
                }
            }
            .buttonStyle(.borderless)
            .font(.system(size: 15))
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 22).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(.quaternary))
        .shadow(color: .black.opacity(0.06), radius: 8, y: 2)
        .onAppear { focused = true }
    }

    private func submit() {
        guard !text.trimmed.isEmpty, !state.running else { return }
        state.send(text, imagePath: imagePath)
        text = ""
        imagePath = nil
    }

    private func pickImage() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.png, .jpeg]
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK { imagePath = panel.url?.path }
    }
}
