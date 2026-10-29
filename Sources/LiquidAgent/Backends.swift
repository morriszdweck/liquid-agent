import AppKit
import Foundation

/// Everything Liquid Agent needs, downloaded and run by the app itself.
/// Downloads come from Hugging Face, GitHub and nodejs.org once; after that
/// every part runs on this Mac and listens on 127.0.0.1 only.
enum Part: String, CaseIterable, Identifiable, Codable {
    case engine, small, omni, guardian, browser

    var id: String { rawValue }

    var title: String {
        switch self {
        case .engine: "AI engine"
        case .small: "Everyday brain"
        case .omni: "Eyes and ears"
        case .guardian: "Safety helper"
        case .browser: "Web helper"
        }
    }

    var detail: String {
        switch self {
        case .engine: "Runs the AI on your Mac (latest llama.cpp)."
        case .small: "LFM3 1.7B. Fast chat, writing and actions."
        case .omni: "LFM3 Omni 2B. Understands pictures and your screen."
        case .guardian: "Auto 200M (INT4). Checks each action is safe before it runs."
        case .browser: "Betterwright. Lets the agent browse websites for you."
        }
    }

    var symbol: String {
        switch self {
        case .engine: "cpu"
        case .small: "bubble.left.and.text.bubble.right"
        case .omni: "eye"
        case .guardian: "checkmark.shield"
        case .browser: "globe"
        }
    }

    var sizeText: String {
        switch self {
        case .engine: "about 30 MB"
        case .small: "1.1 GB"
        case .omni: "1.6 GB"
        case .guardian: "about 900 MB"
        case .browser: "about 250 MB"
        }
    }

    var port: Int? {
        switch self {
        case .engine: nil
        case .small: 8180
        case .omni: 8181
        case .guardian: 8766
        case .browser: 8767
        }
    }
}

enum PartState: Equatable {
    case missing
    case installing(String, Double?)
    case installed
    case running
    case failed(String)

    var isInstalled: Bool {
        switch self {
        case .installed, .running: true
        default: false
        }
    }
}

@MainActor
final class Backends: ObservableObject {
    @Published private(set) var states: [Part: PartState] = [:]
    @Published private(set) var busy = false

    static let smallRepo = "LiquidAI/LFM3-1.7B-GGUF"
    static let smallFile = "LFM3-1.7B-Q4_K_M.gguf"
    static let omniRepo = "LiquidAI/LFM3-Omni-2B-GGUF"
    static let omniFile = "LFM3-Omni-2B-Q4_K_M.gguf"
    static let omniProjector = "mmproj-LFM3-Omni-2B-Q8_0.gguf"
    static let guardianRepo = "ProCreations/auto-200m-2-int4"

    private let root = Storage.dir
    private var processes: [Part: Process] = [:]
    private var models: URL { root.appendingPathComponent("models") }
    private var tools: URL { root.appendingPathComponent("tools") }
    private var logs: URL { root.appendingPathComponent("logs") }
    private var guardianDir: URL { root.appendingPathComponent("guardian") }
    private var bridgeDir: URL { root.appendingPathComponent("bridge") }

    #if arch(arm64)
    private static let arch = "arm64"
    #else
    private static let arch = "x64"
    #endif

    init() {
        try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        refresh()
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.stopAll() }
        }
    }

    func state(_ part: Part) -> PartState { states[part] ?? .missing }
    func installed(_ part: Part) -> Bool { state(part).isInstalled }

    /// Ready to chat: an engine and at least one brain.
    var ready: Bool { installed(.engine) && (installed(.small) || installed(.omni)) }

    func refresh() {
        for part in Part.allCases {
            if case .installing = state(part) { continue }
            if processes[part]?.isRunning == true { states[part] = .running; continue }
            if case .failed = state(part) { continue }
            states[part] = onDisk(part) ? .installed : .missing
        }
    }

    func onDisk(_ part: Part) -> Bool {
        let fm = FileManager.default
        switch part {
        case .engine: return llamaServer != nil
        case .small: return fm.fileExists(atPath: models.appendingPathComponent(Self.smallFile).path)
        case .omni:
            return fm.fileExists(atPath: models.appendingPathComponent(Self.omniFile).path)
                && fm.fileExists(atPath: models.appendingPathComponent(Self.omniProjector).path)
        case .guardian: return fm.fileExists(atPath: guardianDir.appendingPathComponent(".ready").path)
        case .browser: return fm.fileExists(atPath: bridgeDir.appendingPathComponent(".ready").path)
        }
    }

    // MARK: Install

    func install(_ parts: [Part]) async {
        busy = true
        defer { busy = false }
        var queue = parts
        if queue.contains(where: { $0 == .small || $0 == .omni }), !installed(.engine), !queue.contains(.engine) {
            queue.insert(.engine, at: 0)
        }
        for part in queue where !installed(part) {
            do {
                try await install(part)
                states[part] = .installed
                await start(part)
            } catch is CancellationError {
                states[part] = .missing
                return
            } catch {
                states[part] = .failed(error.localizedDescription)
            }
        }
    }

    func remove(_ part: Part) {
        stop(part)
        let fm = FileManager.default
        switch part {
        case .engine: try? fm.removeItem(at: root.appendingPathComponent("engine"))
        case .small: try? fm.removeItem(at: models.appendingPathComponent(Self.smallFile))
        case .omni:
            try? fm.removeItem(at: models.appendingPathComponent(Self.omniFile))
            try? fm.removeItem(at: models.appendingPathComponent(Self.omniProjector))
        case .guardian: try? fm.removeItem(at: guardianDir)
        case .browser: try? fm.removeItem(at: bridgeDir)
        }
        states[part] = .missing
        refresh()
    }

    private func progress(_ part: Part, _ label: String) -> (Int64, Int64) -> Void {
        var last = Date.distantPast
        return { done, total in
            guard Date().timeIntervalSince(last) > 0.25 || done == total else { return }
            last = Date()
            let fraction = total > 0 ? Double(done) / Double(total) : nil
            let text = total > 0 ? "\(label) \(done.bytesText) of \(total.bytesText)" : "\(label) \(done.bytesText)"
            Task { @MainActor in self.states[part] = .installing(text, fraction) }
        }
    }

    private func install(_ part: Part) async throws {
        states[part] = .installing("Starting…", nil)
        switch part {
        case .engine:
            try await installEngine()
        case .small:
            try await hfDownload(Self.smallRepo, Self.smallFile, part: part)
        case .omni:
            try await hfDownload(Self.omniRepo, Self.omniProjector, part: part, label: "Downloading eyes")
            try await hfDownload(Self.omniRepo, Self.omniFile, part: part)
        case .guardian:
            try await installGuardian()
        case .browser:
            try await installBrowser()
        }
    }

    private func hfDownload(_ repo: String, _ file: String, part: Part, label: String = "Downloading") async throws {
        let url = URL(string: "https://huggingface.co/\(repo)/resolve/main/\(file)?download=true")!
        _ = try await Downloader.fetch(url, to: models.appendingPathComponent(file), onProgress: progress(part, label))
    }

    private func installEngine() async throws {
        let api = URL(string: "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10")!
        let (data, _) = try await URLSession.shared.data(from: api)
        let releases = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] ?? []
        let suffix = "bin-macos-\(Self.arch).tar.gz"
        let asset = releases.lazy
            .compactMap { $0["assets"] as? [[String: Any]] }
            .compactMap { $0.first { ($0["name"] as? String)?.hasSuffix(suffix) == true } }
            .first
        guard let urlString = asset?["browser_download_url"] as? String, let url = URL(string: urlString) else {
            throw InstallError.missing("a llama.cpp build for this Mac")
        }
        let engine = root.appendingPathComponent("engine")
        let archive = tools.appendingPathComponent("llama.tar.gz")
        _ = try await Downloader.fetch(url, to: archive, onProgress: progress(.engine, "Downloading"))
        states[.engine] = .installing("Unpacking…", nil)
        try? FileManager.default.removeItem(at: engine)
        try FileManager.default.createDirectory(at: engine, withIntermediateDirectories: true)
        _ = try await Exec.run("/usr/bin/tar", ["-xzf", archive.path, "-C", engine.path])
        try? FileManager.default.removeItem(at: archive)
        guard llamaServer != nil else { throw InstallError.missing("llama-server in the download") }
    }

    /// The app's own llama.cpp. Homebrew builds are skipped on purpose: older
    /// ones can't load the `lfm3` architecture.
    var llamaServer: String? {
        let engine = root.appendingPathComponent("engine")
        guard let found = FileManager.default.enumerator(atPath: engine.path)?
            .compactMap({ $0 as? String }).first(where: { ($0 as NSString).lastPathComponent == "llama-server" }) else { return nil }
        return engine.appendingPathComponent(found).path
    }

    private func ensureUV() async throws -> String {
        let uv = tools.appendingPathComponent("uv/uv")
        if FileManager.default.isExecutableFile(atPath: uv.path) { return uv.path }
        let name = Self.arch == "arm64" ? "uv-aarch64-apple-darwin" : "uv-x86_64-apple-darwin"
        let url = URL(string: "https://github.com/astral-sh/uv/releases/latest/download/\(name).tar.gz")!
        let archive = tools.appendingPathComponent("uv.tar.gz")
        _ = try await Downloader.fetch(url, to: archive, onProgress: progress(.guardian, "Getting Python tools"))
        try FileManager.default.createDirectory(at: uv.deletingLastPathComponent(), withIntermediateDirectories: true)
        _ = try await Exec.run("/usr/bin/tar", ["-xzf", archive.path, "-C", uv.deletingLastPathComponent().path, "--strip-components=1"])
        try? FileManager.default.removeItem(at: archive)
        return uv.path
    }

    private var hfEnv: [String: String] {
        ["HF_HOME": root.appendingPathComponent("hf").path, "UV_CACHE_DIR": tools.appendingPathComponent("uv-cache").path,
         "UV_PYTHON_INSTALL_DIR": tools.appendingPathComponent("python").path]
    }

    private func installGuardian() async throws {
        let uv = try await ensureUV()
        try FileManager.default.createDirectory(at: guardianDir, withIntermediateDirectories: true)
        try copySidecar("guardian/server.py", to: guardianDir.appendingPathComponent("server.py"))
        let venv = guardianDir.appendingPathComponent(".venv").path
        states[.guardian] = .installing("Setting up Python…", nil)
        _ = try await Exec.run(uv, ["venv", "--python", "3.12", venv], env: hfEnv)
        states[.guardian] = .installing("Installing safety model tools (this is the slow part)…", nil)
        _ = try await Exec.run(uv, ["pip", "install", "--python", venv + "/bin/python",
                                    "torch", "transformers>=5", "huggingface_hub", "safetensors"], env: hfEnv, timeout: 1800)
        states[.guardian] = .installing("Downloading Auto 200M…", nil)
        _ = try await Exec.run(venv + "/bin/python", ["-I", guardianDir.appendingPathComponent("server.py").path, "--download-only"],
                               env: hfEnv, timeout: 900)
        FileManager.default.createFile(atPath: guardianDir.appendingPathComponent(".ready").path, contents: nil)
    }

    private func ensureNode() async throws -> String {
        let node = tools.appendingPathComponent("node/bin/node")
        if FileManager.default.isExecutableFile(atPath: node.path) { return node.path }
        let (data, _) = try await URLSession.shared.data(from: URL(string: "https://nodejs.org/dist/index.json")!)
        let index = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] ?? []
        guard let version = index.first(where: { ($0["lts"] as? String) != nil })?["version"] as? String else {
            throw InstallError.missing("a Node.js release")
        }
        let url = URL(string: "https://nodejs.org/dist/\(version)/node-\(version)-darwin-\(Self.arch).tar.gz")!
        let archive = tools.appendingPathComponent("node.tar.gz")
        _ = try await Downloader.fetch(url, to: archive, onProgress: progress(.browser, "Getting Node.js"))
        let dir = tools.appendingPathComponent("node")
        try? FileManager.default.removeItem(at: dir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        _ = try await Exec.run("/usr/bin/tar", ["-xzf", archive.path, "-C", dir.path, "--strip-components=1"])
        try? FileManager.default.removeItem(at: archive)
        return node.path
    }

    private var nodeEnv: [String: String] {
        let bin = tools.appendingPathComponent("node/bin").path
        return ["PATH": "\(bin):/usr/bin:/bin:/usr/sbin:/sbin", "npm_config_cache": tools.appendingPathComponent("npm-cache").path]
    }

    private func installBrowser() async throws {
        let node = try await ensureNode()
        let npm = (node as NSString).deletingLastPathComponent + "/npm"
        let npx = (node as NSString).deletingLastPathComponent + "/npx"
        try FileManager.default.createDirectory(at: bridgeDir, withIntermediateDirectories: true)
        try copySidecar("bridge/server.mjs", to: bridgeDir.appendingPathComponent("server.mjs"))
        try copySidecar("bridge/package.json", to: bridgeDir.appendingPathComponent("package.json"))
        states[.browser] = .installing("Installing Betterwright…", nil)
        _ = try await Exec.run(npm, ["install", "--no-audit", "--no-fund"], cwd: bridgeDir.path, env: nodeEnv, timeout: 900)
        states[.browser] = .installing("Downloading browser…", nil)
        _ = try await Exec.run(npx, ["betterwright", "setup"], cwd: bridgeDir.path, env: nodeEnv, timeout: 900)
        FileManager.default.createFile(atPath: bridgeDir.appendingPathComponent(".ready").path, contents: nil)
    }

    /// Sidecar sources ship inside the app bundle; `swift run` uses the repo.
    private func copySidecar(_ relative: String, to dest: URL) throws {
        let bundled = Bundle.main.resourceURL?.appendingPathComponent("sidecars/" + relative)
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent(relative)
        guard let source = [bundled, repo].compactMap({ $0 }).first(where: { FileManager.default.fileExists(atPath: $0.path) }) else {
            throw InstallError.missing(relative)
        }
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.copyItem(at: source, to: dest)
    }

    // MARK: Run

    func startAll() async {
        for part in Part.allCases where part != .engine && installed(part) {
            await start(part)
        }
    }

    func start(_ part: Part) async {
        guard processes[part]?.isRunning != true, let port = part.port, onDisk(part) else { return }
        let process: Process
        switch part {
        case .small, .omni:
            guard let server = llamaServer else { return }
            var args = ["--host", "127.0.0.1", "--port", "\(port)", "-c", "8192", "--jinja", "-ngl", "99"]
            if part == .small {
                args += ["-m", models.appendingPathComponent(Self.smallFile).path, "--alias", "LFM3-1.7B"]
            } else {
                args += ["-m", models.appendingPathComponent(Self.omniFile).path,
                         "--mmproj", models.appendingPathComponent(Self.omniProjector).path, "--alias", "LFM3-Omni-2B"]
            }
            process = launch(server, args, cwd: nil, env: [:], log: part.rawValue)
        case .guardian:
            process = launch(guardianDir.appendingPathComponent(".venv/bin/python").path,
                             ["-I", guardianDir.appendingPathComponent("server.py").path, "--port", "\(port)"],
                             cwd: guardianDir.path, env: hfEnv.merging(["HF_HUB_OFFLINE": "1"]) { $1 }, log: "guardian")
        case .browser:
            process = launch(tools.appendingPathComponent("node/bin/node").path, ["server.mjs"],
                             cwd: bridgeDir.path, env: nodeEnv.merging(["LA_BROWSER_PORT": "\(port)"]) { $1 }, log: "browser")
        case .engine:
            return
        }
        processes[part] = process
        states[part] = .installing("Starting…", nil)
        let healthy = await waitHealthy(port: port, path: "/health", seconds: 90)
        if process.isRunning, healthy {
            states[part] = .running
        } else {
            process.terminate()
            processes[part] = nil
            states[part] = .failed(startFailure(part, port: port))
        }
    }

    /// Turns the end of a part's log into a plain-language reason.
    private func startFailure(_ part: Part, port: Int) -> String {
        let log = (try? String(contentsOf: logs.appendingPathComponent("\(part.rawValue).log"), encoding: .utf8)) ?? ""
        let tail = log.suffix(4000).lowercased()
        if tail.contains("unknown model architecture") {
            return "The AI engine is too old for this model. Remove the AI engine in Settings → Downloads, then download it again."
        }
        if tail.contains("address already in use") || tail.contains("couldn't bind") {
            return "Something else is using port \(port). Quit it, then click Try again."
        }
        if tail.contains("failed to load model") || tail.contains("error loading model") {
            return "The model file looks damaged. Remove it in Settings → Downloads, then download it again."
        }
        return "Couldn't start. Click Try again; details are in Logs."
    }

    func stop(_ part: Part) {
        processes[part]?.terminate()
        processes[part] = nil
    }

    func stopAll() {
        for part in Part.allCases { stop(part) }
    }

    func isRunning(_ part: Part) -> Bool { processes[part]?.isRunning == true }

    func revealLogs() { NSWorkspace.shared.open(logs) }

    private func launch(_ exe: String, _ args: [String], cwd: String?, env: [String: String], log: String) -> Process {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        p.environment = ProcessInfo.processInfo.environment.merging(env) { $1 }
        let logURL = logs.appendingPathComponent(log + ".log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        if let handle = try? FileHandle(forWritingTo: logURL) {
            p.standardOutput = handle
            p.standardError = handle
        }
        p.terminationHandler = { [weak self] _ in
            Task { @MainActor in
                guard let self, self.processes[Part(rawValue: log) ?? .engine] === p else { return }
                self.processes[Part(rawValue: log) ?? .engine] = nil
                self.refresh()
            }
        }
        try? p.run()
        return p
    }

    private func waitHealthy(port: Int, path: String, seconds: Int) async -> Bool {
        let url = URL(string: "http://127.0.0.1:\(port)\(path)")!
        for _ in 0..<(seconds * 2) {
            if let (_, response) = try? await URLSession.shared.data(from: url),
               (response as? HTTPURLResponse)?.statusCode == 200 { return true }
            try? await Task.sleep(for: .milliseconds(500))
        }
        return false
    }
}

/// Runs a program directly (no shell) and returns its output, throwing on failure.
enum Exec {
    @discardableResult
    static func run(_ exe: String, _ args: [String], cwd: String? = nil, env: [String: String] = [:],
                    timeout: TimeInterval = 300) async throws -> String {
        try await withCheckedThrowingContinuation { c in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: exe)
            p.arguments = args
            if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
            p.environment = ProcessInfo.processInfo.environment.merging(env) { $1 }
            let pipe = Pipe()
            p.standardOutput = pipe
            p.standardError = pipe
            let output = OutputBuffer()
            pipe.fileHandleForReading.readabilityHandler = { output.append($0.availableData) }
            p.terminationHandler = { p in
                pipe.fileHandleForReading.readabilityHandler = nil
                output.append(pipe.fileHandleForReading.readDataToEndOfFile())
                let text = output.text
                if p.terminationStatus == 0 {
                    c.resume(returning: text)
                } else {
                    c.resume(throwing: InstallError.command((exe as NSString).lastPathComponent, text))
                }
            }
            do {
                try p.run()
                DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { if p.isRunning { p.terminate() } }
            } catch {
                c.resume(throwing: error)
            }
        }
    }
}

/// Thread-safe output collector for `Exec`.
private final class OutputBuffer: @unchecked Sendable {
    private var data = Data()
    private let lock = NSLock()

    func append(_ chunk: Data) {
        lock.lock(); data.append(chunk); lock.unlock()
    }

    var text: String {
        lock.lock(); defer { lock.unlock() }
        return String(decoding: data, as: UTF8.self)
    }
}
