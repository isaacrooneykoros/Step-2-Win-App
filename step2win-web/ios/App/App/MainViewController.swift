import UIKit
import Capacitor

/// Capacitor 6+ no longer auto-registers plugin classes that live in the app target, so the
/// app's own plugins are registered here. SceneDelegate and Main.storyboard both use this class.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(DeviceStepCounterPlugin())
        bridge?.registerPluginInstance(AppSystemPlugin())
    }
}
