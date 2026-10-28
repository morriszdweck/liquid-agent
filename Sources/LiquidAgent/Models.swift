import Foundation

enum Role: String, Codable {
    case system, user, assistant, tool
}

struct ToolCall: Codable, Hashable {
    var name: String
    var args: [String: String]

    var argsSummary: String {
        args.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ", ")
    }
}

enum ApprovalStatus: String, Codable {
    case pending, approved, autoApproved, denied, autoDenied
}

struct Message: Identifiable, Codable, Hashable {
    var id = UUID()
    var role: Role
    var text: String
    var toolCall: ToolCall?
    var approval: ApprovalStatus?
    var guardianScore: Double?
    var imagePath: String?
    var date = Date()
}

struct Conversation: Identifiable, Codable, Hashable {
    var id = UUID()
    var title: String = "New chat"
    var messages: [Message] = []
    var updated = Date()
}

/// The three approval modes.
enum ApprovalMode: String, Codable, CaseIterable, Identifiable {
    case askAlways
    case approveForMe
    case fullAuto

    var id: String { rawValue }

    var label: String {
        switch self {
        case .askAlways: "Ask for Approval"
        case .approveForMe: "Approve for Me"
        case .fullAuto: "Full Auto"
        }
    }

    var detail: String {
        switch self {
        case .askAlways: "Asks before every action."
        case .approveForMe: "Auto 200M approves safe actions, asks you for the rest."
        case .fullAuto: "Runs every action without asking. Use with care."
        }
    }

    var symbol: String {
        switch self {
        case .askAlways: "hand.raised"
        case .approveForMe: "checkmark.shield"
        case .fullAuto: "bolt"
        }
    }
}

enum ModelChoice: String, Codable, CaseIterable, Identifiable {
    case lfm3_1_7b
    case lfm3_2b_omni

    var id: String { rawValue }

    var label: String {
        switch self {
        case .lfm3_1_7b: "LFM3 1.7B"
        case .lfm3_2b_omni: "LFM3 2B Omni"
        }
    }

    var supportsImages: Bool { self == .lfm3_2b_omni }
}
