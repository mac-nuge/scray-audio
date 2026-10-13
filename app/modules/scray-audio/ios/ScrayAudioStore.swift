import UIKit
import UniformTypeIdentifiers

// ============================================================================
// ScrayAudioStore - where saved tracks live.
//
// The same deal Scray Native makes for its video folder: iOS won't let an app
// write anywhere in Files on its own, so the person picks a folder once, we
// keep a security-scoped bookmark, and from then on writes go straight in.
//
//     <the picked folder>/Offline/<the track's library path>      the audio
//     <the picked folder>/Offline/.covers/<name>.jpg               album covers
//     <the picked folder>/Offline/.scray-audio.json                the list of saved tracks (the page writes it)
//
// Plain files in a folder you can see in Files. The page keeps the list; if
// a file is deleted outside the app, `offlineFiles` is how the page finds out.
// ============================================================================

final class ScrayAudioStore: NSObject, UIDocumentPickerDelegate {

    static let shared = ScrayAudioStore()

    private let bookmarkKey = "scrayAudio.folderBookmark"
    private let nameKey = "scrayAudio.folderName"
    private static let offlineName = "Offline"
    private static let manifestName = ".scray-audio.json"

    private var resolvedRoot: URL?
    private var attempted = false
    private var pickCompletion: ((String?) -> Void)?

    // MARK: - The folder

    /// The picked folder, with its security scope held open for as long as the app runs.
    private var root: URL? {
        if !attempted {
            attempted = true
            if let data = UserDefaults.standard.data(forKey: bookmarkKey) {
                var stale = false
                if let url = try? URL(resolvingBookmarkData: data, bookmarkDataIsStale: &stale) {
                    _ = url.startAccessingSecurityScopedResource()
                    resolvedRoot = url
                    if stale, let fresh = try? url.bookmarkData() {
                        UserDefaults.standard.set(fresh, forKey: bookmarkKey)
                    }
                }
            }
        }
        return resolvedRoot
    }

    var folderName: String? { root?.lastPathComponent }

    /// <folder>/Offline, made if need be.
    var offlineRoot: URL? {
        guard let root = root else { return nil }
        let dir = root.appendingPathComponent(Self.offlineName, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    func pickFolder(completion: @escaping (String?) -> Void) {
        DispatchQueue.main.async {
            guard let top = Self.topViewController() else { completion(nil); return }
            self.pickCompletion = completion
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
            picker.delegate = self
            top.present(picker, animated: true)
        }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        defer { pickCompletion = nil }
        guard let folder = urls.first, folder.startAccessingSecurityScopedResource() else { pickCompletion?(nil); return }
        guard let bookmark = try? folder.bookmarkData() else {
            folder.stopAccessingSecurityScopedResource()
            pickCompletion?(nil)
            return
        }
        resolvedRoot?.stopAccessingSecurityScopedResource()
        UserDefaults.standard.set(bookmark, forKey: bookmarkKey)
        UserDefaults.standard.set(folder.lastPathComponent, forKey: nameKey)
        resolvedRoot = folder          // its scope stays open: we just started it above
        attempted = true
        pickCompletion?(folder.lastPathComponent)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickCompletion?(nil)
        pickCompletion = nil
    }

    private static func topViewController() -> UIViewController? {
        var top = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first?.windows.first(where: { $0.isKeyWindow })?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }

    // MARK: - Paths

    /// A path from the page, joined onto Offline/ - never out of it.
    func fileURL(forRelativePath rel: String) -> URL? {
        guard let base = offlineRoot else { return nil }
        let parts = rel.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard !parts.isEmpty, !rel.hasPrefix("/"), !parts.contains("..") , !parts.contains(".") else { return nil }
        var url = base
        for p in parts { url.appendPathComponent(p) }
        return url
    }

    // MARK: - Files

    /// Every saved audio file, as { path, size } relative to Offline/ (covers and the list itself are left out).
    func listFiles() -> [[String: Any]] {
        guard let base = offlineRoot else { return [] }
        let basePath = base.resolvingSymlinksInPath().path + "/"
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey]
        guard let walker = FileManager.default.enumerator(
            at: base, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else { return [] }
        var out: [[String: Any]] = []
        for case let url as URL in walker {
            guard let v = try? url.resourceValues(forKeys: Set(keys)), v.isRegularFile == true else { continue }
            let full = url.resolvingSymlinksInPath().path
            guard full.hasPrefix(basePath) else { continue }
            out.append(["path": String(full.dropFirst(basePath.count)), "size": v.fileSize ?? 0])
        }
        return out
    }

    /// Deletes files (paths relative to Offline/), then any folders that are left empty.
    func remove(paths: [String]) {
        guard let base = offlineRoot else { return }
        let fm = FileManager.default
        for rel in paths {
            guard let url = fileURL(forRelativePath: rel) else { continue }
            try? fm.removeItem(at: url)
            var dir = url.deletingLastPathComponent()
            while dir.path.count > base.path.count, dir.path.hasPrefix(base.path) {
                let left = (try? fm.contentsOfDirectory(atPath: dir.path)) ?? []
                if left.contains(where: { $0 != ".DS_Store" }) { break }
                try? fm.removeItem(at: dir)
                dir = dir.deletingLastPathComponent()
            }
        }
    }

    func readManifest() -> String? {
        guard let url = offlineRoot?.appendingPathComponent(Self.manifestName),
              let data = try? Data(contentsOf: url) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func writeManifest(_ text: String) -> Bool {
        guard let url = offlineRoot?.appendingPathComponent(Self.manifestName) else { return false }
        return (try? text.data(using: .utf8)?.write(to: url, options: .atomic)) != nil
    }

    /// Free and total space on the volume the folder is on (the phone's, if none is picked yet).
    func storage() -> [String: Any] {
        let at = offlineRoot ?? URL(fileURLWithPath: NSHomeDirectory())
        let v = try? at.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey, .volumeTotalCapacityKey])
        return [
            "free": v?.volumeAvailableCapacityForImportantUsage ?? 0,
            "total": v?.volumeTotalCapacity ?? 0,
        ]
    }
}
