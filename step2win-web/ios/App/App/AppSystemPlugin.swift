import Foundation
import UIKit
import AVFoundation
import Capacitor

/// iOS side of the 'AppSystem' plugin (Android: AppSystemPlugin.java). Same method names and
/// result shapes so src/plugins/appSystem.ts works unchanged.
@objc(AppSystemPlugin)
public class AppSystemPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppSystemPlugin"
    public let jsName = "AppSystem"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setPrivacyScreen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkCameraPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestCameraPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSecuritySettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAppSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openNotificationSettings", returnType: CAPPluginReturnPromise)
    ]

    private static let privacyViewTag = 0x5732_5057
    private var privacyEnabled = false

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(appWillResignActive),
                                               name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(appDidBecomeActive),
                                               name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: Privacy screen (hide balances in the app switcher)

    @objc func setPrivacyScreen(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled", false)
        DispatchQueue.main.async {
            self.privacyEnabled = enabled
            if !enabled {
                self.removePrivacyCover()
            }
            call.resolve(["enabled": enabled, "mode": "recents"])
        }
    }

    @objc private func appWillResignActive() {
        DispatchQueue.main.async {
            guard self.privacyEnabled, let window = self.bridge?.viewController?.view.window else { return }
            guard window.viewWithTag(AppSystemPlugin.privacyViewTag) == nil else { return }
            let cover = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
            cover.frame = window.bounds
            cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            cover.tag = AppSystemPlugin.privacyViewTag
            window.addSubview(cover)
        }
    }

    @objc private func appDidBecomeActive() {
        DispatchQueue.main.async {
            self.removePrivacyCover()
        }
    }

    private func removePrivacyCover() {
        bridge?.viewController?.view.window?.viewWithTag(AppSystemPlugin.privacyViewTag)?.removeFromSuperview()
    }

    // MARK: Camera permission

    private func cameraState() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            return "granted"
        case .notDetermined:
            return "prompt"
        case .denied, .restricted:
            return "denied"
        @unknown default:
            return "denied"
        }
    }

    @objc func checkCameraPermission(_ call: CAPPluginCall) {
        call.resolve(["camera": cameraState()])
    }

    @objc func requestCameraPermission(_ call: CAPPluginCall) {
        if AVCaptureDevice.authorizationStatus(for: .video) != .notDetermined {
            call.resolve(["camera": cameraState()])
            return
        }
        AVCaptureDevice.requestAccess(for: .video) { _ in
            call.resolve(["camera": self.cameraState()])
        }
    }

    // MARK: Settings deep links (iOS only allows opening this app's page in the Settings app)

    @objc func openSecuritySettings(_ call: CAPPluginCall) {
        // There is no public deep link to "Face ID & Passcode"; open the app's settings page.
        openURL(UIApplication.openSettingsURLString, call)
    }

    @objc func openAppSettings(_ call: CAPPluginCall) {
        openURL(UIApplication.openSettingsURLString, call)
    }

    @objc func openNotificationSettings(_ call: CAPPluginCall) {
        if #available(iOS 16.0, *) {
            openURL(UIApplication.openNotificationSettingsURLString, call)
        } else {
            openURL(UIApplication.openSettingsURLString, call)
        }
    }

    private func openURL(_ value: String, _ call: CAPPluginCall) {
        guard let url = URL(string: value) else {
            call.resolve(["opened": false])
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { success in
                call.resolve(["opened": success])
            }
        }
    }
}
