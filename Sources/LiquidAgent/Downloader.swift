import Foundation

/// One-shot file download with progress, moved to `dest` when done.
final class Downloader: NSObject, URLSessionDownloadDelegate {
    private let dest: URL
    private let onProgress: (Int64, Int64) -> Void
    private var continuation: CheckedContinuation<URL, Error>?
    private var session: URLSession?

    init(dest: URL, onProgress: @escaping (Int64, Int64) -> Void) {
        self.dest = dest
        self.onProgress = onProgress
    }

    static func fetch(_ url: URL, to dest: URL, onProgress: @escaping (Int64, Int64) -> Void) async throws -> URL {
        try await Downloader(dest: dest, onProgress: onProgress).run(url)
    }

    func run(_ url: URL) async throws -> URL {
        try FileManager.default.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        self.session = session
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { c in
                continuation = c
                session.downloadTask(with: url).resume()
            }
        } onCancel: {
            session.invalidateAndCancel()
        }
    }

    private func finish(_ result: Result<URL, Error>) {
        continuation?.resume(with: result)
        continuation = nil
        session?.finishTasksAndInvalidate()
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        onProgress(totalBytesWritten, totalBytesExpectedToWrite)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        if let http = downloadTask.response as? HTTPURLResponse, http.statusCode != 200 {
            finish(.failure(InstallError.http(http.statusCode, downloadTask.originalRequest?.url?.absoluteString ?? "")))
            return
        }
        do {
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: location, to: dest)
            finish(.success(dest))
        } catch {
            finish(.failure(error))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { finish(.failure(error)) }
    }
}

enum InstallError: LocalizedError {
    case http(Int, String)
    case missing(String)
    case command(String, String)

    var errorDescription: String? {
        switch self {
        case .http(let code, let url): "Download failed (\(code)) for \(url)"
        case .missing(let what): "Couldn't find \(what)"
        case .command(let cmd, let out): "\(cmd) failed: \(out.suffix(300))"
        }
    }
}

extension Int64 {
    var bytesText: String { ByteCountFormatter.string(fromByteCount: self, countStyle: .file) }
}
