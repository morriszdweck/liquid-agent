import AppKit
import Foundation
import UserNotifications

struct ToolContext {
    var workspace: String
    var memory: MemoryStore
    var browser: BrowserBridge
}

/// A tool the model can call. `signature` is the one-line description sent in
/// the system prompt, kept short because small models have small budgets.
struct Tool {
    var name: String
    var signature: String
    var run: (_ args: [String: String], _ ctx: ToolContext) async throws -> String
}

enum ToolError: LocalizedError {
    case missing(String)
    case unknown(String)

    var errorDescription: String? {
        switch self {
        case .missing(let arg): "missing argument: \(arg)"
        case .unknown(let name): "unknown tool: \(name)"
        }
    }
}

extension Dictionary where Key == String, Value == String {
    func req(_ key: String) throws -> String {
        guard let value = self[key], !value.isEmpty else { throw ToolError.missing(key) }
        return value
    }
}

extension Tool {
    /// Parameter names from the signature, e.g. `["path", "content"]`.
    var params: [String] {
        guard let open = signature.firstIndex(of: "("), let close = signature.firstIndex(of: ")") else { return [] }
        return signature[signature.index(after: open)..<close].split(separator: ",").map { $0.trimmed }.filter { !$0.isEmpty }
    }
}

enum Toolbox {
    static let all: [Tool] = [
        Tool(name: "shell", signature: "shell(cmd) run a zsh command in the workspace") { args, ctx in
            try await Shell.run(try args.req("cmd"), cwd: ctx.workspace)
        },
        Tool(name: "read_file", signature: "read_file(path)") { args, ctx in
            let url = resolve(try args.req("path"), ctx)
            return try String(contentsOf: url, encoding: .utf8)
        },
        Tool(name: "write_file", signature: "write_file(path, content)") { args, ctx in
            let url = resolve(try args.req("path"), ctx)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try (args["content"] ?? "").write(to: url, atomically: true, encoding: .utf8)
            return "wrote \(url.path)"
        },
        Tool(name: "list_dir", signature: "list_dir(path)") { args, ctx in
            let url = resolve(args["path"] ?? ".", ctx)
            let items = try FileManager.default.contentsOfDirectory(atPath: url.path).sorted()
            return items.prefix(200).joined(separator: "\n")
        },
        Tool(name: "open", signature: "open(target) open a URL, file or app name") { args, _ in
            let target = try args.req("target")
            let isApp = !target.contains("/") && !target.contains(".")
            return try await Shell.run(isApp ? "open -a \(quote(target))" : "open \(quote(target))", cwd: nil)
        },
        Tool(name: "web_search", signature: "web_search(query) search the web") { args, ctx in
            let q = try args.req("query").addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
            return try await ctx.browser.goto("https://html.duckduckgo.com/html/?q=" + q)
        },
        Tool(name: "browser_goto", signature: "browser_goto(url) open page in Betterwright browser") { args, ctx in
            try await ctx.browser.goto(try args.req("url"))
        },
        Tool(name: "browser_read", signature: "browser_read() compact text of current page") { _, ctx in
            try await ctx.browser.read()
        },
        Tool(name: "browser_click", signature: "browser_click(target) click by text or selector") { args, ctx in
            try await ctx.browser.click(try args.req("target"))
        },
        Tool(name: "browser_type", signature: "browser_type(target, text)") { args, ctx in
            try await ctx.browser.type(try args.req("target"), text: args["text"] ?? "")
        },
        Tool(name: "remember", signature: "remember(fact) save a fact about the user") { args, ctx in
            let fact = try args.req("fact")
            await MainActor.run { ctx.memory.add(fact) }
            return "saved"
        },
        Tool(name: "recall", signature: "recall(query) search saved facts") { args, ctx in
            let query = args["query"] ?? ""
            let hits = await MainActor.run { ctx.memory.search(query) }
            return hits.isEmpty ? "nothing found" : hits.joined(separator: "\n")
        },
        Tool(name: "clipboard", signature: "clipboard() read clipboard text") { _, _ in
            await MainActor.run { NSPasteboard.general.string(forType: .string) ?? "(empty)" }
        },
        Tool(name: "set_clipboard", signature: "set_clipboard(text) copy text for the user") { args, _ in
            let text = args["text"] ?? ""
            await MainActor.run {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
            }
            return "copied"
        },
        Tool(name: "reminder", signature: "reminder(text, minutes) notify the user later") { args, _ in
            let text = try args.req("text")
            let minutes = max(1, Double(args["minutes"] ?? "") ?? 10)
            let content = UNMutableNotificationContent()
            content.title = "Liquid Agent reminder"
            content.body = text
            content.sound = .default
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: minutes * 60, repeats: false)
            let center = UNUserNotificationCenter.current()
            _ = try await center.requestAuthorization(options: [.alert, .sound])
            try await center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: trigger))
            return "reminder set for \(Int(minutes)) min"
        },
    ]

    static func named(_ name: String) -> Tool? { all.first { $0.name == name } }

    /// Tools worth describing to the model right now. Hiding unusable ones saves tokens.
    static func available(browser: Bool) -> [Tool] {
        browser ? all : all.filter { !$0.name.hasPrefix("browser") && $0.name != "web_search" }
    }

    static func resolve(_ path: String, _ ctx: ToolContext) -> URL {
        let expanded = (path as NSString).expandingTildeInPath
        if expanded.hasPrefix("/") { return URL(fileURLWithPath: expanded) }
        return URL(fileURLWithPath: ctx.workspace).appendingPathComponent(expanded)
    }

    static func quote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
}

enum Shell {
    static func run(_ command: String, cwd: String?, timeout: TimeInterval = 60) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/zsh")
            process.arguments = ["-lc", command]
            if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            process.terminationHandler = { p in
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let out = String(decoding: data, as: UTF8.self)
                continuation.resume(returning: p.terminationStatus == 0 ? out : "exit \(p.terminationStatus)\n\(out)")
            }
            do {
                try process.run()
                DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                    if process.isRunning { process.terminate() }
                }
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }
}
