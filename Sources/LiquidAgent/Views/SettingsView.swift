import SwiftUI

struct SettingsView: View {
    var body: some View {
        TabView {
            GeneralPane().tabItem { Label("General", systemImage: "person") }
            DownloadsPane().tabItem { Label("Downloads", systemImage: "arrow.down.circle") }
            SafetyPane().tabItem { Label("Safety", systemImage: "checkmark.shield") }
            AdvancedPane().tabItem { Label("Advanced", systemImage: "gearshape.2") }
        }
        .frame(width: 600, height: 480)
    }
}

private struct GeneralPane: View {
    @EnvironmentObject var settings: AppSettings

    var body: some View {
        Form {
            TextField("Your name", text: $settings.userName)
            Picker("Personality", selection: $settings.personality) {
                ForEach(Personality.allCases) { Text($0.label).tag($0) }
            }
            HStack {
                Text("Text size")
                Slider(value: $settings.textSize, in: 12...22, step: 1)
                Text("\(Int(settings.textSize))").monospacedDigit()
            }
            Toggle("Read replies aloud", isOn: $settings.speakReplies)
            Toggle("Make new ideas when the app opens", isOn: $settings.ideasOnLaunch)
            TextField("Folder I can work in", text: $settings.workspace)
        }
        .formStyle(.grouped)
    }
}

private struct DownloadsPane: View {
    @EnvironmentObject var backends: Backends

    var body: some View {
        VStack(alignment: .leading) {
            ScrollView {
                VStack(spacing: 8) {
                    ForEach(Part.allCases) { part in
                        HStack {
                            PartRow(part: part) { Task { await backends.install([part]) } }
                            if backends.installed(part) {
                                Button(role: .destructive) { backends.remove(part) } label: { Image(systemName: "trash") }
                                    .buttonStyle(.borderless)
                                    .help("Remove to free up space")
                            }
                        }
                    }
                }
            }
            HStack {
                Text("Brains are picked automatically: Omni for pictures and your screen, 1.7B for everything else.")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Show logs") { backends.revealLogs() }
            }
        }
        .padding()
    }
}

private struct LocalField: View {
    var title: String
    @Binding var value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            TextField(title, text: $value)
            if !AppSettings.isLocal(value) {
                Text("Must be localhost / 127.0.0.1. Liquid Agent never calls remote servers.")
                    .font(.caption).foregroundStyle(.red)
            }
        }
    }
}

private struct SafetyPane: View {
    @EnvironmentObject var settings: AppSettings

    var body: some View {
        Form {
            Picker("Approval mode", selection: $settings.approvalMode) {
                ForEach(ApprovalMode.allCases) { Text($0.label).tag($0) }
            }
            Text(settings.approvalMode.detail).font(.caption).foregroundStyle(.secondary)
            Section("Auto 200M safety helper") {
                HStack {
                    Text("Strictness")
                    Slider(value: $settings.guardianThreshold, in: 0.1...0.9, step: 0.05)
                    Text(settings.guardianThreshold, format: .number.precision(.fractionLength(2))).monospacedDigit()
                }
                Text("Lower is stricter. 0.50 is the model card default. Risky shell commands (sudo, rm -rf ~, piping into sh…) always ask you, in every mode.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

private struct AdvancedPane: View {
    @EnvironmentObject var settings: AppSettings

    var body: some View {
        Form {
            Section("Local servers (only change if you run your own)") {
                LocalField(title: "LFM3 1.7B URL", value: $settings.llmURLSmall)
                TextField("LFM3 1.7B model id", text: $settings.modelIdSmall)
                LocalField(title: "LFM3 Omni 2B URL", value: $settings.llmURLOmni)
                TextField("LFM3 Omni 2B model id", text: $settings.modelIdOmni)
                LocalField(title: "Safety helper URL", value: $settings.guardianURL)
                LocalField(title: "Web helper URL", value: $settings.browserURL)
            }
            Section("Token budget") {
                Stepper("Context budget: \(settings.contextBudget) tokens", value: $settings.contextBudget, in: 1500...32000, step: 500)
                Stepper("Tool output limit: \(settings.toolOutputLimit) chars", value: $settings.toolOutputLimit, in: 200...8000, step: 200)
                Stepper("Max steps per request: \(settings.maxSteps)", value: $settings.maxSteps, in: 1...30)
                HStack {
                    Text("Temperature")
                    Slider(value: $settings.temperature, in: 0...1.2, step: 0.05)
                    Text(settings.temperature, format: .number.precision(.fractionLength(2))).monospacedDigit()
                }
            }
        }
        .formStyle(.grouped)
    }
}
