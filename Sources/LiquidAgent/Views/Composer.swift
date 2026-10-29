import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct Composer: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var voice: VoiceController
    @State private var text = ""
    @State private var attachments: [Attachment] = []
    @State private var dropTarget = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !attachments.isEmpty {
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(attachments, id: \.self) { a in
                            AttachmentChip(attachment: a) { attachments.removeAll { $0 == a } }
                        }
                    }
                }
            }
            TextField(voice.listening ? "Listening…" : "Ask anything, or tell me what to do", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...8)
                .focused($focused)
                .onSubmit(submit)
            HStack(spacing: 16) {
                Button(action: pickFiles) { Image(systemName: "paperclip") }
                    .help("Attach a picture or file")
                Button { state.lookAtScreen() } label: { Image(systemName: "rectangle.dashed.and.paperclip") }
                    .help("Look at my screen")
                Button {
                    voice.listening ? voice.stopListening() : voice.listen { text = $0; submit() }
                } label: {
                    Image(systemName: voice.listening ? "mic.fill" : "mic")
                        .foregroundStyle(voice.listening ? .red : .primary)
                }
                .help("Speak instead of typing")
                Spacer()
                Button { state.startVoiceChat() } label: {
                    Label("Voice", systemImage: "waveform")
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Capsule().fill(.quaternary.opacity(0.6)))
                }
                .help("Start a hands-free voice chat")
                if state.running {
                    Button(action: state.stop) {
                        Image(systemName: "stop.fill").padding(8).background(Circle().fill(.primary))
                            .foregroundStyle(Color(nsColor: .textBackgroundColor))
                    }
                    .help("Stop")
                } else {
                    Button(action: submit) {
                        Image(systemName: "arrow.up").fontWeight(.bold).padding(8)
                            .background(Circle().fill(canSend ? Color.primary : Color.secondary.opacity(0.4)))
                            .foregroundStyle(Color(nsColor: .textBackgroundColor))
                    }
                    .disabled(!canSend)
                    .help("Send")
                }
            }
            .buttonStyle(.borderless)
            .font(.system(size: 15))
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 22).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(dropTarget ? Color.accentColor : Color.secondary.opacity(0.2), lineWidth: dropTarget ? 2 : 1))
        .shadow(color: .black.opacity(0.06), radius: 8, y: 2)
        .onDrop(of: [.fileURL], isTargeted: $dropTarget) { providers in
            for provider in providers {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    if let url { Task { @MainActor in attachments.append(Attachment(path: url.path)) } }
                }
            }
            return true
        }
        .onAppear { focused = true }
    }

    private var canSend: Bool { !text.trimmed.isEmpty || !attachments.isEmpty }

    private func submit() {
        guard canSend, !state.running else { return }
        state.send(text, attachments: attachments)
        text = ""
        attachments = []
    }

    private func pickFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        if panel.runModal() == .OK { attachments += panel.urls.map { Attachment(path: $0.path) } }
    }
}

struct AttachmentChip: View {
    var attachment: Attachment
    var remove: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            if attachment.isImage, let image = NSImage(contentsOfFile: attachment.path) {
                Image(nsImage: image).resizable().scaledToFill().frame(width: 36, height: 36)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            } else {
                Image(systemName: "doc.text").frame(width: 36, height: 36)
            }
            Text(attachment.name).font(.caption).lineLimit(1).frame(maxWidth: 140)
            Button(action: remove) { Image(systemName: "xmark.circle.fill") }.buttonStyle(.borderless)
        }
        .padding(4)
        .background(RoundedRectangle(cornerRadius: 8).fill(.quaternary.opacity(0.5)))
    }
}
