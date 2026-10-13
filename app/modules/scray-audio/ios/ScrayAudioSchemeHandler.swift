import WebKit

// ============================================================================
// ScrayAudioSchemeHandler - serves scray-audio://local/<path> (a saved track or
// cover) to the web view, from <picked folder>/Offline/<path>.
//
// An <audio> element needs Range requests to seek, so those are honoured. As in
// Scray Native's video handler, nothing is read on the main thread (WebKit
// calls start() there), a response is streamed in fixed chunks so a big file
// never sits in memory, and a task WebKit has stopped is never written to.
// ============================================================================

final class ScrayAudioSchemeHandler: NSObject, WKURLSchemeHandler {

    private static let chunkBytes = 512 * 1024      // ⚙️ read and handed over per step
    private let io = DispatchQueue(label: "scray.audio.scheme", qos: .userInitiated)

    /// Tasks WebKit has started and not stopped, that haven't finished. Main thread only.
    private var live: [ObjectIdentifier: WKURLSchemeTask] = [:]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(NSError(domain: "scray", code: 404)); return
        }
        let id = ObjectIdentifier(task)
        live[id] = task
        let rangeHeader = task.request.value(forHTTPHeaderField: "Range")
        let candidates = Self.candidatePaths(for: url)

        io.async { [weak self] in
            var found: (URL, FileHandle, Int64)?
            for rel in candidates {
                guard let file = ScrayAudioStore.shared.fileURL(forRelativePath: rel),
                      let attrs = try? FileManager.default.attributesOfItem(atPath: file.path),
                      let size = (attrs[.size] as? NSNumber)?.int64Value,
                      let handle = try? FileHandle(forReadingFrom: file) else { continue }
                found = (file, handle, size); break
            }
            guard let (file, handle, size) = found else {
                DispatchQueue.main.async {
                    guard let self = self, self.live.removeValue(forKey: id) != nil else { return }
                    task.didFailWithError(NSError(domain: "scray", code: 404))
                }
                return
            }

            // "bytes=a-b", "bytes=a-" and "bytes=-n" (the last n bytes).
            var start: Int64 = 0
            var end: Int64 = max(0, size - 1)
            var status = 200
            if let range = rangeHeader, range.hasPrefix("bytes=") {
                let parts = range.dropFirst(6).split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
                if parts.count == 2 {
                    if parts[0].isEmpty, let n = Int64(parts[1]) { start = max(0, size - n) }
                    else if let a = Int64(parts[0]) {
                        start = a
                        if let b = Int64(parts[1]) { end = b }
                    }
                    status = 206
                }
            }
            start = max(0, min(start, max(0, size - 1)))
            end = max(start, min(end, size - 1))
            let length = size > 0 ? end - start + 1 : 0

            var headers = [
                "Content-Type": Self.mimeType(for: file.pathExtension),
                "Content-Length": "\(length)",
                "Accept-Ranges": "bytes",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-store",
            ]
            if status == 206 { headers["Content-Range"] = "bytes \(start)-\(end)/\(size)" }

            DispatchQueue.main.async {
                guard let self = self, self.live[id] != nil else { return }
                guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
                    self.live.removeValue(forKey: id)
                    task.didFailWithError(NSError(domain: "scray", code: 500))
                    return
                }
                task.didReceive(response)
                self.stream(task: task, id: id, handle: handle, offset: start, remaining: length)
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        live.removeValue(forKey: ObjectIdentifier(task))
    }

    /// Reads the next chunk on the I/O queue, hands it over on main, then asks for the one after.
    private func stream(task: WKURLSchemeTask, id: ObjectIdentifier, handle: FileHandle, offset: Int64, remaining: Int64) {
        guard remaining > 0 else {
            if live.removeValue(forKey: id) != nil { task.didFinish() }
            return
        }
        let want = Int(min(Int64(Self.chunkBytes), remaining))
        io.async { [weak self] in
            var data = Data()
            var failed = false
            do {
                try handle.seek(toOffset: UInt64(offset))
                data = try handle.read(upToCount: want) ?? Data()
            } catch { failed = true }
            DispatchQueue.main.async {
                guard let self = self, self.live[id] != nil else { return }
                if failed || data.isEmpty {
                    self.live.removeValue(forKey: id)
                    if failed { task.didFailWithError(NSError(domain: "scray", code: 500)) } else { task.didFinish() }
                    return
                }
                task.didReceive(data)
                self.stream(task: task, id: id, handle: handle, offset: offset + Int64(data.count), remaining: remaining - Int64(data.count))
            }
        }
    }

    // The page percent-encodes each path segment; Foundation's url.path decodes once. Decoding a second time mangles a
    // name with a % in it, so try the single decode first and the others as fallbacks.
    private static func candidatePaths(for url: URL) -> [String] {
        var out: [String] = []
        func add(_ value: String?) {
            guard var p = value, !p.isEmpty else { return }
            if p.hasPrefix("/") { p = String(p.dropFirst()) }
            if !p.isEmpty, !out.contains(p) { out.append(p) }
        }
        let encoded = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath
        add(encoded?.removingPercentEncoding)
        add(url.path)
        add(encoded)
        return out
    }

    private static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "mp3": return "audio/mpeg"
        case "m4a", "mp4": return "audio/mp4"
        case "aac": return "audio/aac"
        case "flac": return "audio/flac"
        case "ogg", "oga", "opus": return "audio/ogg"
        case "wav": return "audio/wav"
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "webp": return "image/webp"
        default: return "application/octet-stream"
        }
    }
}
