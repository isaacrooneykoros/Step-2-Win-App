package com.step2win.app;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

public class GaitAnalyzer {
    private static final long WINDOW_MS = 3_000L;
    private static final long BUFFER_MS = 6_000L;
    private static final long EVAL_INTERVAL_MS = 500L;
    private static final long MIN_STEP_INTERVAL_MS = 300L;
    private static final long MAX_STEP_INTERVAL_MS = 1_200L;

    private final ArrayDeque<MotionSample> samples = new ArrayDeque<>();
    private final ArrayDeque<PeakCandidate> candidates = new ArrayDeque<>();
    private final ArrayDeque<Long> confirmedPeaks = new ArrayDeque<>();

    private long lastSampleTsMs = -1L;
    private long lastEvalTsMs = 0L;
    private long lastCandidateTsMs = -1L;
    private double lastDominantFreqHz = 0.0;
    private double prevConfidence = 0.0;
    private int mlWindowCount = 0;
    private int walkingStableWindowCount = 0;
    private int shakingStableWindowCount = 0;
    private double smoothedWalkProbability = 0.0;
    private double smoothedShakeProbability = 0.0;

    private float prevRawVertical = 0f;
    private float prevHighPass = 0f;
    private float prevBandPassed = 0f;

    private float prev1 = 0f;
    private float prev2 = 0f;
    private long prev1Ts = 0L;
    private long prev2Ts = 0L;
    private boolean primed = false;

    private MotionState state = MotionState.IDLE;
    private Snapshot snapshot = Snapshot.initial();

    public synchronized void addSample(
        long timestampMs,
        float linearX,
        float linearY,
        float linearZ,
        float gravityX,
        float gravityY,
        float gravityZ,
        float gyroMagnitude
    ) {
        if (timestampMs <= 0L) {
            return;
        }

        float gravityNorm = (float) Math.sqrt(gravityX * gravityX + gravityY * gravityY + gravityZ * gravityZ);
        if (gravityNorm < 0.0001f) {
            return;
        }

        float gx = gravityX / gravityNorm;
        float gy = gravityY / gravityNorm;
        float gz = gravityZ / gravityNorm;
        float rawVertical = linearX * gx + linearY * gy + linearZ * gz;

        float dt = lastSampleTsMs > 0L
            ? Math.max(0.005f, Math.min(0.08f, (timestampMs - lastSampleTsMs) / 1000f))
            : 0.02f;
        lastSampleTsMs = timestampMs;

        // Approximate 0.8-3.0 Hz band-pass using 1st-order high-pass then low-pass.
        float hpTau = 1f / (2f * (float) Math.PI * 0.8f);
        float hpAlpha = hpTau / (hpTau + dt);
        float highPassed = hpAlpha * (prevHighPass + rawVertical - prevRawVertical);
        prevRawVertical = rawVertical;
        prevHighPass = highPassed;

        float lpTau = 1f / (2f * (float) Math.PI * 3.0f);
        float lpAlpha = dt / (lpTau + dt);
        float bandPassed = prevBandPassed + lpAlpha * (highPassed - prevBandPassed);
        prevBandPassed = bandPassed;

        float jerk = dt > 0f ? Math.abs((bandPassed - prev1) / dt) : 0f;

        samples.addLast(new MotionSample(timestampMs, bandPassed, gyroMagnitude, jerk));
        trimOldSamples(timestampMs);
        detectCandidatePeak(timestampMs, bandPassed);

        if (timestampMs - lastEvalTsMs >= EVAL_INTERVAL_MS) {
            evaluateWindow(timestampMs);
            lastEvalTsMs = timestampMs;
        }
    }

    public synchronized Snapshot getSnapshot() {
        return snapshot;
    }

    private void detectCandidatePeak(long tsMs, float value) {
        if (!primed) {
            prev2 = prev1;
            prev2Ts = prev1Ts;
            prev1 = value;
            prev1Ts = tsMs;
            if (prev2Ts != 0L) {
                primed = true;
            }
            return;
        }

        float threshold = dynamicThreshold();
        boolean isLocalMax = prev1 > prev2 && prev1 > value;
        if (isLocalMax && prev1 > threshold) {
            long intervalMs = lastCandidateTsMs > 0L ? (prev1Ts - lastCandidateTsMs) : 0L;
            if (lastCandidateTsMs <= 0L || (intervalMs >= MIN_STEP_INTERVAL_MS && intervalMs <= MAX_STEP_INTERVAL_MS)) {
                candidates.addLast(new PeakCandidate(prev1Ts, prev1));
                lastCandidateTsMs = prev1Ts;
            }
        }

        prev2 = prev1;
        prev2Ts = prev1Ts;
        prev1 = value;
        prev1Ts = tsMs;
    }

    private float dynamicThreshold() {
        if (samples.isEmpty()) {
            return 0.15f;
        }

        long now = samples.peekLast().timestampMs;
        long cutoff = now - 2_000L;
        int n = 0;
        double mean = 0.0;
        double m2 = 0.0;
        for (MotionSample s : samples) {
            if (s.timestampMs < cutoff) {
                continue;
            }
            n++;
            double delta = s.vertical - mean;
            mean += delta / n;
            m2 += delta * (s.vertical - mean);
        }

        if (n < 8) {
            return 0.18f;
        }

        double variance = m2 / Math.max(1, n - 1);
        double std = Math.sqrt(Math.max(0.0, variance));
        return (float) Math.max(0.12, mean + 0.85 * std);
    }

    private void evaluateWindow(long nowMs) {
        List<MotionSample> window = getWindowSamples(nowMs - WINDOW_MS);
        if (window.size() < 24) {
            snapshot = Snapshot.idle(state);
            return;
        }

        List<Long> peakTs = getCandidateTimestamps(nowMs - WINDOW_MS);
        List<Long> intervals = computeIntervals(peakTs);
        double intervalStdMs = stdDevMs(intervals);
        double dominantFreqHz = dominantFrequency(window);
        double autocorr = autocorrelation(window);
        double gyroVar = varianceGyro(window);
        double jerkRms = rmsJerk(window);
        int validPeaks2s = countPeaksSince(nowMs - 2_000L);
        double peakToPeak = peakToPeakAmplitude(window);
        int candidateCadenceSpm = (int) Math.round((peakTs.size() * 60_000.0) / WINDOW_MS);
        double entropy = motionEntropy(window);

        String carryMode = inferCarryMode(gyroVar);
        boolean cadencePlausible = dominantFreqHz >= 0.8 && dominantFreqHz <= 3.0;
        boolean intervalStable = intervalStdMs > 0 && intervalStdMs <= 150;
        boolean periodic = autocorr >= 0.45;
        boolean enoughPeaks = peakTs.size() >= 4;
        boolean gyroNotChaotic = gyroVar <= 3.0;

        int score = 0;
        if (dominantFreqHz >= 1.2 && dominantFreqHz <= 2.5) {
            score += 2;
        }
        if (autocorr > 0.60) {
            score += 2;
        }
        if (intervalStdMs > 0 && intervalStdMs < 120.0) {
            score += 2;
        }
        if (peakAmplitudePlausible(window)) {
            score += 1;
        }
        if (gyroVar >= 0.02 && gyroVar <= 1.2) {
            score += 1;
        }
        if (jerkRms > 16.0) {
            score -= 2;
        }
        if (gyroVar > 2.8) {
            score -= 2;
        }
        if (Math.abs(lastDominantFreqHz - dominantFreqHz) > 0.8 && lastDominantFreqHz > 0.1) {
            score -= 1;
        }
        lastDominantFreqHz = dominantFreqHz;

        MlPrediction ml = MotionClassifier.predict(
            dominantFreqHz,
            autocorr,
            intervalStdMs,
            gyroVar,
            jerkRms,
            peakToPeak,
            candidateCadenceSpm,
            validPeaks2s,
            state
        );

        mlWindowCount += 1;
        smoothedWalkProbability = 0.7 * smoothedWalkProbability + 0.3 * ml.walkProbability;
        smoothedShakeProbability = 0.7 * smoothedShakeProbability + 0.3 * ml.shakeProbability;
        double confidenceStability = 1.0;

        if (ml.shakeProbability >= 0.78 && candidateCadenceSpm > 40) {
            score -= 3;
        }
        if (ml.walkProbability >= 0.70 && cadencePlausible) {
            score += 2;
        }

        if (ml.walkProbability >= 0.65 && cadencePlausible && periodic) {
            walkingStableWindowCount += 1;
        } else {
            walkingStableWindowCount = 0;
        }

        if (ml.shakeProbability >= 0.65 || entropy >= 1.2) {
            shakingStableWindowCount += 1;
        } else {
            shakingStableWindowCount = 0;
        }

        boolean validWindow = enoughPeaks && cadencePlausible && intervalStable && periodic && gyroNotChaotic;
        updateState(validWindow, peakTs.size(), score);

        if (ml.shakeProbability >= 0.80 && state == MotionState.CONFIRMED_WALKING) {
            state = MotionState.SUSPICIOUS_MOTION;
        }

        if (walkingStableWindowCount < 3 && state == MotionState.CONFIRMED_WALKING) {
            confidenceStability = Math.min(confidenceStability, 0.75);
        }

        if (shakingStableWindowCount >= 3) {
            state = MotionState.SUSPICIOUS_MOTION;
        }

        if (state == MotionState.CONFIRMED_WALKING) {
            for (Long ts : peakTs) {
                if (confirmedPeaks.isEmpty() || ts > confirmedPeaks.peekLast()) {
                    confirmedPeaks.addLast(ts);
                }
            }
        }

        trimOldPeaks(nowMs);
        int confirmedBurst5s = countConfirmedPeaksSince(nowMs - 5_000L);
        int cadenceSpm = countConfirmedPeaksSince(nowMs - 60_000L);
        int confidence = Math.max(0, Math.min(100, score * 12 + (validWindow ? 18 : 0)));
        confidenceStability = mlWindowCount <= 1
            ? 1.0
            : clamp(1.0 - (Math.abs(confidence - prevConfidence) / 100.0), 0.0, 1.0);
        if (walkingStableWindowCount < 3 && state == MotionState.CONFIRMED_WALKING) {
            confidenceStability = Math.min(confidenceStability, 0.75);
        }
        prevConfidence = confidence;

        snapshot = new Snapshot(
            state.apiValue,
            confidence,
            dominantFreqHz,
            autocorr,
            intervalStdMs,
            validPeaks2s,
            gyroVar,
            jerkRms,
            carryMode,
            cadenceSpm,
            confirmedBurst5s,
            ml.label,
            ml.walkProbability,
            ml.shakeProbability,
            MotionClassifier.MODEL_VERSION,
            smoothedWalkProbability,
            smoothedShakeProbability,
            mlWindowCount,
            confidenceStability,
            entropy
        );
    }

    private void updateState(boolean validWindow, int peaksInWindow, int score) {
        if (state == MotionState.IDLE) {
            if (peaksInWindow >= 2) {
                state = MotionState.POSSIBLE_WALKING;
            }
            return;
        }

        if (state == MotionState.POSSIBLE_WALKING) {
            if (validWindow && score >= 5) {
                state = MotionState.CONFIRMED_WALKING;
            } else if (peaksInWindow < 2) {
                state = MotionState.IDLE;
            }
            return;
        }

        if (state == MotionState.CONFIRMED_WALKING) {
            if (!validWindow || score < 3) {
                state = MotionState.SUSPICIOUS_MOTION;
            }
            return;
        }

        if (state == MotionState.SUSPICIOUS_MOTION) {
            if (validWindow && score >= 5) {
                state = MotionState.CONFIRMED_WALKING;
            } else if (peaksInWindow < 2) {
                state = MotionState.IDLE;
            }
        }
    }

    private static double motionEntropy(List<MotionSample> window) {
        if (window.isEmpty()) {
            return 0.0;
        }

        double[] bins = new double[5];
        double total = 0.0;
        for (MotionSample sample : window) {
            double value = Math.abs(sample.vertical);
            int index = (int) Math.min(4, Math.floor(value * 2.0));
            bins[index] += 1.0;
            total += 1.0;
        }

        double entropy = 0.0;
        for (double bin : bins) {
            if (bin <= 0.0) {
                continue;
            }
            double probability = bin / total;
            entropy -= probability * Math.log(probability);
        }

        return entropy / Math.log(5.0);
    }

    private static double clamp(double value, double min, double max) {
        return Math.max(min, Math.min(max, value));
    }

    private void trimOldSamples(long nowMs) {
        long cutoff = nowMs - BUFFER_MS;
        while (!samples.isEmpty() && samples.peekFirst().timestampMs < cutoff) {
            samples.pollFirst();
        }

        while (!candidates.isEmpty() && candidates.peekFirst().timestampMs < cutoff) {
            candidates.pollFirst();
        }
    }

    private void trimOldPeaks(long nowMs) {
        long cutoff = nowMs - 60_000L;
        while (!confirmedPeaks.isEmpty() && confirmedPeaks.peekFirst() < cutoff) {
            confirmedPeaks.pollFirst();
        }
    }

    private List<MotionSample> getWindowSamples(long cutoffTs) {
        List<MotionSample> out = new ArrayList<>();
        for (MotionSample sample : samples) {
            if (sample.timestampMs >= cutoffTs) {
                out.add(sample);
            }
        }
        return out;
    }

    private List<Long> getCandidateTimestamps(long cutoffTs) {
        List<Long> out = new ArrayList<>();
        for (PeakCandidate p : candidates) {
            if (p.timestampMs >= cutoffTs) {
                out.add(p.timestampMs);
            }
        }
        return out;
    }

    private int countPeaksSince(long cutoffTs) {
        int count = 0;
        for (PeakCandidate peak : candidates) {
            if (peak.timestampMs >= cutoffTs) {
                count++;
            }
        }
        return count;
    }

    private int countConfirmedPeaksSince(long cutoffTs) {
        int count = 0;
        for (Long ts : confirmedPeaks) {
            if (ts >= cutoffTs) {
                count++;
            }
        }
        return count;
    }

    private static List<Long> computeIntervals(List<Long> timestamps) {
        List<Long> intervals = new ArrayList<>();
        for (int i = 1; i < timestamps.size(); i++) {
            long interval = timestamps.get(i) - timestamps.get(i - 1);
            if (interval >= MIN_STEP_INTERVAL_MS && interval <= MAX_STEP_INTERVAL_MS) {
                intervals.add(interval);
            }
        }
        return intervals;
    }

    private static double stdDevMs(List<Long> intervals) {
        if (intervals.size() < 2) {
            return 0.0;
        }
        double mean = 0.0;
        for (Long value : intervals) {
            mean += value;
        }
        mean /= intervals.size();
        double variance = 0.0;
        for (Long value : intervals) {
            double d = value - mean;
            variance += d * d;
        }
        variance /= Math.max(1, intervals.size() - 1);
        return Math.sqrt(variance);
    }

    private static double dominantFrequency(List<MotionSample> window) {
        int n = window.size();
        if (n < 16) {
            return 0.0;
        }

        double durationSec = (window.get(n - 1).timestampMs - window.get(0).timestampMs) / 1000.0;
        if (durationSec <= 0.4) {
            return 0.0;
        }
        double sampleRate = (n - 1) / durationSec;

        double bestFreq = 0.0;
        double bestEnergy = -1.0;
        for (double freq = 0.8; freq <= 3.0; freq += 0.05) {
            double re = 0.0;
            double im = 0.0;
            for (int i = 0; i < n; i++) {
                double angle = 2.0 * Math.PI * freq * i / sampleRate;
                re += window.get(i).vertical * Math.cos(angle);
                im -= window.get(i).vertical * Math.sin(angle);
            }
            double energy = re * re + im * im;
            if (energy > bestEnergy) {
                bestEnergy = energy;
                bestFreq = freq;
            }
        }
        return bestFreq;
    }

    private static double autocorrelation(List<MotionSample> window) {
        int n = window.size();
        if (n < 24) {
            return 0.0;
        }

        double mean = 0.0;
        for (MotionSample sample : window) {
            mean += sample.vertical;
        }
        mean /= n;

        double var = 0.0;
        for (MotionSample sample : window) {
            double d = sample.vertical - mean;
            var += d * d;
        }
        if (var <= 1e-6) {
            return 0.0;
        }

        double durationSec = (window.get(n - 1).timestampMs - window.get(0).timestampMs) / 1000.0;
        if (durationSec <= 0.5) {
            return 0.0;
        }
        double sampleRate = (n - 1) / durationSec;

        int minLag = Math.max(1, (int) Math.round(sampleRate / 3.0));
        int maxLag = Math.max(minLag + 1, (int) Math.round(sampleRate / 0.8));
        maxLag = Math.min(maxLag, n - 3);

        double best = 0.0;
        for (int lag = minLag; lag <= maxLag; lag++) {
            double sum = 0.0;
            for (int i = lag; i < n; i++) {
                sum += (window.get(i).vertical - mean) * (window.get(i - lag).vertical - mean);
            }
            double score = sum / var;
            if (score > best) {
                best = score;
            }
        }
        return Math.max(0.0, Math.min(1.0, best));
    }

    private static double varianceGyro(List<MotionSample> window) {
        if (window.size() < 2) {
            return 0.0;
        }
        double mean = 0.0;
        for (MotionSample sample : window) {
            mean += sample.gyro;
        }
        mean /= window.size();

        double variance = 0.0;
        for (MotionSample sample : window) {
            double d = sample.gyro - mean;
            variance += d * d;
        }
        return variance / Math.max(1, window.size() - 1);
    }

    private static double rmsJerk(List<MotionSample> window) {
        if (window.isEmpty()) {
            return 0.0;
        }
        double sumSq = 0.0;
        for (MotionSample sample : window) {
            sumSq += sample.jerk * sample.jerk;
        }
        return Math.sqrt(sumSq / window.size());
    }

    private static boolean peakAmplitudePlausible(List<MotionSample> window) {
        double amplitude = peakToPeakAmplitude(window);
        return amplitude >= 0.25 && amplitude <= 6.0;
    }

    private static double peakToPeakAmplitude(List<MotionSample> window) {
        float min = Float.MAX_VALUE;
        float max = -Float.MAX_VALUE;
        for (MotionSample sample : window) {
            min = Math.min(min, sample.vertical);
            max = Math.max(max, sample.vertical);
        }
        return Math.abs(max - min);
    }

    private static String inferCarryMode(double gyroVariance) {
        if (gyroVariance < 0.12) {
            return "pocket";
        }
        if (gyroVariance < 0.8) {
            return "in_hand";
        }
        return "bag";
    }

    private enum MotionState {
        IDLE("idle"),
        POSSIBLE_WALKING("possible_walking"),
        CONFIRMED_WALKING("confirmed_walking"),
        SUSPICIOUS_MOTION("suspicious_motion");

        final String apiValue;

        MotionState(String apiValue) {
            this.apiValue = apiValue;
        }
    }

    private static final class MotionSample {
        final long timestampMs;
        final float vertical;
        final float gyro;
        final float jerk;

        MotionSample(long timestampMs, float vertical, float gyro, float jerk) {
            this.timestampMs = timestampMs;
            this.vertical = vertical;
            this.gyro = gyro;
            this.jerk = jerk;
        }
    }

    private static final class PeakCandidate {
        final long timestampMs;
        final float amplitude;

        PeakCandidate(long timestampMs, float amplitude) {
            this.timestampMs = timestampMs;
            this.amplitude = amplitude;
        }
    }

    private static final class MlPrediction {
        final String label;
        final double walkProbability;
        final double shakeProbability;

        MlPrediction(String label, double walkProbability, double shakeProbability) {
            this.label = label;
            this.walkProbability = walkProbability;
            this.shakeProbability = shakeProbability;
        }
    }

    private static final class MotionClassifier {
        static final String MODEL_VERSION = "shakewalk-logreg-v1";

        static MlPrediction predict(
            double dominantFreqHz,
            double autocorr,
            double intervalStdMs,
            double gyroVariance,
            double jerkRms,
            double peakToPeakAmplitude,
            int candidateCadenceSpm,
            int validPeaks2s,
            MotionState currentState
        ) {
            // Lightweight logistic model for on-device shake-vs-walk discrimination.
            double freqBandScore = clamp(1.0 - Math.abs(dominantFreqHz - 1.8) / 1.6, 0.0, 1.0);
            double periodicity = clamp(autocorr, 0.0, 1.0);
            double intervalStability = intervalStdMs > 0
                ? clamp(1.0 - (intervalStdMs / 320.0), 0.0, 1.0)
                : 0.0;
            double cadenceNorm = clamp(candidateCadenceSpm / 180.0, 0.0, 1.2);
            double peaksNorm = clamp(validPeaks2s / 6.0, 0.0, 1.0);
            double gyroChaos = clamp(gyroVariance / 3.0, 0.0, 2.0);
            double jerkChaos = clamp(jerkRms / 24.0, 0.0, 2.0);
            double amplitudeNorm = clamp(peakToPeakAmplitude / 5.0, 0.0, 2.0);
            double stateWalkBoost = currentState == MotionState.CONFIRMED_WALKING ? 1.0 : 0.0;

            double walkLogit =
                -1.10
                + 2.40 * freqBandScore
                + 2.10 * periodicity
                + 1.70 * intervalStability
                + 0.95 * cadenceNorm
                + 0.65 * peaksNorm
                + 0.40 * stateWalkBoost
                - 1.35 * gyroChaos
                - 1.20 * jerkChaos
                - 0.40 * amplitudeNorm;

            double shakeLogit =
                -1.35
                - 1.30 * freqBandScore
                - 1.40 * periodicity
                - 1.00 * intervalStability
                + 1.55 * gyroChaos
                + 1.60 * jerkChaos
                + 0.85 * amplitudeNorm
                + 0.40 * (candidateCadenceSpm > 190 ? 1.0 : 0.0);

            double walkExp = Math.exp(Math.max(-20.0, Math.min(20.0, walkLogit)));
            double shakeExp = Math.exp(Math.max(-20.0, Math.min(20.0, shakeLogit)));
            double otherExp = 1.0;
            double denom = walkExp + shakeExp + otherExp;

            double walkProb = walkExp / denom;
            double shakeProb = shakeExp / denom;
            double otherProb = otherExp / denom;

            String label = "other";
            if (walkProb >= shakeProb && walkProb >= otherProb) {
                label = "walk";
            } else if (shakeProb >= walkProb && shakeProb >= otherProb) {
                label = "shake";
            }

            return new MlPrediction(label, walkProb, shakeProb);
        }

        private static double clamp(double value, double min, double max) {
            return Math.max(min, Math.min(max, value));
        }
    }

    public static final class Snapshot {
        public final String gaitState;
        public final int confidence;
        public final double dominantFreqHz;
        public final double autocorr;
        public final double intervalStdMs;
        public final int validPeaks2s;
        public final double gyroVariance;
        public final double jerkRms;
        public final String carryMode;
        public final int validatedCadenceSpm;
        public final int validatedBurst5s;
        public final String mlMotionLabel;
        public final double mlWalkProbability;
        public final double mlShakeProbability;
        public final String mlModelVersion;
        public final double smoothedWalkProbability;
        public final double smoothedShakeProbability;
        public final int mlWindowCount;
        public final double mlConfidenceStability;
        public final double motionEntropy;

        Snapshot(
            String gaitState,
            int confidence,
            double dominantFreqHz,
            double autocorr,
            double intervalStdMs,
            int validPeaks2s,
            double gyroVariance,
            double jerkRms,
            String carryMode,
            int validatedCadenceSpm,
            int validatedBurst5s,
            String mlMotionLabel,
            double mlWalkProbability,
            double mlShakeProbability,
            String mlModelVersion,
            double smoothedWalkProbability,
            double smoothedShakeProbability,
            int mlWindowCount,
            double mlConfidenceStability,
            double motionEntropy
        ) {
            this.gaitState = gaitState;
            this.confidence = confidence;
            this.dominantFreqHz = dominantFreqHz;
            this.autocorr = autocorr;
            this.intervalStdMs = intervalStdMs;
            this.validPeaks2s = validPeaks2s;
            this.gyroVariance = gyroVariance;
            this.jerkRms = jerkRms;
            this.carryMode = carryMode;
            this.validatedCadenceSpm = validatedCadenceSpm;
            this.validatedBurst5s = validatedBurst5s;
            this.mlMotionLabel = mlMotionLabel;
            this.mlWalkProbability = mlWalkProbability;
            this.mlShakeProbability = mlShakeProbability;
            this.mlModelVersion = mlModelVersion;
                this.smoothedWalkProbability = smoothedWalkProbability;
                this.smoothedShakeProbability = smoothedShakeProbability;
                this.mlWindowCount = mlWindowCount;
                this.mlConfidenceStability = mlConfidenceStability;
                this.motionEntropy = motionEntropy;
        }

        static Snapshot initial() {
                return new Snapshot("idle", 0, 0.0, 0.0, 0.0, 0, 0.0, 0.0, "unknown", 0, 0, "other", 0.0, 0.0, MotionClassifier.MODEL_VERSION, 0.0, 0.0, 0, 0.0, 0.0);
        }

        static Snapshot idle(MotionState state) {
                return new Snapshot(state.apiValue, 0, 0.0, 0.0, 0.0, 0, 0.0, 0.0, "unknown", 0, 0, "other", 0.0, 0.0, MotionClassifier.MODEL_VERSION, 0.0, 0.0, 0, 0.0, 0.0);
        }
    }
}