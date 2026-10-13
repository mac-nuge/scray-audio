import ExpoModulesCore
import WebKit
import AVFoundation

// WKUserContentController copies its handlers when the web view is created, but `self` doesn't exist until after
// super.init() - so the handler is a proxy that is pointed at the view afterwards.
private final class ScriptMessageProxy: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

// ============================================================================
// ScrayAudioView - the whole app: the page (web/index.html in the bundle) in a
// web view, plus the few things a page can't do itself.
//
//   page -> native   webkit.messageHandlers.scrayAudio.postMessage({ id, action, payload })
//   native -> page   window._saResolve(id, value) / window._saReject(id, message)
//                    window._saProgress(key, received, total)
//
//   state            { folder }           the picked folder's name, or null
//   pickFolder       { folder }           opens the Files folder picker
//   manifestRead     string | null        the list of saved tracks (the page's own JSON)
//   manifestWrite    true
//   offlineFiles     [{ path, size }]     what is on disk under Offline/
//   storage          { free, total }      bytes
//   download         true                 { key, url, path } -> saved, or rejected with why
//   cancel           true                 { key }
//   remove           true                 { paths }
//
// Playing a saved track is not a bridge call: the page points its <audio> at
// scray-audio://local/<path> and ScrayAudioSchemeHandler serves the file.
// ============================================================================

class ScrayAudioView: ExpoView, WKScriptMessageHandler, WKNavigationDelegate {
    let webView: WKWebView
    private let messageProxy = ScriptMessageProxy()
    private let schemeHandler = ScrayAudioSchemeHandler()
    private var sourcePath: String?

    required init(appContext: AppContext? = nil) {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsPictureInPictureMediaPlayback = false
        config.setURLSchemeHandler(schemeHandler, forURLScheme: "scray-audio")
        config.userContentController.add(messageProxy, name: "scrayAudio")
        webView = WKWebView(frame: .zero, configuration: config)
        super.init(appContext: appContext)
        messageProxy.target = self
        webView.navigationDelegate = self
        webView.isOpaque = false
        let ink = UIColor(red: 0.051, green: 0.059, blue: 0.071, alpha: 1)      // #0d0f12, the page's background
        webView.backgroundColor = ink
        webView.scrollView.backgroundColor = ink
        webView.scrollView.contentInsetAdjustmentBehavior = .never             // the page pads for the notch itself
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        addSubview(webView)

        // Audio keeps playing with the screen locked or the app in the background (UIBackgroundModes: audio).
        // The session is only given its category here; WebKit turns it on when something plays, so launching the
        // app doesn't cut off whatever else is playing.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [])
    }

    override func layoutSubviews() {
        webView.frame = bounds
    }

    func loadSource(_ path: String) {
        sourcePath = path
        guard let url = Bundle.main.url(forResource: "web/" + path, withExtension: nil) else {
            NSLog("[ScrayAudio] web/%@ is not in the app bundle", path)
            return
        }
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    // iOS can kill the page's process outright when memory is short; the page would be left blank.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if let path = sourcePath { loadSource(path) } else { webView.reload() }
    }

    // MARK: - The bridge

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let id = body["id"] as? String,
              let action = body["action"] as? String else { return }
        let p = body["payload"] as? [String: Any] ?? [:]
        let store = ScrayAudioStore.shared

        switch action {
        case "state":
            resolve(id, ["folder": store.folderName ?? NSNull()])
        case "pickFolder":
            store.pickFolder { [weak self] name in self?.resolve(id, ["folder": name ?? NSNull()]) }
        case "manifestRead":
            resolve(id, store.readManifest() ?? NSNull())
        case "manifestWrite":
            guard let text = p["text"] as? String else { reject(id, "No text"); return }
            if store.writeManifest(text) { resolve(id, true) } else { reject(id, "Couldn't write the list of saved tracks") }
        case "offlineFiles":
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in self?.resolve(id, store.listFiles()) }
        case "storage":
            resolve(id, store.storage())
        case "download":
            guard let key = p["key"] as? String, let url = p["url"] as? String, let path = p["path"] as? String else {
                reject(id, "Invalid download"); return
            }
            ScrayAudioDownloads.shared.start(
                key: key, urlString: url, path: path,
                progress: { [weak self] received, total in self?.progress(key, received, total) },
                done: { [weak self] why in if let why = why { self?.reject(id, why) } else { self?.resolve(id, true) } })
        case "cancel":
            if let key = p["key"] as? String { ScrayAudioDownloads.shared.cancel(key: key) }
            resolve(id, true)
        case "remove":
            let paths = p["paths"] as? [String] ?? []
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                store.remove(paths: paths)
                self?.resolve(id, true)
            }
        default:
            reject(id, "Unknown action \(action)")
        }
    }

    // MARK: - Replies (any thread)

    private func resolve(_ id: String, _ result: Any) {
        guard let data = try? JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed]),
              let json = String(data: data, encoding: .utf8) else { reject(id, "Couldn't encode the answer"); return }
        run("window._saResolve(\(Self.quote(id)), \(json));")
    }

    private func reject(_ id: String, _ message: String) {
        run("window._saReject(\(Self.quote(id)), \(Self.quote(message)));")
    }

    private func progress(_ key: String, _ received: Int64, _ total: Int64) {
        run("window._saProgress && window._saProgress(\(Self.quote(key)), \(received), \(total));")
    }

    private func run(_ js: String) {
        DispatchQueue.main.async { self.webView.evaluateJavaScript(js) }
    }

    /// A JavaScript string literal (JSON is one).
    private static func quote(_ s: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: s, options: [.fragmentsAllowed]),
              let out = String(data: data, encoding: .utf8) else { return "\"\"" }
        return out
    }
}
