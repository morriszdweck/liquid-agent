import Foundation
import SwiftUI

/// User settings. Every endpoint must be loopback: Liquid Agent is local only.
@MainActor
final class AppSettings: ObservableObject {
    @AppStorage("model") var model: ModelChoice = .lfm3_1_7b
    @AppStorage("approvalMode") var approvalMode: ApprovalMode = .approveForMe

    @AppStorage("llmURL_1_7b") var llmURLSmall = "http://127.0.0.1:8080/v1"
    @AppStorage("llmURL_2b") var llmURLOmni = "http://127.0.0.1:8081/v1"
    @AppStorage("modelId_1_7b") var modelIdSmall = "LFM3-1.7B"
    @AppStorage("modelId_2b") var modelIdOmni = "LFM3-2B-Omni"

    @AppStorage("guardianURL") var guardianURL = "http://127.0.0.1:8766"
    @AppStorage("guardianThreshold") var guardianThreshold = 0.5
    @AppStorage("browserURL") var browserURL = "http://127.0.0.1:8767"

    @AppStorage("contextBudget") var contextBudget = 6000
    @AppStorage("toolOutputLimit") var toolOutputLimit = 1200
    @AppStorage("maxSteps") var maxSteps = 8
    @AppStorage("temperature") var temperature = 0.3

    @AppStorage("speakReplies") var speakReplies = false
    @AppStorage("ideasOnLaunch") var ideasOnLaunch = true
    @AppStorage("workspace") var workspace = FileManager.default.homeDirectoryForCurrentUser.path

    var llmURL: String { model == .lfm3_2b_omni ? llmURLOmni : llmURLSmall }
    var modelId: String { model == .lfm3_2b_omni ? modelIdOmni : modelIdSmall }

    nonisolated static func isLocal(_ string: String) -> Bool {
        guard let host = URL(string: string)?.host?.lowercased() else { return false }
        return ["127.0.0.1", "localhost", "::1", "[::1]"].contains(host)
    }
}
