import Foundation
import UIKit
import CoreMotion
import CoreLocation
import HealthKit
import Capacitor

/// iOS implementation of the 'DeviceStepCounter' plugin (Android: DeviceStepCounterPlugin.java).
///
/// Steps come from CoreMotion's CMPedometer:
/// - getTodaySteps() queries the pedometer history from local midnight to now. iOS records steps
///   in the background by itself (the motion co-processor keeps ~7 days), so there is no
///   foreground service on iOS: every launch/resume simply reads the history since midnight.
/// - While the app is active, live pedometer updates feed cadence and 5-second burst numbers.
///
/// Android-only data (GaitAnalyzer / on-device ML features, foreground service, exact alarms)
/// does not exist here. Those fields are returned as NSNull (JS null) and flagged with
/// `gait_available: false` / `sensor_source: "cmpedometer"` so the JS layer can send nulls to
/// the backend instead of zeros.
///
/// Phase 1b: readings carry install_id, tz_offset_minutes / tz_name, burst_source
/// ("arrival_batched": CoreMotion batches, no per-step timestamps) and evidence_source
/// "ios_coremotion". Location is no longer captured automatically (only user walks may use it;
/// walks are not implemented on iOS yet: startWalk answers "unsupported"). Play Integrity has
/// no iOS equivalent wired yet (App Attest TODO): requestIntegrityToken answers "unsupported".
@objc(DeviceStepCounterPlugin)
public class DeviceStepCounterPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "DeviceStepCounterPlugin"
    public let jsName = "DeviceStepCounter"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkAdvancedPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestLocationPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExactAlarmSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startStepSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setActiveStepSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearActiveStepSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getTodaySteps", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startBackgroundCapture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopBackgroundCapture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getBackgroundStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPendingWaypoints", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearPendingWaypoints", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "claimSequence", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStepHistory", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startWalk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getWalkState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeWalkPoints", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopWalk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestIntegrityToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDeviceSignals", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSensorCapabilities", returnType: CAPPluginReturnPromise),
        // Phase 1c: Apple Health (HealthKit), opt-in and read-only.
        CAPPluginMethod(name: "healthSourcesStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "healthSourcesConnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "healthSourcesRead", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "healthSourcesDisconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "healthSourcesInstall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "healthSourcesOpenSettings", returnType: CAPPluginReturnPromise)
    ]

    // Same key names as the Android SharedPreferences file.
    private static let prefsSuite = "device_step_counter_prefs"
    private static let keyDeviceId = "device_id"
    private static let keySessionId = "step_session_id"
    private static let keySessionToken = "step_session_token"
    private static let keySessionExpiresAt = "step_session_expires_at"
    private static let keySessionNextSequence = "step_session_next_sequence"
    private static let keySessionLastTotal = "step_session_last_total"
    private static let keyCaptureEnabled = "capture_enabled"
    private static let keyWaypointsDate = "pending_waypoints_date"
    private static let keyWaypointsJson = "pending_waypoints_json"
    private static let keyInstallId = "install_id"

    private static let mlModelVersion = "ios-cmpedometer-v1"
    private static let maxWaypointsPerDay = 500
    private static let waypointMaxAccuracyMeters: Double = 65
    private static let waypointMinDistanceMeters: Double = 2.5
    private static let waypointMaxSpeedMps: Double = 8.0

    private let defaults = UserDefaults(suiteName: DeviceStepCounterPlugin.prefsSuite) ?? UserDefaults.standard
    private let pedometer = CMPedometer()
    /// Serialises all mutable state below (plugin calls, CoreMotion and CoreLocation callbacks
    /// arrive on different threads).
    private let stateQueue = DispatchQueue(label: "com.step2win.app.stepcounter.state")

    private var liveUpdatesRunning = false
    private var liveLastTotal = 0
    private var liveLastAt = Date()
    private var liveCadenceSpm: Double = 0
    private var liveCadenceAt = Date.distantPast
    private var stepTimes: [Date] = []

    // Main thread only.
    private var locationManager: CLLocationManager?
    private var pendingLocationCalls: [CAPPluginCall] = []
    private var locationUpdatesRunning = false
    private var lastWaypointLat: Double?
    private var lastWaypointLng: Double?
    private var lastWaypointAt: Date?
    private var lastWaypointAccuracy: Double = 0

    // MARK: Lifecycle

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(appDidBecomeActive),
                                               name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(appWillResignActive),
                                               name: UIApplication.willResignActiveNotification, object: nil)
        DispatchQueue.main.async {
            let manager = CLLocationManager()
            manager.delegate = self
            manager.desiredAccuracy = kCLLocationAccuracyBest
            manager.distanceFilter = 6
            manager.activityType = .fitness
            self.locationManager = manager
        }
        // Phase 1c: background delivery needs its observer query registered at launch.
        HealthKitSources.shared.startObserverIfOptedIn()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        pedometer.stopUpdates()
    }

    @objc private func appDidBecomeActive() {
        startLiveUpdatesIfPossible()
        DispatchQueue.main.async {
            self.updateLocationCapture()
        }
    }

    @objc private func appWillResignActive() {
        stopLiveUpdates()
        DispatchQueue.main.async {
            self.stopLocationCapture()
        }
    }

    // MARK: Permissions

    private func motionState() -> String {
        guard CMPedometer.isStepCountingAvailable() else { return "unavailable" }
        switch CMPedometer.authorizationStatus() {
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

    private func locationState(_ status: CLAuthorizationStatus) -> String {
        switch status {
        case .authorizedAlways, .authorizedWhenInUse:
            return "granted"
        case .notDetermined:
            return "prompt"
        case .denied, .restricted:
            return "denied"
        @unknown default:
            return "denied"
        }
    }

    private func currentLocationStatus() -> CLAuthorizationStatus {
        if let manager = locationManager {
            return manager.authorizationStatus
        }
        return CLLocationManager().authorizationStatus
    }

    @objc override public func checkPermissions(_ call: CAPPluginCall) {
        call.resolve(["activityRecognition": motionState()])
    }

    /// iOS has no explicit "request" API for Motion & Fitness: the system prompt appears on the
    /// first pedometer query. Wait (up to 60 s) for the user's answer before resolving.
    @objc override public func requestPermissions(_ call: CAPPluginCall) {
        let state = motionState()
        if state != "prompt" {
            call.resolve(["activityRecognition": state])
            return
        }
        let now = Date()
        pedometer.queryPedometerData(from: now.addingTimeInterval(-60), to: now) { [weak self] _, _ in
            guard let self = self else { return }
            self.waitForMotionDecision(call, deadline: Date().addingTimeInterval(60))
        }
    }

    private func waitForMotionDecision(_ call: CAPPluginCall, deadline: Date) {
        let state = motionState()
        if state != "prompt" || Date() >= deadline {
            if state == "granted" {
                startLiveUpdatesIfPossible()
            }
            call.resolve(["activityRecognition": state])
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.waitForMotionDecision(call, deadline: deadline)
        }
    }

    @objc func checkAdvancedPermissions(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve([
                "activityRecognition": self.motionState(),
                "location": self.locationState(self.currentLocationStatus()),
                // Exact alarms are an Android concept; iOS delivers scheduled notifications on time.
                "exactAlarm": "granted",
                "exactAlarmApplicable": false,
                "platform": "ios"
            ])
        }
    }

    @objc func requestLocationPermissions(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let manager = self.locationManager ?? CLLocationManager()
            if self.locationManager == nil {
                manager.delegate = self
                self.locationManager = manager
            }
            let status = manager.authorizationStatus
            if status == .notDetermined {
                self.pendingLocationCalls.append(call)
                manager.requestWhenInUseAuthorization()
            } else {
                call.resolve(["location": self.locationState(status)])
            }
        }
    }

    @objc func openExactAlarmSettings(_ call: CAPPluginCall) {
        call.resolve(["opened": false, "supported": false])
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        if status != .notDetermined && !pendingLocationCalls.isEmpty {
            let calls = pendingLocationCalls
            pendingLocationCalls.removeAll()
            let state = locationState(status)
            for pending in calls {
                pending.resolve(["location": state])
            }
        }
        updateLocationCapture()
    }

    // MARK: Step sessions (mirrors Android storage/semantics)

    @objc func startStepSession(_ call: CAPPluginCall) {
        var ret: [String: Any] = [
            "device_id": getOrCreateDeviceId(),
            "platform": "ios",
            "app_version": appVersion(),
            "ml_model_version": DeviceStepCounterPlugin.mlModelVersion
        ]
        stateQueue.sync {
            if let sessionId = defaults.string(forKey: DeviceStepCounterPlugin.keySessionId),
               let token = defaults.string(forKey: DeviceStepCounterPlugin.keySessionToken),
               let expiresAt = defaults.string(forKey: DeviceStepCounterPlugin.keySessionExpiresAt) {
                if isExpiredIso(expiresAt) {
                    clearSessionPrefs()
                } else {
                    ret["session_id"] = sessionId
                    ret["session_token"] = token
                    ret["expires_at"] = expiresAt
                    ret["next_sequence_number"] = max(1, defaults.integer(forKey: DeviceStepCounterPlugin.keySessionNextSequence))
                }
            }
        }
        call.resolve(ret)
    }

    @objc func setActiveStepSession(_ call: CAPPluginCall) {
        guard let sessionId = call.getString("session_id"),
              let token = call.getString("session_token"),
              let expiresAt = call.getString("expires_at") else {
            call.reject("Missing session fields.")
            return
        }
        let nextSequence = max(1, call.getInt("next_sequence_number") ?? 1)
        stateQueue.sync {
            defaults.set(sessionId, forKey: DeviceStepCounterPlugin.keySessionId)
            defaults.set(token, forKey: DeviceStepCounterPlugin.keySessionToken)
            defaults.set(expiresAt, forKey: DeviceStepCounterPlugin.keySessionExpiresAt)
            defaults.set(nextSequence, forKey: DeviceStepCounterPlugin.keySessionNextSequence)
            defaults.set(0, forKey: DeviceStepCounterPlugin.keySessionLastTotal)
        }
        call.resolve(["saved": true])
    }

    @objc func clearActiveStepSession(_ call: CAPPluginCall) {
        stateQueue.sync {
            clearSessionPrefs()
        }
        call.resolve(["cleared": true])
    }

    // MARK: Steps

    @objc func getTodaySteps(_ call: CAPPluginCall) {
        let now = Date()
        guard CMPedometer.isStepCountingAvailable() else {
            call.resolve([
                "steps": 0,
                "date": localDateString(now),
                "timestamp": millis(now),
                "timestamp_client": isoString(now),
                "available": false,
                "device_id": getOrCreateDeviceId(),
                "platform": "ios",
                "app_version": appVersion(),
                "ml_model_version": DeviceStepCounterPlugin.mlModelVersion,
                "background_running": false,
                "burst_source": "arrival_batched",
                "evidence_source": "ios_coremotion",
                "evidence_hours": NSNull(),
                "install_id": getOrCreateInstallId(),
                "tz_offset_minutes": tzOffsetMinutes(),
                "tz_name": tzName()
            ])
            return
        }
        guard CMPedometer.authorizationStatus() == .authorized else {
            call.reject("Motion & Fitness permission not granted.")
            return
        }

        startLiveUpdatesIfPossible()
        let startOfDay = Calendar.current.startOfDay(for: now)
        pedometer.queryPedometerData(from: startOfDay, to: now) { [weak self] data, error in
            guard let self = self else { return }
            if let error = error {
                call.reject("Could not read steps from Motion & Fitness: \(error.localizedDescription)")
                return
            }
            let steps = max(0, data?.numberOfSteps.intValue ?? 0)
            call.resolve(self.buildReading(steps: steps, now: now))
        }
    }

    private func buildReading(steps: Int, now: Date) -> [String: Any] {
        var sessionId: Any = NSNull()
        var sessionToken: Any = NSNull()
        var sequence = 1
        var stepsDelta = steps
        var cadence = 0
        var burst = 0

        stateQueue.sync {
            if let expiresAt = defaults.string(forKey: DeviceStepCounterPlugin.keySessionExpiresAt), isExpiredIso(expiresAt) {
                clearSessionPrefs()
            }
            if let value = defaults.string(forKey: DeviceStepCounterPlugin.keySessionId) {
                sessionId = value
            }
            if let value = defaults.string(forKey: DeviceStepCounterPlugin.keySessionToken) {
                sessionToken = value
            }
            sequence = max(1, defaults.integer(forKey: DeviceStepCounterPlugin.keySessionNextSequence))
            if defaults.object(forKey: DeviceStepCounterPlugin.keySessionLastTotal) != nil {
                let lastTotal = defaults.integer(forKey: DeviceStepCounterPlugin.keySessionLastTotal)
                stepsDelta = max(0, steps - lastTotal)
            }
            // Reading steps no longer consumes a sequence number: the web layer claims one
            // per upload (claimSequence), so sequence numbers only ever increase.

            trimStepTimes(now)
            let lastMinute = stepTimes.count
            burst = stepTimes.filter { $0 >= now.addingTimeInterval(-5) }.count
            // CoreMotion's own cadence is the better number while it is fresh.
            if now.timeIntervalSince(liveCadenceAt) < 15 && liveCadenceSpm > 0 {
                cadence = Int(liveCadenceSpm.rounded())
            } else {
                cadence = lastMinute
            }
        }

        return [
            "steps": steps,
            "steps_total": steps,
            "steps_delta": stepsDelta,
            "date": localDateString(now),
            "timestamp": millis(now),
            "timestamp_client": isoString(now),
            "available": true,
            "device_id": getOrCreateDeviceId(),
            "platform": "ios",
            "app_version": appVersion(),
            "session_id": sessionId,
            "session_token": sessionToken,
            "sequence_number": sequence,
            "ml_model_version": DeviceStepCounterPlugin.mlModelVersion,
            "cadence_spm": cadence,
            "burst_steps_5s": burst,
            // Android-only GaitAnalyzer / on-device ML features: not available on iOS.
            "gait_available": false,
            "sensor_source": "cmpedometer",
            "gait_state": NSNull(),
            "gait_confidence": NSNull(),
            "gait_dominant_freq_hz": NSNull(),
            "gait_autocorr": NSNull(),
            "gait_interval_std_ms": NSNull(),
            "gait_valid_peaks_2s": NSNull(),
            "gait_gyro_variance": NSNull(),
            "gait_jerk_rms": NSNull(),
            "carry_mode": NSNull(),
            "ml_motion_label": NSNull(),
            "ml_walk_probability": NSNull(),
            "ml_shake_probability": NSNull(),
            "smoothed_walk_probability": NSNull(),
            "smoothed_shake_probability": NSNull(),
            "ml_window_count": NSNull(),
            "ml_confidence_stability": NSNull(),
            "motion_entropy": NSNull(),
            // No foreground service on iOS; CoreMotion records steps while the app is closed.
            "background_running": false,
            // CoreMotion delivers live updates in batches (spread evenly over the elapsed time
            // above), not with one timestamp per step: never "live_timed".
            "burst_source": "arrival_batched",
            // Phase 1b: CoreMotion's own step detection is the evidence; no per-hour gait
            // attribution on iOS yet (the server treats the steps as unanalysed).
            "evidence_source": "ios_coremotion",
            "evidence_hours": NSNull(),
            "install_id": getOrCreateInstallId(),
            "tz_offset_minutes": tzOffsetMinutes(),
            "tz_name": tzName()
        ]
    }

    /// Next sequence number of the active step session (strictly increasing).
    @objc func claimSequence(_ call: CAPPluginCall) {
        let next = stateQueue.sync { () -> Int in
            let value = max(1, defaults.integer(forKey: DeviceStepCounterPlugin.keySessionNextSequence))
            defaults.set(value + 1, forKey: DeviceStepCounterPlugin.keySessionNextSequence)
            return value
        }
        call.resolve(["sequence_number": next])
    }

    /// Per-day totals and 24 hourly buckets for the last `days` days (max 7, what CoreMotion
    /// keeps), so steps taken while the app was closed or offline are caught up on return.
    @objc func getStepHistory(_ call: CAPPluginCall) {
        guard CMPedometer.isStepCountingAvailable(), CMPedometer.authorizationStatus() == .authorized else {
            call.resolve(["days": []])
            return
        }
        let dayCount = min(7, max(1, call.getInt("days") ?? 7))
        let calendar = Calendar.current
        let now = Date()
        let todayStart = calendar.startOfDay(for: now)
        let group = DispatchGroup()
        let lock = NSLock()
        var totals: [String: Int] = [:]
        var hours: [String: [Int]] = [:]

        for offset in 0..<dayCount {
            guard let dayStart = calendar.date(byAdding: .day, value: -offset, to: todayStart) else { continue }
            let key = localDateString(dayStart)
            let dayEnd = min(now, calendar.date(byAdding: .day, value: 1, to: dayStart) ?? now)
            lock.lock()
            totals[key] = 0
            hours[key] = Array(repeating: 0, count: 24)
            lock.unlock()

            group.enter()
            pedometer.queryPedometerData(from: dayStart, to: dayEnd) { data, _ in
                lock.lock()
                totals[key] = max(0, data?.numberOfSteps.intValue ?? 0)
                lock.unlock()
                group.leave()
            }
            for hour in 0..<24 {
                guard let hourStart = calendar.date(byAdding: .hour, value: hour, to: dayStart), hourStart < dayEnd else { break }
                let hourEnd = min(dayEnd, calendar.date(byAdding: .hour, value: 1, to: hourStart) ?? dayEnd)
                group.enter()
                pedometer.queryPedometerData(from: hourStart, to: hourEnd) { data, _ in
                    lock.lock()
                    hours[key]?[hour] = max(0, data?.numberOfSteps.intValue ?? 0)
                    lock.unlock()
                    group.leave()
                }
            }
        }

        group.notify(queue: DispatchQueue.global(qos: .utility)) {
            lock.lock()
            let result: [[String: Any]] = totals.keys.sorted().map { key in
                ["date": key, "steps": totals[key] ?? 0, "hours": hours[key] ?? []]
            }
            lock.unlock()
            call.resolve(["days": result])
        }
    }

    // MARK: "Background capture" (Android foreground service) — iOS equivalents

    @objc func startBackgroundCapture(_ call: CAPPluginCall) {
        guard CMPedometer.authorizationStatus() == .authorized else {
            call.reject("Motion & Fitness permission not granted.")
            return
        }
        defaults.set(true, forKey: DeviceStepCounterPlugin.keyCaptureEnabled)
        startLiveUpdatesIfPossible()
        DispatchQueue.main.async {
            self.updateLocationCapture()
        }
        // iOS keeps counting through CoreMotion; there is no service to run.
        call.resolve(["running": false, "supported": false, "platform": "ios"])
    }

    @objc func stopBackgroundCapture(_ call: CAPPluginCall) {
        defaults.set(false, forKey: DeviceStepCounterPlugin.keyCaptureEnabled)
        DispatchQueue.main.async {
            self.stopLocationCapture()
        }
        call.resolve(["running": false, "supported": false, "platform": "ios"])
    }

    @objc func getBackgroundStatus(_ call: CAPPluginCall) {
        call.resolve(["running": false, "supported": false, "platform": "ios"])
    }

    // MARK: Live pedometer updates (cadence / burst while the app is open)

    private func startLiveUpdatesIfPossible() {
        guard CMPedometer.isStepCountingAvailable(), CMPedometer.authorizationStatus() == .authorized else { return }
        let start = Date()
        let shouldStart = stateQueue.sync { () -> Bool in
            if liveUpdatesRunning { return false }
            liveUpdatesRunning = true
            liveLastTotal = 0
            liveLastAt = start
            return true
        }
        guard shouldStart else { return }
        pedometer.startUpdates(from: start) { [weak self] data, error in
            guard let self = self, let data = data, error == nil else { return }
            self.handleLiveUpdate(data)
        }
    }

    private func stopLiveUpdates() {
        let wasRunning = stateQueue.sync { () -> Bool in
            let running = liveUpdatesRunning
            liveUpdatesRunning = false
            return running
        }
        if wasRunning {
            pedometer.stopUpdates()
        }
    }

    private func handleLiveUpdate(_ data: CMPedometerData) {
        let total = data.numberOfSteps.intValue
        let endDate = data.endDate
        stateQueue.sync {
            guard liveUpdatesRunning else { return }
            let delta = total - liveLastTotal
            if delta > 0 {
                // CoreMotion delivers steps in batches every few seconds; spread them across the
                // elapsed time so a delayed batch doesn't look like an impossible burst.
                let span = max(0.25, endDate.timeIntervalSince(liveLastAt))
                for index in 0..<delta {
                    let offset = span * Double(index + 1) / Double(delta)
                    stepTimes.append(liveLastAt.addingTimeInterval(offset))
                }
                liveLastAt = endDate
            }
            liveLastTotal = max(liveLastTotal, total)
            if let cadence = data.currentCadence?.doubleValue, cadence > 0 {
                liveCadenceSpm = cadence * 60
                liveCadenceAt = Date()
            }
            trimStepTimes(Date())
        }
    }

    /// Call on stateQueue only.
    private func trimStepTimes(_ now: Date) {
        let cutoff = now.addingTimeInterval(-60)
        stepTimes.removeAll { $0 < cutoff }
    }

    // MARK: Route waypoints (foreground only)

    /// Main thread only.
    /// Phase 1b: location is only used inside a walk the user starts (not yet on iOS), so the
    /// automatic route capture is off: this only makes sure no old capture keeps running.
    private func updateLocationCapture() {
        stopLocationCapture()
    }

    /// Main thread only.
    private func stopLocationCapture() {
        guard locationUpdatesRunning else { return }
        locationManager?.stopUpdatingLocation()
        locationUpdatesRunning = false
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        for location in locations {
            enqueueWaypoint(location)
        }
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Transient failures (no fix yet) are expected; keep the request running.
    }

    /// Main thread (CLLocationManager delegate).
    private func enqueueWaypoint(_ location: CLLocation) {
        let accuracy = location.horizontalAccuracy
        if accuracy < 0 || accuracy > DeviceStepCounterPlugin.waypointMaxAccuracyMeters {
            return
        }
        let now = Date()
        var lat = location.coordinate.latitude
        var lng = location.coordinate.longitude

        if let prevLat = lastWaypointLat, let prevLng = lastWaypointLng, let prevAt = lastWaypointAt {
            let jump = CLLocation(latitude: prevLat, longitude: prevLng).distance(from: location)
            if jump < DeviceStepCounterPlugin.waypointMinDistanceMeters {
                return
            }
            let seconds = max(1.0, now.timeIntervalSince(prevAt))
            if jump / seconds > DeviceStepCounterPlugin.waypointMaxSpeedMps {
                return
            }
            // Accuracy-weighted smoothing, same as Android.
            let current = max(1.0, accuracy)
            let baseline = max(1.0, lastWaypointAccuracy)
            let alpha = max(0.2, min(0.75, baseline / (baseline + current)))
            lat = alpha * lat + (1 - alpha) * prevLat
            lng = alpha * lng + (1 - alpha) * prevLng
        }

        let today = localDateString(now)
        let point: [String: Any] = [
            "hour": Calendar.current.component(.hour, from: now),
            "recorded_at": isoString(now),
            "latitude": lat,
            "longitude": lng,
            "accuracy_m": max(0, accuracy)
        ]

        stateQueue.sync {
            var items: [[String: Any]] = []
            if defaults.string(forKey: DeviceStepCounterPlugin.keyWaypointsDate) == today {
                items = readWaypoints()
            }
            items.append(point)
            if items.count > DeviceStepCounterPlugin.maxWaypointsPerDay {
                items = Array(items.suffix(DeviceStepCounterPlugin.maxWaypointsPerDay))
            }
            writeWaypoints(items, date: today)
        }

        lastWaypointLat = lat
        lastWaypointLng = lng
        lastWaypointAt = now
        lastWaypointAccuracy = max(0, accuracy)
    }

    @objc func getPendingWaypoints(_ call: CAPPluginCall) {
        let today = localDateString(Date())
        let result = stateQueue.sync { () -> [String: Any] in
            let date = defaults.string(forKey: DeviceStepCounterPlugin.keyWaypointsDate) ?? today
            let items = readWaypoints().map { item -> [String: Any] in
                [
                    "hour": (item["hour"] as? NSNumber)?.intValue ?? 0,
                    "recorded_at": item["recorded_at"] as? String ?? "",
                    "latitude": (item["latitude"] as? NSNumber)?.doubleValue ?? 0,
                    "longitude": (item["longitude"] as? NSNumber)?.doubleValue ?? 0,
                    "accuracy_m": (item["accuracy_m"] as? NSNumber)?.doubleValue ?? 0
                ]
            }
            return ["date": date, "waypoints": items]
        }
        call.resolve(result)
    }

    /// Without options clears everything; with `date` + `upTo` only drops points recorded at or
    /// before `upTo` (so a point captured between read and clear is kept).
    @objc func clearPendingWaypoints(_ call: CAPPluginCall) {
        let date = call.getString("date")
        let upTo = call.getString("upTo")
        let today = localDateString(Date())
        let remaining = stateQueue.sync { () -> Int in
            let storedDate = defaults.string(forKey: DeviceStepCounterPlugin.keyWaypointsDate) ?? today
            if let upTo = upTo, let date = date {
                guard date == storedDate else { return readWaypoints().count }
                guard let cutoff = parseIso(upTo) else {
                    writeWaypoints([], date: storedDate)
                    return 0
                }
                let kept = readWaypoints().filter { item in
                    guard let recorded = item["recorded_at"] as? String, let at = parseIso(recorded) else { return false }
                    return at > cutoff
                }
                writeWaypoints(kept, date: storedDate)
                return kept.count
            }
            if upTo == nil {
                writeWaypoints([], date: today)
            }
            return 0
        }
        call.resolve(["cleared": true, "remaining": remaining])
    }

    /// Call on stateQueue only.
    private func readWaypoints() -> [[String: Any]] {
        guard let raw = defaults.string(forKey: DeviceStepCounterPlugin.keyWaypointsJson),
              let data = raw.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return []
        }
        return parsed
    }

    /// Call on stateQueue only.
    private func writeWaypoints(_ items: [[String: Any]], date: String) {
        let json: String
        if let data = try? JSONSerialization.data(withJSONObject: items),
           let text = String(data: data, encoding: .utf8) {
            json = text
        } else {
            json = "[]"
        }
        defaults.set(json, forKey: DeviceStepCounterPlugin.keyWaypointsJson)
        defaults.set(date, forKey: DeviceStepCounterPlugin.keyWaypointsDate)
    }

    // MARK: Phase 1b: walks, device integrity, capabilities

    /// User walks need CoreLocation + a background location mode on iOS; not implemented yet,
    /// so the web layer gets a clean "unsupported" and hides the feature.
    @objc func startWalk(_ call: CAPPluginCall) {
        call.resolve(["started": false, "reason": "unsupported", "stepSource": "cmpedometer"])
    }

    private func inactiveWalkState() -> [String: Any] {
        return [
            "active": false,
            "walkId": NSNull(),
            "startedAt": NSNull(),
            "endedAt": NSNull(),
            "elapsedS": 0,
            "steps": 0,
            "distanceM": 0,
            "gaitVerifiedSteps": 0,
            "gaitShakeSteps": 0,
            "gaitUnknownSteps": 0,
            "vehicleSeconds": 0,
            "mockLocation": false,
            "autoEnded": false,
            "gpsStatus": "unavailable",
            "stepSource": "cmpedometer",
            "pointsPending": 0
        ]
    }

    @objc func getWalkState(_ call: CAPPluginCall) {
        call.resolve(inactiveWalkState())
    }

    @objc func takeWalkPoints(_ call: CAPPluginCall) {
        call.resolve(["points": [Any]()])
    }

    @objc func stopWalk(_ call: CAPPluginCall) {
        var state = inactiveWalkState()
        state["points"] = [Any]()
        call.resolve(state)
    }

    /// TODO(Phase 2): App Attest (DCAppAttestService) as the iOS counterpart of Play Integrity.
    @objc func requestIntegrityToken(_ call: CAPPluginCall) {
        call.resolve(["token": NSNull(), "error": "unsupported"])
    }

    private func sensorFlags() -> (counter: Bool, accel: Bool, gyro: Bool, gravity: Bool) {
        let motion = CMMotionManager()
        return (CMPedometer.isStepCountingAvailable(),
                motion.isAccelerometerAvailable,
                motion.isGyroAvailable,
                motion.isDeviceMotionAvailable)
    }

    /// Supplementary heuristics only (shadow signals on the server).
    @objc func getDeviceSignals(_ call: CAPPluginCall) {
        let flags = sensorFlags()
        #if targetEnvironment(simulator)
        let emulator = true
        #else
        let emulator = false
        #endif
        #if DEBUG
        let debuggable = true
        #else
        let debuggable = false
        #endif
        call.resolve([
            "emulator": emulator,
            "rooted": isJailbroken(),
            "debuggable": debuggable,
            "adb_enabled": false,
            "has_step_counter": flags.counter,
            "has_step_detector": flags.counter,
            "has_accelerometer": flags.accel,
            "has_gyroscope": flags.gyro,
            "has_gravity": flags.gravity
        ])
    }

    @objc func getSensorCapabilities(_ call: CAPPluginCall) {
        let flags = sensorFlags()
        call.resolve([
            "hasStepCounter": flags.counter,
            "hasStepDetector": flags.counter,
            "hasAccelerometer": flags.accel,
            "hasGyroscope": flags.gyro,
            "hasGravity": flags.gravity,
            // walks are not implemented on iOS yet (startWalk answers "unsupported")
            "walkSupported": false
        ])
    }

    private func isJailbroken() -> Bool {
        #if targetEnvironment(simulator)
        return false
        #else
        let paths = [
            "/Applications/Cydia.app",
            "/Applications/Sileo.app",
            "/Library/MobileSubstrate/MobileSubstrate.dylib",
            "/bin/bash",
            "/usr/sbin/sshd",
            "/etc/apt",
            "/private/var/lib/apt/",
            "/var/jb"
        ]
        for path in paths where FileManager.default.fileExists(atPath: path) {
            return true
        }
        return false
        #endif
    }

    // MARK: Helpers

    /// Random id of this install (new after a reinstall: app deletion removes UserDefaults).
    private func getOrCreateInstallId() -> String {
        if let stored = defaults.string(forKey: DeviceStepCounterPlugin.keyInstallId), !stored.isEmpty {
            return stored
        }
        let id = UUID().uuidString.lowercased()
        defaults.set(id, forKey: DeviceStepCounterPlugin.keyInstallId)
        return id
    }

    /// Minutes east of UTC right now (EAT = 180).
    private func tzOffsetMinutes() -> Int {
        return TimeZone.current.secondsFromGMT() / 60
    }

    /// IANA name, at most 64 characters.
    private func tzName() -> String {
        return String(TimeZone.current.identifier.prefix(64))
    }

    /// Call on stateQueue only.
    private func clearSessionPrefs() {
        defaults.removeObject(forKey: DeviceStepCounterPlugin.keySessionId)
        defaults.removeObject(forKey: DeviceStepCounterPlugin.keySessionToken)
        defaults.removeObject(forKey: DeviceStepCounterPlugin.keySessionExpiresAt)
        defaults.removeObject(forKey: DeviceStepCounterPlugin.keySessionNextSequence)
        defaults.removeObject(forKey: DeviceStepCounterPlugin.keySessionLastTotal)
    }

    private func getOrCreateDeviceId() -> String {
        if let stored = defaults.string(forKey: DeviceStepCounterPlugin.keyDeviceId), !stored.isEmpty {
            return stored
        }
        let deviceId = UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString
        defaults.set(deviceId, forKey: DeviceStepCounterPlugin.keyDeviceId)
        return deviceId
    }

    private func appVersion() -> String {
        if let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String, !version.isEmpty {
            return version
        }
        return "unknown"
    }

    private func localDateString(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone.current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private func isoString(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: date)
    }

    private func millis(_ date: Date) -> Int64 {
        return Int64((date.timeIntervalSince1970 * 1000).rounded())
    }

    /// Parses server/Android timestamps: "…Z", "…+00:00", with 0–6 fractional digits.
    private func parseIso(_ value: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: value) {
            return date
        }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: value) {
            return date
        }
        // Drop the fractional part (e.g. microseconds) and try again.
        if let range = value.range(of: "\\.[0-9]+", options: .regularExpression) {
            var trimmed = value
            trimmed.removeSubrange(range)
            return plain.date(from: trimmed)
        }
        return nil
    }

    private func isExpiredIso(_ value: String) -> Bool {
        guard let date = parseIso(value) else { return true }
        return date < Date()
    }

    // MARK: Phase 1c: Apple Health (HealthKit)

    @objc func healthSourcesStatus(_ call: CAPPluginCall) {
        HealthKitSources.shared.status { call.resolve($0) }
    }

    /// Opt in and show Apple's own Health access sheet (read only). iOS never tells an app
    /// whether read access was granted: "connected" means the sheet was answered; days
    /// without data simply upload nothing.
    @objc func healthSourcesConnect(_ call: CAPPluginCall) {
        HealthKitSources.shared.requestAccess { _ in
            HealthKitSources.shared.readDays(force: true) { _ in
                HealthKitSources.shared.status { call.resolve($0) }
            }
        }
    }

    /// Reads the last few days (rate-limited unless force) and returns the cached payloads
    /// for the JS layer to upload (POST /api/steps/health-sources/).
    @objc func healthSourcesRead(_ call: CAPPluginCall) {
        let force = call.getBool("force") ?? false
        HealthKitSources.shared.readDays(force: force) { _ in
            HealthKitSources.shared.status { status in
                var result = status
                result["days"] = HealthKitSources.shared.cachedDays()
                call.resolve(result)
            }
        }
    }

    /// iOS has no API to revoke Health access: stop reading and forget what was read; the
    /// user can also turn access off in the Health app (Sharing > Apps > Step2Win).
    @objc func healthSourcesDisconnect(_ call: CAPPluginCall) {
        HealthKitSources.shared.disconnect()
        HealthKitSources.shared.status { call.resolve($0) }
    }

    @objc func healthSourcesInstall(_ call: CAPPluginCall) {
        call.resolve(["opened": false]) // Apple Health is built in
    }

    @objc func healthSourcesOpenSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            // The Health app (Sharing > Apps). Falls back to this app's Settings page.
            if let health = URL(string: "x-apple-health://"), UIApplication.shared.canOpenURL(health) {
                UIApplication.shared.open(health, options: [:]) { ok in call.resolve(["opened": ok]) }
            } else if let settings = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(settings, options: [:]) { ok in call.resolve(["opened": ok]) }
            } else {
                call.resolve(["opened": false])
            }
        }
    }
}

// MARK: - Phase 1c: HealthKit reader

/// Reads steps and workouts other apps and devices wrote to Apple Health, with provenance
/// (source bundle id, device model, HKMetadataKeyWasUserEntered), for the last few days.
/// Read-only and opt-in. The server decides what counts (manual entries and unknown apps
/// never do); nothing here is money logic. Kept in this file so no Xcode project change is
/// needed for a new source file.
///
/// Must be verified in Xcode on a device (not possible on the machine this was written
/// on): the HealthKit capability (+ "Background Delivery"), NSHealthShareUsageDescription,
/// the observer query waking the app, and route reading.
final class HealthKitSources {
    static let shared = HealthKitSources()

    private static let suite = "step2win_health_sources"
    private static let keyOptedIn = "opted_in"
    private static let keyRequested = "auth_requested"
    private static let keyDays = "days_json"
    private static let keyLastRead = "last_read_at"
    private static let keyLastStatus = "last_status"
    private static let maxDays = 3
    private static let foregroundMinInterval: TimeInterval = 120
    private static let maxHourSteps: Double = 14_400

    private let store = HKHealthStore()
    private let defaults = UserDefaults(suiteName: HealthKitSources.suite) ?? UserDefaults.standard
    /// Serial: state and the (blocking) day-read orchestration.
    private let queue = DispatchQueue(label: "com.step2win.app.healthkit")
    /// Query callbacks must never land on `queue` while it waits for them.
    private let callbackQueue = DispatchQueue(label: "com.step2win.app.healthkit.callbacks", attributes: .concurrent)
    private var observer: HKObserverQuery?
    private var reading = false

    var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }
    var optedIn: Bool { defaults.bool(forKey: HealthKitSources.keyOptedIn) }

    private var stepType: HKQuantityType? { HKObjectType.quantityType(forIdentifier: .stepCount) }

    private var readTypes: Set<HKObjectType> {
        var types = Set<HKObjectType>()
        if let steps = stepType { types.insert(steps) }
        if let distance = HKObjectType.quantityType(forIdentifier: .distanceWalkingRunning) { types.insert(distance) }
        types.insert(HKObjectType.workoutType())
        types.insert(HKSeriesType.workoutRoute())
        return types
    }

    func requestAccess(completion: @escaping (Bool) -> Void) {
        guard isAvailable else {
            defaults.set(true, forKey: HealthKitSources.keyOptedIn)
            completion(false)
            return
        }
        defaults.set(true, forKey: HealthKitSources.keyOptedIn)
        store.requestAuthorization(toShare: nil, read: readTypes) { success, _ in
            self.defaults.set(true, forKey: HealthKitSources.keyRequested)
            if success { self.enableBackgroundDelivery() }
            completion(success)
        }
    }

    func disconnect() {
        defaults.set(false, forKey: HealthKitSources.keyOptedIn)
        defaults.removeObject(forKey: HealthKitSources.keyDays)
        queue.async {
            if let q = self.observer {
                self.store.stop(q)
                self.observer = nil
            }
            if let steps = self.stepType { self.store.disableBackgroundDelivery(for: steps) { _, _ in } }
        }
    }

    func startObserverIfOptedIn() {
        guard optedIn, isAvailable, defaults.bool(forKey: HealthKitSources.keyRequested) else { return }
        enableBackgroundDelivery()
    }

    /// HKObserverQuery + background delivery (hourly): a new sample wakes the app, which
    /// reads and caches the days; the JS layer uploads them on the next open. Needs the
    /// "com.apple.developer.healthkit.background-delivery" entitlement.
    private func enableBackgroundDelivery() {
        guard let steps = stepType else { return }
        queue.async {
            if self.observer != nil { return }
            self.store.enableBackgroundDelivery(for: steps, frequency: .hourly) { _, _ in }
            let query = HKObserverQuery(sampleType: steps, predicate: nil) { [weak self] _, completionHandler, error in
                guard let self = self, error == nil, self.optedIn else {
                    completionHandler()
                    return
                }
                self.readDays(force: false) { _ in completionHandler() }
            }
            self.observer = query
            self.store.execute(query)
        }
    }

    func status(completion: @escaping ([String: Any]) -> Void) {
        var out: [String: Any] = [
            "platform": "ios",
            "provider": "healthkit",
            "optedIn": optedIn,
            "availability": isAvailable ? "available" : "unsupported",
            "backgroundSupported": true,
            "lastStatus": defaults.string(forKey: HealthKitSources.keyLastStatus) ?? "",
            "lastReadAt": defaults.string(forKey: HealthKitSources.keyLastRead).map { $0 as Any } ?? NSNull(),
            "lastUploadAt": NSNull()
        ]
        let today = HealthKitSources.dayString(Date())
        let todayPayload = (cachedDays()[today] as? [String: Any]) ?? [:]
        out["todayOrigins"] = HealthKitSources.originPreview(todayPayload)
        out["todaySourceSteps"] = HealthKitSources.sourceSteps(todayPayload)
        guard isAvailable, optedIn else {
            out["state"] = optedIn ? "unavailable" : "off"
            out["permissions"] = ["steps": false, "exercise": false, "routes": false, "background": false]
            completion(out)
            return
        }
        store.getRequestStatusForAuthorization(toShare: [], read: readTypes) { requestStatus, _ in
            // .unnecessary = the user answered the sheet (iOS hides whether reads were allowed).
            let answered = requestStatus == .unnecessary
            out["state"] = answered ? "connected" : "permission_denied"
            out["permissions"] = ["steps": answered, "exercise": answered, "routes": answered, "background": answered]
            completion(out)
        }
    }

    func cachedDays() -> [String: Any] {
        guard let raw = defaults.string(forKey: HealthKitSources.keyDays),
              let data = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return obj
    }

    private func storeDays(_ days: [String: Any]) {
        var merged = cachedDays()
        for (k, v) in days { merged[k] = v }
        let oldest = HealthKitSources.dayString(Calendar.current.date(byAdding: .day, value: -(HealthKitSources.maxDays + 4), to: Date()) ?? Date())
        merged = merged.filter { $0.key >= oldest }
        if let data = try? JSONSerialization.data(withJSONObject: merged), let s = String(data: data, encoding: .utf8) {
            defaults.set(s, forKey: HealthKitSources.keyDays)
        }
    }

    /// Reads today and the previous days (at most every 2 minutes unless forced).
    func readDays(force: Bool, completion: @escaping (String) -> Void) {
        queue.async {
            guard self.optedIn, self.isAvailable, let steps = self.stepType else {
                completion(self.optedIn ? "unsupported" : "off")
                return
            }
            if let last = self.defaults.string(forKey: HealthKitSources.keyLastRead),
               let lastDate = ISO8601DateFormatter().date(from: last),
               !force, Date().timeIntervalSince(lastDate) < HealthKitSources.foregroundMinInterval {
                completion(self.defaults.string(forKey: HealthKitSources.keyLastStatus) ?? "ok")
                return
            }
            if self.reading {
                completion("busy")
                return
            }
            self.reading = true
            let calendar = Calendar.current
            let todayStart = calendar.startOfDay(for: Date())
            let group = DispatchGroup()
            let lock = NSLock()
            var days: [String: Any] = [:]
            for offset in 0..<HealthKitSources.maxDays {
                guard let dayStart = calendar.date(byAdding: .day, value: -offset, to: todayStart),
                      let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) else { continue }
                group.enter()
                self.readDay(steps: steps, start: dayStart, end: dayEnd) { payload in
                    lock.lock()
                    days[HealthKitSources.dayString(dayStart)] = payload
                    lock.unlock()
                    group.leave()
                }
            }
            // A slow or stuck Health store never blocks: whatever arrived in 25 s is kept.
            let finished = group.wait(timeout: .now() + 25) == .success
            lock.lock()
            let snapshot = days
            lock.unlock()
            self.storeDays(snapshot)
            let status = finished ? "ok" : "partial"
            self.defaults.set(status, forKey: HealthKitSources.keyLastStatus)
            self.defaults.set(ISO8601DateFormatter().string(from: Date()), forKey: HealthKitSources.keyLastRead)
            self.reading = false
            completion(status)
        }
    }

    private func readDay(steps: HKQuantityType, start: Date, end: Date, completion: @escaping ([String: Any]) -> Void) {
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [])
        let inner = DispatchGroup()
        var hours: [[String: Any]] = []
        var workouts: [[String: Any]] = []

        inner.enter()
        readHours(steps: steps, predicate: predicate, start: start, end: end) { result in
            hours = result
            inner.leave()
        }
        inner.enter()
        readWorkouts(predicate: predicate) { result in
            workouts = result
            inner.leave()
        }
        inner.notify(queue: callbackQueue) {
            completion([
                "provider": "healthkit",
                "platform": "ios",
                "read_at": ISO8601DateFormatter().string(from: Date()),
                "tz_offset_minutes": TimeZone.current.secondsFromGMT() / 60,
                "hours": hours,
                "workouts": workouts
            ])
        }
    }

    /// Per (local hour, source, device) steps. Apple's per-source statistics (which
    /// de-duplicate one source's overlapping samples) bound the raw sample sums; steps the
    /// user typed in are a separate "manual" entry.
    private func readHours(steps: HKQuantityType, predicate: NSPredicate, start: Date, end: Date,
                           completion: @escaping ([[String: Any]]) -> Void) {
        let sampleQuery = HKSampleQuery(sampleType: steps, predicate: predicate, limit: HKObjectQueryNoLimit,
                                        sortDescriptors: nil) { _, samples, _ in
            // key "hour|source|device|manual" -> steps
            var raw: [String: Double] = [:]
            let calendar = Calendar.current
            for case let sample as HKQuantitySample in samples ?? [] {
                let origin = sample.sourceRevision.source.bundleIdentifier
                if origin == "com.step2win.app" { continue }
                let count = sample.quantity.doubleValue(for: HKUnit.count())
                let manual = HealthKitSources.wasUserEntered(sample.metadata)
                let device = HealthKitSources.deviceType(sample.device)
                // Spread over the hours the sample covers (by time).
                let s = max(sample.startDate, start)
                let e = min(max(sample.endDate, sample.startDate), end)
                let span = sample.endDate.timeIntervalSince(sample.startDate)
                if span <= 0 || e <= s {
                    let hour = calendar.component(.hour, from: s)
                    raw["\(hour)|\(origin)|\(device)|\(manual)", default: 0] += count
                    continue
                }
                var cursor = s
                while cursor < e {
                    guard let hourStart = calendar.dateInterval(of: .hour, for: cursor) else { break }
                    let segEnd = min(e, hourStart.end)
                    let part = count * segEnd.timeIntervalSince(cursor) / span
                    let hour = calendar.component(.hour, from: cursor)
                    raw["\(hour)|\(origin)|\(device)|\(manual)", default: 0] += part
                    cursor = segEnd
                }
            }
            self.sourceTotals(steps: steps, predicate: predicate, start: start, end: end) { totals in
                var out: [[String: Any]] = []
                var manualUsed: [String: Double] = [:]
                for (key, value) in raw.sorted(by: { $0.key < $1.key }) {
                    let parts = key.split(separator: "|", maxSplits: 3).map(String.init)
                    guard parts.count == 4, let hour = Int(parts[0]) else { continue }
                    let origin = parts[1]
                    let isManual = parts[3] == "true"
                    var stepsValue = value
                    if let total = totals["\(hour)|\(origin)"] {
                        if isManual {
                            stepsValue = min(value, total)
                            manualUsed["\(hour)|\(origin)", default: 0] += stepsValue
                        } else {
                            stepsValue = min(value, max(0, total - (raw["\(hour)|\(origin)|\(parts[2])|true"] ?? 0)))
                        }
                    }
                    let rounded = Int(min(HealthKitSources.maxHourSteps, stepsValue.rounded()))
                    if rounded <= 0 { continue }
                    out.append([
                        "hour": hour,
                        "origin": origin,
                        "steps": rounded,
                        "device": parts[2],
                        "method": isManual ? "manual" : "automatic"
                    ])
                }
                completion(out)
            }
        }
        store.execute(sampleQuery)
    }

    /// Apple's own per-source hourly sums ("hour|source" -> steps).
    private func sourceTotals(steps: HKQuantityType, predicate: NSPredicate, start: Date, end: Date,
                              completion: @escaping ([String: Double]) -> Void) {
        let query = HKStatisticsCollectionQuery(quantityType: steps, quantitySamplePredicate: predicate,
                                                options: [.cumulativeSum, .separateBySource],
                                                anchorDate: start, intervalComponents: DateComponents(hour: 1))
        query.initialResultsHandler = { _, collection, _ in
            var totals: [String: Double] = [:]
            let calendar = Calendar.current
            collection?.enumerateStatistics(from: start, to: end) { stats, _ in
                let hour = calendar.component(.hour, from: stats.startDate)
                for source in stats.sources ?? [] {
                    if let sum = stats.sumQuantity(for: source)?.doubleValue(for: HKUnit.count()) {
                        totals["\(hour)|\(source.bundleIdentifier)"] = sum
                    }
                }
            }
            completion(totals)
        }
        store.execute(query)
    }

    private func readWorkouts(predicate: NSPredicate, completion: @escaping ([[String: Any]]) -> Void) {
        let query = HKSampleQuery(sampleType: HKObjectType.workoutType(), predicate: predicate, limit: 20,
                                  sortDescriptors: nil) { _, samples, _ in
            let workouts = (samples ?? []).compactMap { $0 as? HKWorkout }
            if workouts.isEmpty {
                completion([])
                return
            }
            let group = DispatchGroup()
            let lock = NSLock()
            var out: [[String: Any]] = []
            let iso = ISO8601DateFormatter()
            for workout in workouts {
                let origin = workout.sourceRevision.source.bundleIdentifier
                if origin == "com.step2win.app" { continue }
                group.enter()
                self.routeSummary(for: workout) { points, distance in
                    var item: [String: Any] = [
                        "start": iso.string(from: workout.startDate),
                        "end": iso.string(from: workout.endDate),
                        "type": HealthKitSources.workoutType(workout.workoutActivityType),
                        "origin": origin,
                        "device": HealthKitSources.deviceType(workout.device),
                        "method": HealthKitSources.wasUserEntered(workout.metadata) ? "manual" : "active",
                        "steps": NSNull()
                    ]
                    if let meters = workout.totalDistance?.doubleValue(for: HKUnit.meter()) {
                        item["distance_m"] = (meters * 10).rounded() / 10
                    } else {
                        item["distance_m"] = NSNull()
                    }
                    if points > 0 {
                        item["route"] = ["points": points, "distance_m": (distance * 10).rounded() / 10]
                    } else {
                        item["route"] = NSNull()
                    }
                    lock.lock()
                    out.append(item)
                    lock.unlock()
                    group.leave()
                }
            }
            group.notify(queue: self.callbackQueue) { completion(out) }
        }
        store.execute(query)
    }

    /// Point count and distance of a workout's route. The coordinates never leave the phone.
    private func routeSummary(for workout: HKWorkout, completion: @escaping (Int, Double) -> Void) {
        let predicate = HKQuery.predicateForObjects(from: workout)
        let query = HKSampleQuery(sampleType: HKSeriesType.workoutRoute(), predicate: predicate, limit: 1,
                                  sortDescriptors: nil) { _, samples, _ in
            guard let route = samples?.first as? HKWorkoutRoute else {
                completion(0, 0)
                return
            }
            var count = 0
            var distance: Double = 0
            var last: CLLocation?
            var finished = false
            let routeQuery = HKWorkoutRouteQuery(route: route) { _, locations, done, error in
                if finished { return }
                for location in locations ?? [] {
                    if let previous = last { distance += location.distance(from: previous) }
                    last = location
                    count += 1
                }
                if done || error != nil {
                    finished = true
                    completion(error == nil ? count : 0, error == nil ? distance : 0)
                }
            }
            self.store.execute(routeQuery)
        }
        store.execute(query)
    }

    // MARK: helpers (mirrors HealthSourceCore.java)

    static func wasUserEntered(_ metadata: [String: Any]?) -> Bool {
        if let value = metadata?[HKMetadataKeyWasUserEntered] as? Bool { return value }
        if let value = metadata?[HKMetadataKeyWasUserEntered] as? NSNumber { return value.boolValue }
        return false
    }

    static func deviceType(_ device: HKDevice?) -> String {
        let model = (device?.model ?? device?.name ?? "").lowercased()
        if model.contains("watch") { return "watch" }
        if model.contains("iphone") { return "phone" }
        if model.contains("ring") { return "ring" }
        if model.contains("band") || model.contains("fitbit") || model.contains("tracker") { return "band" }
        return "unknown"
    }

    static func workoutType(_ type: HKWorkoutActivityType) -> String {
        switch type {
        case .walking: return "walking"
        case .running: return "running"
        case .hiking: return "hiking"
        case .wheelchairWalkPace, .wheelchairRunPace: return "wheelchair"
        default: return "other"
        }
    }

    static func dayString(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone.current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    static func originPreview(_ payload: [String: Any]) -> [[String: Any]] {
        var counted: [String: Int] = [:]
        var manual: [String: Int] = [:]
        var devices: [String: String] = [:]
        for entry in (payload["hours"] as? [[String: Any]]) ?? [] {
            guard let origin = entry["origin"] as? String else { continue }
            let steps = (entry["steps"] as? Int) ?? 0
            if (entry["method"] as? String) == "manual" {
                manual[origin, default: 0] += steps
            } else {
                counted[origin, default: 0] += steps
            }
            if devices[origin] == nil || devices[origin] == "phone" { devices[origin] = entry["device"] as? String }
        }
        let origins = Set(counted.keys).union(manual.keys).sorted()
        return origins.map { ["origin": $0, "steps": counted[$0] ?? 0, "manual_steps": manual[$0] ?? 0, "device": devices[$0] ?? "unknown"] }
    }

    /// Per hour the max over sources (never the sum), summed over the day.
    static func sourceSteps(_ payload: [String: Any]) -> Int {
        var perHour: [Int: Int] = [:]
        for entry in (payload["hours"] as? [[String: Any]]) ?? [] {
            if (entry["method"] as? String) == "manual" { continue }
            guard let hour = entry["hour"] as? Int, let steps = entry["steps"] as? Int else { continue }
            perHour[hour] = max(perHour[hour] ?? 0, steps)
        }
        return perHour.values.reduce(0, +)
    }
}
