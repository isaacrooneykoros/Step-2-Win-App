import Foundation
import UIKit
import CoreMotion
import CoreLocation
import Capacitor

/// iOS implementation of the 'DeviceStepCounter' plugin (Android: DeviceStepCounterPlugin.java).
///
/// Steps come from CoreMotion's CMPedometer:
/// - getTodaySteps() queries the pedometer history from local midnight to now. iOS records steps
///   in the background by itself (the motion co-processor keeps ~7 days), so there is no
///   foreground service on iOS: every launch/resume simply reads the history since midnight.
/// - While the app is active, live pedometer updates feed cadence and 5-second burst numbers.
///
/// Android-only data (GaitAnalyzer / on-device ML features, foreground service, exact alarms,
/// background location) does not exist here. Those fields are returned as NSNull (JS null) and
/// flagged with `gait_available: false` / `sensor_source: "cmpedometer"` so the JS layer can
/// send nulls to the backend instead of zeros.
///
/// Route waypoints: recorded only while the app is open and location is allowed "While Using the
/// App" (no background location mode on iOS). Same filters and storage format as Android.
@objc(DeviceStepCounterPlugin)
public class DeviceStepCounterPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "DeviceStepCounterPlugin"
    public let jsName = "DeviceStepCounter"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkAdvancedPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestLocationPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestBackgroundLocationPermission", returnType: CAPPluginReturnPromise),
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
        CAPPluginMethod(name: "getStepHistory", returnType: CAPPluginReturnPromise)
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
                // No background route tracking on iOS (no background location mode).
                "backgroundLocation": "unavailable",
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

    @objc func requestBackgroundLocationPermission(_ call: CAPPluginCall) {
        call.resolve(["backgroundLocation": "unavailable", "platform": "ios"])
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
                "background_running": false
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
            "background_running": false
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
    private func updateLocationCapture() {
        guard let manager = locationManager else { return }
        let status = manager.authorizationStatus
        let allowed = status == .authorizedWhenInUse || status == .authorizedAlways
        let enabled = defaults.bool(forKey: DeviceStepCounterPlugin.keyCaptureEnabled)
        let active = UIApplication.shared.applicationState == .active
        if allowed && enabled && active {
            if !locationUpdatesRunning {
                manager.startUpdatingLocation()
                locationUpdatesRunning = true
            }
        } else {
            stopLocationCapture()
        }
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

    // MARK: Helpers

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
}
