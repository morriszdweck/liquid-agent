import SwiftUI

struct SettingsView: View {
    var body: some View {
        TabView {
            ModelsPane().tabItem { Label("Models", systemImage: "cpu") }
            SafetyPane().tabItem { Label("Safety", systemImage: "checkmark.shield") }
            AgentPane().tabItem { Label("Agent", systemImage: "gearshape.2") }
            MemoryPane().tabItem { Label("Memory", systemImage: "brain") }
        }
        .frame(width: 560, height: 420)
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

private struct ModelsPane: View {
    @EnvironmentObject var settings: AppSettings

    var body: some View {
        Form {
            Picker("Active model", selection: $settings.model) {
                ForEach(ModelChoice.allCases) { Text($0.label).tag($0) }
            }
            Section("LFM3 1.7B") {
                LocalField(title: "Server URL", value: $settings.llmURLSmall)
                TextField("Model id", text: $settings.modelIdSmall)
            }
            Section("LFM3 2B Omni") {
                LocalField(title: "Server URL", value: $settings.llmURLOmni)
                TextField("Model id", text: $settings.modelIdOmni)
            }
            Text("Any OpenAI-compatible local server works: llama-server, mlx_lm.server or Ollama. Run scripts/start-backends.sh to start everything.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
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
            Section("Auto 200M guardian") {
                LocalField(title: "Guardian URL", value: $settings.guardianURL)
                HStack {
                    Text("Deny threshold")
                    Slider(value: $settings.guardianThreshold, in: 0.1...0.9, step: 0.05)
                    Text(settings.guardianThreshold, format: .number.precision(.fractionLength(2)))
                        .monospacedDigit()
                }
                Text("Lower is stricter. Model card reports 0.50; a calibrated 0.36 is stricter. Dangerous shell patterns (sudo, rm -rf ~, pipes to sh…) always ask you.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

private struct AgentPane: View {
    @EnvironmentObject var settings: AppSettings

    var body: some View {
        Form {
            TextField("Workspace folder", text: $settings.workspace)
            LocalField(title: "Betterwright bridge URL", value: $settings.browserURL)
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
            Section("Extras") {
                Toggle("Speak replies aloud", isOn: $settings.speakReplies)
                Toggle("Generate ideas on launch", isOn: $settings.ideasOnLaunch)
            }
        }
        .formStyle(.grouped)
    }
}

private struct MemoryPane: View {
    @EnvironmentObject var memory: MemoryStore
    @State private var newFact = ""

    var body: some View {
        VStack(alignment: .leading) {
            Text("What Liquid Agent knows about you. Stored only on this Mac. Used for answers and the Ideas feed.")
                .font(.caption).foregroundStyle(.secondary)
            List {
                ForEach(memory.facts, id: \.self) { fact in
                    HStack {
                        Text(fact)
                        Spacer()
                        Button { memory.remove(fact) } label: { Image(systemName: "trash") }
                            .buttonStyle(.borderless)
                    }
                }
            }
            HStack {
                TextField("Add a fact", text: $newFact).onSubmit(add)
                Button("Add", action: add)
            }
        }
        .padding()
    }

    private func add() {
        memory.add(newFact)
        newFact = ""
    }
}
