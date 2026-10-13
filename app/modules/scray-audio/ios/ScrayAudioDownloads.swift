import UIKit

// ============================================================================
// ScrayAudioDownloads - saves a track (or a cover) from a signed link into
// <picked folder>/Offline/<path>.
//
// The page asks api.php for a signed, expiring link and hands it over with the
// path to save it at. This runs a URLSession download task and moves the
// finished file into place; the page gets a promise back (resolved when the
// file is there, rejected with a reason) and progress as it goes. The page
// decides how many run at once.
//
// Nothing here holds a key: the signed link is the only credential and opens
// that one file. The screen is kept on while anything is saving, and a short
// background grace covers switching away for a moment. A download cut off by
// iOS fails, and saving again starts it over.
// ============================================================================

final class ScrayAudioDownloads: NSObject, URLSessionDownloadDelegate {

    static let shared = ScrayAudioDownloads()

    private final class Job {
        let key: String
        let dest: URL
        let progress: (Int64, Int64) -> Void
        let done: (String?) -> Void          // nil = saved; otherwise why not
        var moved = false
        var failure: String?
        var lastTick: CFAbsoluteTime = 0
        init(key: String, dest: URL, progress: @escaping (Int64, Int64) -> Void, done: @escaping (String?) -> Void) {
            self.key = key; self.dest = dest; self.progress = progress; self.done = done
        }
    }

    private let queue = DispatchQueue(label: "scray.audio.downloads")
    private lazy var operationQueue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.underlyingQueue = queue
        return q
    }()
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = 60 * 60 * 6
        config.waitsForConnectivity = false
        return URLSession(configuration: config, delegate: self, delegateQueue: operationQueue)
    }()

    // Touched only on `queue`.
    private var jobs: [Int: Job] = [:]            // by task identifier
    private var tasks: [String: URLSessionDownloadTask] = [:]   // by key
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    private override init() { super.init() }

    // MARK: - Bridge

    func start(key: String, urlString: String, path: String,
               progress: @escaping (Int64, Int64) -> Void, done: @escaping (String?) -> Void) {
        guard let url = URL(string: urlString), url.scheme?.lowercased() == "https" else {
            done("The download link must be https"); return
        }
        guard ScrayAudioStore.shared.folderName != nil else {
            done("No folder chosen to keep the files in"); return
        }
        guard let dest = ScrayAudioStore.shared.fileURL(forRelativePath: path) else {
            done("Invalid path: \(path)"); return
        }
        queue.async {
            if self.tasks[key] != nil { done("Already downloading"); return }
            let task = self.session.downloadTask(with: url)
            self.jobs[task.taskIdentifier] = Job(key: key, dest: dest, progress: progress, done: done)
            self.tasks[key] = task
            self.activeChanged()
            task.resume()
        }
    }

    func cancel(key: String) {
        queue.async { self.tasks[key]?.cancel() }
    }

    // MARK: - URLSessionDownloadDelegate (all on `queue`)

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let job = jobs[downloadTask.taskIdentifier] else { return }
        let now = CFAbsoluteTimeGetCurrent()
        guard now - job.lastTick >= 0.25 else { return }
        job.lastTick = now
        job.progress(totalBytesWritten, max(0, totalBytesExpectedToWrite))
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let job = jobs[downloadTask.taskIdentifier] else { return }
        // The temporary file is deleted when this returns, so the move happens here.
        if let http = downloadTask.response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            job.failure = "The server answered \(http.statusCode)"
            return
        }
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: job.dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            if fm.fileExists(atPath: job.dest.path) { try fm.removeItem(at: job.dest) }
            do { try fm.moveItem(at: location, to: job.dest) }
            catch { try fm.copyItem(at: location, to: job.dest) }     // another volume: the honest fallback
            job.moved = true
        } catch {
            job.failure = "Couldn't save the file: \(error.localizedDescription)"
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let job = jobs.removeValue(forKey: task.taskIdentifier) else { return }
        tasks.removeValue(forKey: job.key)
        activeChanged()
        if let error = error as NSError? {
            job.done(error.code == NSURLErrorCancelled ? "cancelled" : (job.failure ?? error.localizedDescription))
        } else if job.moved {
            job.done(nil)
        } else {
            job.done(job.failure ?? "The download didn't finish")
        }
    }

    // MARK: - Screen and background grace (on `queue`; UIKit on main)

    private func activeChanged() {
        let active = !jobs.isEmpty
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = active
            if active, self.backgroundTask == .invalid {
                self.backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "scray.audio.save") { [weak self] in
                    guard let self = self else { return }
                    UIApplication.shared.endBackgroundTask(self.backgroundTask)
                    self.backgroundTask = .invalid
                }
            } else if !active, self.backgroundTask != .invalid {
                UIApplication.shared.endBackgroundTask(self.backgroundTask)
                self.backgroundTask = .invalid
            }
        }
    }
}
