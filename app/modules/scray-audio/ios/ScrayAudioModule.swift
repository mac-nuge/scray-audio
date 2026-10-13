import ExpoModulesCore

public class ScrayAudioModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ScrayAudio")

    View(ScrayAudioView.self) {
      Prop("source") { (view: ScrayAudioView, path: String) in
        view.loadSource(path)
      }
    }
  }
}
