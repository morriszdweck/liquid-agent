import SwiftUI

/// One-click setup. Downloads and starts everything; no Terminal needed.
struct SetupView: View {
    @EnvironmentObject var backends: Backends
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var state: AppState
    @State private var task: Task<Void, Never>?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(backends.ready ? "You're all set" : "Let's get Liquid Agent ready")
                        .font(.system(size: 30, weight: .bold))
                    Text("Everything runs on your Mac. We download it once, then it works privately, even without internet.")
                        .font(.title3).foregroundStyle(.secondary)
                }

                HStack {
                    Text("What should I call you?")
                    TextField("Your name (optional)", text: $settings.userName)
                        .textFieldStyle(.roundedBorder).frame(maxWidth: 240)
                }

                if backends.busy {
                    HStack(spacing: 12) {
                        ProgressView().controlSize(.small)
                        Text("Downloading… you can keep using your Mac. This window can stay open.")
                        Spacer()
                        Button("Stop") { task?.cancel() }
                    }
                    .padding(14)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Color.accentColor.opacity(0.08)))
                } else if backends.ready {
                    Button { state.newChat() } label: {
                        Label("Start chatting", systemImage: "bubble.left.and.bubble.right.fill")
                            .font(.title3).padding(.horizontal, 20).padding(.vertical, 10)
                    }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                } else {
                    HStack(spacing: 12) {
                        Button { install(Part.allCases) } label: {
                            VStack(spacing: 2) {
                                Text("Set up everything").font(.title3.weight(.semibold))
                                Text("Recommended · about 4 GB").font(.caption)
                            }
                            .padding(.horizontal, 20).padding(.vertical, 8)
                        }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                        Button { install([.engine, .small]) } label: {
                            VStack(spacing: 2) {
                                Text("Just the basics").font(.title3)
                                Text("Chat only · 1.1 GB").font(.caption)
                            }
                            .padding(.horizontal, 20).padding(.vertical, 8)
                        }
                        .controlSize(.large)
                    }
                }

                VStack(spacing: 10) {
                    ForEach(Part.allCases) { part in PartRow(part: part, install: { install([part]) }) }
                }

                Text("Downloads come from Hugging Face, GitHub and nodejs.org. After that, nothing you say or do leaves this Mac.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(32)
            .frame(maxWidth: 760, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
    }

    private func install(_ parts: [Part]) {
        task = Task { await backends.install(parts) }
    }
}

struct PartRow: View {
    @EnvironmentObject var backends: Backends
    var part: Part
    var install: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: part.symbol)
                .font(.title2)
                .frame(width: 40, height: 40)
                .background(Circle().fill(Color.accentColor.opacity(0.1)))
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(part.title).font(.headline)
                    Text(part.sizeText).font(.caption).foregroundStyle(.secondary)
                }
                Text(part.detail).font(.callout).foregroundStyle(.secondary)
                switch backends.state(part) {
                case .installing(let text, let fraction):
                    if let fraction { ProgressView(value: fraction) } else { ProgressView().progressViewStyle(.linear) }
                    Text(text).font(.caption).foregroundStyle(.secondary)
                case .failed(let message):
                    Text(message).font(.caption).foregroundStyle(.red).lineLimit(3)
                default:
                    EmptyView()
                }
            }
            Spacer()
            trailing
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14).strokeBorder(.quaternary))
    }

    @ViewBuilder private var trailing: some View {
        switch backends.state(part) {
        case .missing:
            Button("Download", action: install).disabled(backends.busy)
        case .installing:
            EmptyView()
        case .installed:
            if part == .engine {
                Label("Ready", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
            } else {
                Button("Turn on") { Task { await backends.start(part) } }
            }
        case .running:
            Label("On", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        case .failed:
            Button("Try again") {
                if backends.onDisk(part) { Task { await backends.start(part) } } else { install() }
            }
            .disabled(backends.busy)
        }
    }
}
