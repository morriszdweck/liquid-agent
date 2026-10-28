import AppKit
import SwiftUI

struct MessageRow: View {
    var message: Message

    var body: some View {
        switch message.role {
        case .user:
            HStack {
                Spacer(minLength: 80)
                VStack(alignment: .trailing, spacing: 6) {
                    if let path = message.imagePath, let image = NSImage(contentsOfFile: path) {
                        Image(nsImage: image).resizable().scaledToFit()
                            .frame(maxWidth: 220, maxHeight: 220)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    Text(message.text)
                        .textSelection(.enabled)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .background(RoundedRectangle(cornerRadius: 18).fill(.quaternary.opacity(0.7)))
                }
            }
        case .assistant:
            if !message.text.isEmpty {
                RichText(text: message.text)
            }
        case .tool:
            ToolCard(message: message)
        case .system:
            EmptyView()
        }
    }
}

/// Minimal markdown: fenced code blocks plus inline markdown per paragraph.
struct RichText: View {
    var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, seg in
                if seg.code {
                    CodeBlock(code: seg.text)
                } else {
                    Text(attributed(seg.text))
                        .textSelection(.enabled)
                        .lineSpacing(3)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var segments: [(text: String, code: Bool)] {
        text.components(separatedBy: "```").enumerated().compactMap { i, part in
            if i % 2 == 1 {
                let lines = part.split(separator: "\n", omittingEmptySubsequences: false)
                let body = lines.dropFirst().joined(separator: "\n")
                return (body.isEmpty ? part : body, true)
            }
            let t = part.trimmed
            return t.isEmpty ? nil : (t, false)
        }
    }

    private func attributed(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
    }
}

struct CodeBlock: View {
    var code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .trailing, spacing: 0) {
            Button(copied ? "Copied" : "Copy") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(code, forType: .string)
                copied = true
            }
            .buttonStyle(.borderless)
            .font(.caption)
            .padding(6)
            ScrollView(.horizontal) {
                Text(code)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .padding([.horizontal, .bottom], 12)
            }
        }
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.black.opacity(0.06)))
    }
}

struct ToolCard: View {
    @EnvironmentObject var state: AppState
    var message: Message
    @State private var expanded = false

    var body: some View {
        if let call = message.toolCall {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Image(systemName: icon(call.name)).foregroundStyle(.secondary)
                    Text(call.name).font(.callout.weight(.medium))
                    Text(call.argsSummary).font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary).lineLimit(1)
                    Spacer()
                    badge
                }
                if message.approval == .pending {
                    if !message.text.isEmpty {
                        Label(message.text, systemImage: "exclamationmark.shield")
                            .font(.caption).foregroundStyle(.orange)
                    }
                    if call.args.count > 0 {
                        Text(call.args.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }.joined(separator: "\n"))
                            .font(.system(.caption, design: .monospaced))
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 6).fill(.quaternary.opacity(0.4)))
                    }
                    HStack {
                        Button("Deny") { state.resolveApproval(message.id, approve: false) }
                            .keyboardShortcut(.escape, modifiers: [])
                        Button("Approve") { state.resolveApproval(message.id, approve: true) }
                            .keyboardShortcut(.return, modifiers: [.command])
                            .buttonStyle(.borderedProminent)
                    }
                } else if !message.text.isEmpty {
                    DisclosureGroup(isExpanded: $expanded) {
                        ScrollView {
                            Text(message.text)
                                .font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(maxHeight: 220)
                    } label: {
                        Text("Result").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 12).strokeBorder(borderColor))
        }
    }

    private var borderColor: Color {
        message.approval == .pending ? .orange.opacity(0.7) : Color.secondary.opacity(0.25)
    }

    @ViewBuilder private var badge: some View {
        switch message.approval {
        case .pending: Text("Needs approval").font(.caption).foregroundStyle(.orange)
        case .approved: Label("Approved", systemImage: "checkmark").font(.caption).foregroundStyle(.green)
        case .autoApproved:
            Label(message.guardianScore.map { "Auto 200M · \(Int((1 - $0) * 100))% safe" } ?? "Auto",
                  systemImage: "checkmark.shield").font(.caption).foregroundStyle(.green)
        case .denied, .autoDenied: Label("Denied", systemImage: "xmark").font(.caption).foregroundStyle(.red)
        case nil: EmptyView()
        }
    }

    private func icon(_ name: String) -> String {
        switch name {
        case "shell": "terminal"
        case "read_file", "list_dir": "doc.text"
        case "write_file": "square.and.pencil"
        case "open": "arrow.up.forward.app"
        case "remember", "recall": "brain"
        case "clipboard": "doc.on.clipboard"
        default: name.hasPrefix("browser") ? "globe" : "wrench.and.screwdriver"
        }
    }
}
