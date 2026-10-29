import Foundation
import SwiftUI

enum Personality: String, CaseIterable, Identifiable {
    case friendly, concise, playful, professional

    var id: String { rawValue }
    var label: String { rawValue.capitalized }

    var instruction: String {
        switch self {
        case .friendly: "Be warm, clear and patient. Explain simply."
        case .concise: "Be extremely brief. No filler."
        case .playful: "Be witty and fun, but still helpful."
        case .professional: "Be precise and professional."
        }
    }
}

/// User settings. Every endpoint must be loopback: Liquid Agent is local only.
@MainActor
final class AppSettings: ObservableObject {
    @AppStorage("approvalMode") var approvalMode: ApprovalMode = .approveForMe
    @AppStorage("personality") var personality: Personality = .friendly
    @AppStorage("userName") var userName = ""

    @AppStorage("llmURL_small") var llmURLSmall = "http://127.0.0.1:8180/v1"
    @AppStorage("llmURL_omni") var llmURLOmni = "http://127.0.0.1:8181/v1"
    @AppStorage("modelId_small") var modelIdSmall = "LFM3-1.7B"
    @AppStorage("modelId_omni") var modelIdOmni = "LFM3-Omni-2B"

    @AppStorage("guardianURL") var guardianURL = "http://127.0.0.1:8766"
    @AppStorage("guardianThreshold") var guardianThreshold = 0.5
    @AppStorage("browserURL") var browserURL = "http://127.0.0.1:8767"

    @AppStorage("contextBudget") var contextBudget = 6000
    @AppStorage("toolOutputLimit") var toolOutputLimit = 1200
    @AppStorage("maxSteps") var maxSteps = 8
    @AppStorage("temperature") var temperature = 0.3

    @AppStorage("speakReplies") var speakReplies = false
    @AppStorage("ideasOnLaunch") var ideasOnLaunch = true
    @AppStorage("textSize") var textSize = 14.0
    @AppStorage("workspace") var workspace = FileManager.default.homeDirectoryForCurrentUser.path

    func url(for model: ModelChoice) -> String { model == .lfm3_2b_omni ? llmURLOmni : llmURLSmall }
    func id(for model: ModelChoice) -> String { model == .lfm3_2b_omni ? modelIdOmni : modelIdSmall }

    nonisolated static func isLocal(_ string: String) -> Bool {
        guard let host = URL(string: string)?.host?.lowercased() else { return false }
        return ["127.0.0.1", "localhost", "::1", "[::1]"].contains(host)
    }
}
